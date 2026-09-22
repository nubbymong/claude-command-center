// Layer 4 of the managed-launch hardening: the visible preflight.
//
// READ THIS BEFORE TRUSTING ANYTHING HERE. The preflight is a DIAGNOSTIC, not
// the security boundary, and a clean result does NOT mean a session is
// isolated. It reports what is locally observable at the moment a launch is
// composed. The sources that matter most are not locally observable:
//
//   - remote / organizationally managed settings, which the CLI fetches from
//     the server for a signed-in account;
//   - settings changed AFTER the process started;
//   - anything a future CLI version reads that this version does not.
//
// The boundary is the host control itself -- applied last by
// applyRealmEnvPatch, refused to providers, and proven to fail closed. What
// this module adds is that a MISSING control becomes loud instead of silent,
// and that the user can see what the sanitiser took out of their settings copy.
import fs from 'node:fs'
import path from 'node:path'
import { logInfo, logWarn } from './debug-logger'
import { managedLaunchPreflightFor, authoritySettingsKeysFor } from './providers'
import { peekClaudeCliVersion, ensureClaudeCliVersion } from './claude-cli-version'
// From the shared state module, NOT from account-profiles: the choke point in
// account-profiles calls this recorder, so importing back would make the launch
// path and its own diagnostics a cycle (see ./managed-launch-state.ts).
import { lastSettingsSanitiseFor, lastAmbientStripFor } from './managed-launch-state'
import { boundNames } from '../shared/providers'
import type { ManagedLaunchPreflight, ManagedLaunchPreflightInput, ProjectScanSkipReason } from '../shared/providers'

/** A launch the USER started, or a PROBE this app ran by itself.
 *
 *  They are not interchangeable on the panel. `readClaudeCliAuth` runs a real
 *  managed launch -- it gets the full hardening, and its report is worth having
 *  in the log -- but it fires on every Accounts row mount, every auth-method
 *  toggle and every session right-click. Treating it as the newest launch meant
 *  OPENING the Accounts panel replaced the report the panel was about to show
 *  with the probe's, displacing exactly the project-settings finding this round
 *  added (adversarial review, MAJOR). */
export type { ManagedLaunchKind } from '../shared/providers'
import type { ManagedLaunchKind } from '../shared/providers'

/** The internal record. `home` is an ABSOLUTE path and therefore carries the OS
 *  username, so it stays in the main process and never reaches the wire.
 *  `input` is kept so the project scan can re-run the preflight rather than
 *  assemble a second, hand-built verdict. */
interface StoredReport {
  home: string
  profileId: string
  sessionId: string
  kind: ManagedLaunchKind
  at: number
  /** Monotonic record order. `at` has millisecond resolution, so two launches
   *  in the same tick cannot be ordered by it -- and "newest first" is what the
   *  panel answers with. */
  seq: number
  preflight: ManagedLaunchPreflight
  input: ManagedLaunchPreflightInput
}

/** What a renderer receives: scoped to ONE profile, with no absolute path. */
export interface ManagedLaunchReport {
  profileId: string
  sessionId: string
  kind: ManagedLaunchKind
  at: number
  preflight: ManagedLaunchPreflight
}

/** Bounded so a long-running app cannot accumulate one entry per session for
 *  the life of the process. The newest are the ones anybody looks at.
 *
 *  TWO rings, and that is the point. One shared ring meant probes evicted
 *  launches: this app runs an auth-status probe on every Accounts row mount, so
 *  sixteen panel opens on a three-account install pushed every real launch out
 *  and the panel fell back to showing a probe with no findings -- the exact
 *  report this round exists to surface, invisible again (adversarial re-attack,
 *  MAJOR). Probes are worth keeping and worth logging; they are not worth a
 *  launch's slot. */
const MAX_REPORTS = 50
const MAX_PROBE_REPORTS = 20
const reports: StoredReport[] = []
const probeReports: StoredReport[] = []
let nextSeq = 0
const ringFor = (kind: ManagedLaunchKind): StoredReport[] => (kind === 'probe' ? probeReports : reports)

/** Project- and local-scope settings files, in the order the CLI reads them.
 *  The app never writes or modifies either: they belong to the repository. */
const PROJECT_SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const

/** A settings file large enough to be something other than a settings file is
 *  not read. The preflight is on the launch path; it does not parse megabytes. */
const MAX_PROJECT_SETTINGS_BYTES = 128 * 1024

// At most MAX_REPORTED_NAMES key names reach the panel; the rest become a
// count (`boundNames`, shared with the settings-copy finding so the two bounds
// cannot drift). Not cosmetic: settings keys are JSON properties and the `env`
// match is case-insensitive, so ONE authority name can appear under hundreds
// of spellings in a file that is still inside the size cap -- which turned the
// finding text into a megabyte of string, crossing IPC and rendering into a
// single list item (adversarial review, MINOR).

/**
 * Authority-bearing keys a PROJECT's own settings carry, for the report.
 *
 * ASYNC, AND OFF THE SPAWN PATH -- read the next paragraph before making it
 * synchronous again. The first version of this ran `statSync` + `readFileSync`
 * inside `withProfileHome`, which is called synchronously by every launch. A
 * working directory on an unreachable share (a sleeping NAS, a VPN that
 * dropped, a stale mapped drive -- no attacker required) then blocked the
 * ELECTRON MAIN THREAD for the SMB timeout: measured at 42 seconds, twice, on
 * two unrelated dead hosts, per file, per launch. The module header promised
 * "never blocks" and a `try/catch` cannot catch a blocking syscall.
 *
 * So the launch records its report immediately, and this runs afterwards and
 * amends it. Three further bounds, each from a measured failure:
 *   - the handle is OPENED and `fstat`ed, and anything that is not a regular
 *     file is refused, because `size` is 0 for a FIFO and for a character
 *     device -- so the size cap passed and the read blocked forever (POSIX) or
 *     ran to 2 GiB on `/dev/zero`;
 *   - the cap is on the file, and the classification no longer produces a
 *     sanitised COPY it would throw away: a pretty-printing stringify is
 *     O(depth^2), so a nested file UNDER the old 1 MiB cap cost 3.4 s of CPU;
 *   - the whole amendment is raced against a short deadline, so a slow path
 *     that is merely slow rather than dead still costs nothing visible.
 *
 * It never modifies anything it reads. These files belong to the repository;
 * what suppresses them for a managed session is the host control, not an edit.
 */
async function projectAuthoritySettingsKeys(cwd: string | null): Promise<string[]> {
  if (!cwd) return []
  const found: string[] = []
  for (const name of PROJECT_SETTINGS_FILES) {
    const file = path.join(cwd, '.claude', name)
    let handle: fs.promises.FileHandle | null = null
    try {
      handle = await fs.promises.open(file, 'r')
      const stat = await handle.stat()
      // A FIFO, a device or a directory is not a settings file, and its `size`
      // tells you nothing about what reading it would cost.
      if (!stat.isFile() || stat.size > MAX_PROJECT_SETTINGS_BYTES) continue
      // Read into a FIXED buffer rather than calling `handle.readFile()`. That
      // helper re-stats the handle and allocates for whatever the file is at
      // that moment, so the check above was advisory rather than a bound: with a
      // concurrent local writer, a file that stat'd at 7 bytes was measured
      // coming back at 314 MB, decoded and parsed on the main thread
      // (adversarial round 4). The buffer is the bound.
      // cap + 1, and a byte past the cap is a SKIP. Reading exactly the cap
      // would hand JSON.parse a truncated prefix of a file that grew -- possibly
      // cut mid-character -- and report whatever survived as if it were the file.
      const buf = Buffer.allocUnsafe(MAX_PROJECT_SETTINGS_BYTES + 1)
      const { bytesRead } = await handle.read(buf, 0, MAX_PROJECT_SETTINGS_BYTES + 1, 0)
      if (bytesRead > MAX_PROJECT_SETTINGS_BYTES) continue
      const raw = buf.toString('utf8', 0, bytesRead)
      const keys = authoritySettingsKeysFor('claude', raw)
      // `null` means there was nobody to ask (no registered provider), which is
      // not the same as "this file carries nothing" -- so say so rather than
      // reporting an absence the data does not support.
      if (keys === null) {
        logWarn(`[managed-launch] project settings not classified: no registered Claude package to ask`)
        return []
      }
      // A file that cannot be parsed is reported as nothing rather than as a
      // fault: it is not ours, and the CLI will tell the user about it.
      for (const key of keys) found.push(`${name}: ${key}`)
    } catch { /* absent, unreadable, or not ours: nothing to report */ } finally {
      await handle?.close().catch(() => {})
    }
  }
  return boundNames(found)
}

/** TEST SEAM. The scan on its own, so a test can assert that it RETURNS on a
 *  path that would block a read -- an assertion the amended report cannot
 *  carry, because "no finding" is what both a refused scan and a blocked one
 *  look like from outside. */
export const _projectAuthoritySettingsKeysForTest = projectAuthoritySettingsKeys

/** How long the project scan may take before the report is left as it stands.
 *  Generous for a local file, far below anything a dead network path costs. */
const PROJECT_SCAN_DEADLINE_MS = 2000
/** How long a scan may stay outstanding before the single-flight flag is
 *  released anyway. Not a cancellation -- the syscall cannot be cancelled -- but
 *  a bound on how long ONE wedged mount may disable the diagnostic. */
const PROJECT_SCAN_WATCHDOG_MS = 60_000

/**
 * At most ONE project scan is in flight for the whole process.
 *
 * The deadline above bounds the PROMISE, not the syscall. `fs.promises.open`
 * takes no AbortSignal (checked against Node 24: the third argument is `mode`),
 * so a `Promise.race` that gives up still leaves the open running on the libuv
 * THREADPOOL until the OS gives up -- 42 seconds on an unreachable share. The
 * pool has four threads by default and this app never raises it, so four such
 * launches stall every other threadpool consumer in the main process: all of
 * `fs.promises`, and `dns.lookup`, which is how `http`/`https` resolve a
 * hostname. Measured at 21 seconds of stalled local reads and DNS (adversarial
 * re-attack, BLOCKER reopened).
 *
 * The deadline cannot fix that; only not starting the call can. Single-flight
 * caps the exposure at ONE occupied thread however many sessions are launched,
 * which leaves the pool working. A diagnostic that skips itself while a slow
 * one is outstanding loses nothing: the next launch re-runs it.
 */
let projectScanInFlight = false
/** Scans STARTED and not yet SETTLED -- i.e. filesystem threads this feature
 *  holds right now. Distinct from the flag above, which the watchdog may
 *  re-open while the thread is still gone. */
let outstandingProjectScans = 0
/** Half of libuv's default four-thread pool. The other half stays available to
 *  everything else in the main process however badly a mount is wedged. */
const MAX_OUTSTANDING_PROJECT_SCANS = 2
let projectScanCeilingLogged = false

/** Test seam: the two counters are process-wide, so a suite that strands a scan
 *  on purpose has to be able to put them back. */
export function _resetProjectScanStateForTest(): void {
  projectScanInFlight = false
  outstandingProjectScans = 0
  projectScanCeilingLogged = false
}
/** Test seam: the counters as they stand, so a test can assert on the ceiling
 *  episode without spying on the logger. */
export function _projectScanStateForTest(): { inFlight: boolean; outstanding: number; ceilingLogged: boolean } {
  return { inFlight: projectScanInFlight, outstanding: outstandingProjectScans, ceilingLogged: projectScanCeilingLogged }
}

/**
 * A path whose root is a network share, judged WITHOUT touching the disk.
 *
 * UNC only, which is the shape that produced the measured freeze and the one
 * that can be recognised from the string alone. A MAPPED DRIVE (`Z:` pointing
 * at the same dead host) is not detectable without a call that can itself
 * block, so it is not attempted -- single-flight is what bounds that case, and
 * saying so is better than a check that pretends to cover it.
 */
function isUncPath(p: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(p)
}

/**
 * Run the preflight for one composed managed launch and record it.
 *
 * Never throws and never blocks: it is called on the spawn path, and a
 * diagnostic that can break a launch is worse than no diagnostic. The control
 * it reports on has already been applied (and asserted) by `withProfileHome` --
 * that assertion, not this function, is what refuses a launch.
 *
 * "Never blocks" is load-bearing and is why NOTHING here touches the
 * filesystem. The project scan is started afterwards and amends the stored
 * report when it answers.
 */
export function recordManagedLaunchPreflight(
  sessionId: string,
  profileId: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string | null = null,
  kind: ManagedLaunchKind = 'launch',
): ManagedLaunchPreflight | null {
  try {
    // If the boot probe never answered (the CLI was installed after launch, or
    // one probe failed), start another now. Fire-and-forget: this launch still
    // reports `unknown`, the next one will not.
    ensureClaudeCliVersion()
    const input: ManagedLaunchPreflightInput = {
      env,
      cliVersion: peekClaudeCliVersion(),
      // `'not-evaluated'`, never `undefined`: a launch that did not build the
      // profile home has no sanitise result, and saying nothing read as clean.
      sanitizedSettings: lastSettingsSanitiseFor(home) ?? 'not-evaluated',
      strippedAmbient: lastAmbientStripFor(home) ?? undefined,
    }
    const preflight = managedLaunchPreflightFor('claude', input)
    if (!preflight) return null
    const report: StoredReport = { home, profileId, sessionId, kind, at: Date.now(), seq: nextSeq++, preflight, input }
    const ring = ringFor(kind)
    const max = kind === 'probe' ? MAX_PROBE_REPORTS : MAX_REPORTS
    ring.push(report)
    if (ring.length > max) ring.splice(0, ring.length - max)
    logPreflight(sessionId, preflight)
    if (cwd) void amendWithProjectSettings(report, cwd)
    return preflight
  } catch (e) {
    logWarn(`[managed-launch] preflight failed for session ${sessionId}: ${(e as Error)?.message ?? e}`)
    return null
  }
}

function logPreflight(sessionId: string, preflight: ManagedLaunchPreflight): void {
  for (const f of preflight.findings) {
    const line = `[managed-launch] session ${sessionId}: ${f.id} -- ${f.title}: ${f.detail}${f.action ? ` -> ${f.action}` : ''}`
    if (f.severity === 'blocked') logWarn(line)
    else logInfo(line)
  }
  if (preflight.findings.length === 0) {
    logInfo(`[managed-launch] session ${sessionId}: preflight clean (Claude Code ${preflight.compatibility.found ?? 'unknown'}) -- diagnostics only, not a claim of isolation`)
  }
}

/**
 * Re-run the preflight with the project scan's answer and replace the stored
 * result IN PLACE, so the panel shows one report per launch rather than two.
 *
 * Re-running rather than appending a finding: the preflight decides `ok` from
 * its own findings, and a caller that assembled that object by hand would be a
 * second place where "what counts as blocking" is decided.
 */
async function amendWithProjectSettings(report: StoredReport, cwd: string): Promise<void> {
  // Two refusals BEFORE any syscall, because after one is started there is no
  // way to take it back (see `projectScanInFlight`).
  // Every refusal AMENDS THE REPORT, not only the log. The panel reads the
  // newest non-probe report, and a report left as it stood was indistinguishable
  // from "this project carries nothing" -- for good, on a network path, and for
  // the newest of two launches spawned in one tick (code-quality review, MAJOR).
  // The same third state the settings copy has, for the same reason.
  // Never throws: the three refusals below run outside the try that wraps the
  // scan, and this function is fire-and-forget from the spawn path.
  const skipped = (reason: ProjectScanSkipReason): void => {
    try {
      const amended = managedLaunchPreflightFor('claude', { ...report.input, projectScanSkipped: reason })
      if (amended) report.preflight = amended
    } catch (e) {
      logWarn(`[managed-launch] session ${report.sessionId}: could not record the skipped project scan: ${(e as Error)?.message ?? e}`)
    }
  }
  if (isUncPath(cwd)) {
    logInfo(`[managed-launch] session ${report.sessionId}: project settings not scanned -- the working directory is a network path`)
    skipped('network-path')
    return
  }
  if (projectScanInFlight) {
    logInfo(`[managed-launch] session ${report.sessionId}: project settings not scanned -- another scan is still outstanding`)
    skipped('scan-outstanding')
    return
  }
  // A HARD CEILING on threads, checked before anything starts. See below: the
  // watchdog re-opens the single-flight flag, but it cannot give the thread
  // back, so the flag alone stopped being the bound the moment it existed.
  if (outstandingProjectScans >= MAX_OUTSTANDING_PROJECT_SCANS) {
    // Logged once per ceiling EPISODE: the flag is cleared when a scan settles
    // and the count drops back under the ceiling, so a later episode logs again
    // (code-quality review, MINOR). The ceiling is transient, not a switch --
    // a stranded thread comes back if the mount ever does.
    if (!projectScanCeilingLogged) {
      projectScanCeilingLogged = true
      logWarn(`[managed-launch] session ${report.sessionId}: project settings not scanned -- ${outstandingProjectScans} earlier scans have not returned and each still holds a filesystem thread; scans resume when one settles`)
    }
    skipped('thread-ceiling')
    return
  }
  projectScanInFlight = true
  outstandingProjectScans += 1
  // The flag is released when the SCAN settles, not when the race does. That
  // distinction is the whole fix: releasing on the deadline would let a second
  // scan start two seconds into a blocked open, a third two seconds after that,
  // and the pool would be starved in eight seconds instead of avoided.
  //
  // ...and a WATCHDOG under that, because "released when the scan settles" is a
  // promise about a syscall this code cannot cancel. A dead SMB host does
  // return, eventually; a wedged WebDAV or FUSE mount reached through a mapped
  // drive need not, and a scan that never settles left the flag closed for the
  // life of the process, silently disabling the diagnostic for every later
  // launch (adversarial round 4).
  //
  // The first watchdog re-opened the flag and called that "at most one more
  // occupied thread". It was one more PER WINDOW: re-opening the flag does not
  // return the thread, so every launch into the same dead mapped drive, a
  // minute apart, stranded another -- and four of them is the whole default
  // libuv pool, for the life of the process, from ordinary use of one bad
  // project directory (adversarial round 5, BLOCKER). So the watchdog re-opens
  // the FLAG, and `outstandingProjectScans` counts THREADS, decremented only
  // when a scan really settles. At the ceiling the diagnostic turns itself off
  // and says so once. Two wedged mounts cost this feature; they no longer cost
  // every `fs.promises` call and DNS lookup in the main process.
  let flagReleased = false
  const releaseFlag = (why: string): void => {
    if (flagReleased) return
    flagReleased = true
    projectScanInFlight = false
    if (why) logWarn(`[managed-launch] project settings scan for ${report.sessionId} ${why}`)
  }
  const watchdog = setTimeout(
    () => releaseFlag('has not returned; later launches may scan again, up to the outstanding-scan ceiling'),
    PROJECT_SCAN_WATCHDOG_MS,
  )
  watchdog.unref?.()
  const scan = projectAuthoritySettingsKeys(cwd)
    .catch(() => [] as string[])
    .finally(() => {
      clearTimeout(watchdog)
      // The THREAD is back only now, whatever the watchdog did to the flag.
      outstandingProjectScans -= 1
      if (outstandingProjectScans < MAX_OUTSTANDING_PROJECT_SCANS) projectScanCeilingLogged = false
      releaseFlag('')
    })
  try {
    const keys = await Promise.race([
      scan,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PROJECT_SCAN_DEADLINE_MS).unref?.()),
    ])
    if (keys === null) {
      // The deadline passed. The scan may still settle later, but this report
      // is what the panel shows now, and "nothing" is not what happened.
      logInfo(`[managed-launch] session ${report.sessionId}: project settings not scanned -- the scan did not answer within ${PROJECT_SCAN_DEADLINE_MS} ms`)
      skipped('timed-out')
      return
    }
    if (keys.length === 0) return
    // `report` may already have been evicted from the ring by newer launches.
    // Writing to it is then a write to an object nobody can reach any more --
    // harmless, and cheaper than holding a lookup open across the await.
    const amended = managedLaunchPreflightFor('claude', { ...report.input, repositorySettingsKeys: keys })
    if (!amended) return
    report.preflight = amended
    for (const f of amended.findings) {
      if (f.id === 'repository-settings-suppressed') logInfo(`[managed-launch] session ${report.sessionId}: ${f.id} -- ${f.detail}`)
    }
  } catch (e) {
    logWarn(`[managed-launch] project settings scan failed for session ${report.sessionId}: ${(e as Error)?.message ?? e}`)
  }
}

/**
 * Newest first, for ONE profile. The `profileId` argument is required.
 *
 * It used to hand the whole process-wide ring buffer to any caller, which made
 * the diagnostic leak across the boundary it exists to defend (adversarial
 * review, MAJOR 5). Three things crossed per account with nothing saying which
 * account they belonged to: the absolute profile-home path, and therefore the OS
 * username; the settings keys stripped from THAT account's copy; and the ambient
 * variable names stripped from THAT account's environment -- which is enough to
 * tell one account's owner that another routes through Bedrock or a corporate
 * proxy. The panel then deduped by finding id, so a second account's occurrence
 * was not merely unattributed, it was invisible.
 *
 * `home` is deliberately not returned: it is an absolute path, the caller
 * already knows which profile it asked for, and the id is what the UI needs.
 */
export function listManagedLaunchReports(profileId: string): readonly ManagedLaunchReport[] {
  if (typeof profileId !== 'string' || profileId.length === 0) return []
  // Both rings, newest first overall. They are kept apart so a probe cannot
  // EVICT a launch, not so the caller sees a different set: the panel still
  // wants a probe when a profile has nothing else, and `kind` is what lets it
  // prefer one over the other.
  return [...reports, ...probeReports]
    .filter((r) => r.profileId === profileId)
    .sort((a, b) => b.seq - a.seq)
    .map((r) => ({ profileId: r.profileId, sessionId: r.sessionId, kind: r.kind, at: r.at, preflight: r.preflight }))
}

export function _resetManagedLaunchReportsForTest(): void {
  reports.length = 0
  probeReports.length = 0
  nextSeq = 0
}
