// Layers 3 and 4 of the managed launch: the project-settings GATE and the
// visible preflight record.
//
// READ THIS BEFORE TRUSTING ANYTHING HERE. The gate refuses a launch whose
// working directory carries a DETECTABLE override in its own settings files
// (`.claude/settings.json`, `.claude/settings.local.json`): a credential
// helper, an account pin, a provider switch or an endpoint redirect, as the
// authority manifest defines them. The preflight is the RECORD of what a
// launch did -- the refusal included -- not a proof that a session is isolated.
// What neither can see is a recorded boundary:
//
//   - settings changed AFTER the process started;
//   - remote / organisation-managed settings, which the CLI fetches from the
//     server for a signed-in account;
//   - another process of the same OS user acting on the realm;
//   - a directory the gate cannot read safely (a network path) or in time,
//     which launches UNCHECKED with a warning rather than a refusal;
//   - anything a future CLI version reads that this version does not.
//
// There is no host-side control any more: the flag that suppressed these at
// run time also stopped the profile's own login (owner decision, 2026-09-22;
// evidence Parts 7 and 8). Refusing before launch is what this app can do
// honestly; the rest it says.
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
import type { ManagedLaunchPreflight, ManagedLaunchPreflightInput, ProjectGateResult } from '../shared/providers'

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
 *  `input` is kept with the record, for the tests and the log. */
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
 * ASYNC, AND NEVER SYNCHRONOUS -- read the next paragraph before making it so.
 * The first version of this ran `statSync` + `readFileSync` inside
 * `withProfileHome`, which is called synchronously by every launch. A working
 * directory on an unreachable share (a sleeping NAS, a VPN that dropped, a
 * stale mapped drive -- no attacker required) then blocked the ELECTRON MAIN
 * THREAD for the SMB timeout: measured at 42 seconds, twice, on two unrelated
 * dead hosts, per file, per launch. A `try/catch` cannot catch a blocking
 * syscall.
 *
 * It is now awaited by the launch GATE (`gateManagedLaunch`), which every
 * launch path runs before it composes the environment, under a deadline and a
 * thread ceiling. Three further bounds, each from a measured failure:
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
 * what a managed session does about them is REFUSE to start, not an edit.
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

/** How long the launch gate waits for the project scan. It is ON the launch
 *  path now -- the session does not start until it answers -- so it is set for
 *  a slow local disk, not for a dead share, which is refused before any syscall.
 *  Past it the launch goes ahead UNCHECKED, with a warning on the report. */
const PROJECT_GATE_DEADLINE_MS = 3000

/**
 * At most TWO project scans hold a filesystem thread at any time.
 *
 * The deadline above bounds the PROMISE, not the syscall. `fs.promises.open`
 * takes no AbortSignal (checked against Node 24: the third argument is `mode`),
 * so a gate that gives up still leaves the open running on the libuv THREADPOOL
 * until the OS gives up -- 42 seconds on an unreachable share. The pool has four
 * threads by default and this app never raises it, so four such launches stall
 * every other threadpool consumer in the main process: all of `fs.promises`,
 * and `dns.lookup`, which is how `http`/`https` resolve a hostname. Measured at
 * 21 seconds of stalled local reads and DNS (adversarial re-attack, BLOCKER).
 *
 * The deadline cannot fix that; only not starting the call can. The count of
 * scans STARTED AND NOT SETTLED is the bound, at half the default pool, and it
 * is decremented only when a scan really settles -- a watchdog that "released"
 * anything earlier was one more stranded thread per window (adversarial round
 * 5, BLOCKER). Two launches into the same directory share ONE scan. At the
 * ceiling a launch waits for a slot until its deadline, then goes ahead
 * unchecked with a warning: two wedged mounts cost this check, not the app.
 */
let outstandingProjectScans = 0
/** Half of libuv's default four-thread pool. The other half stays available to
 *  everything else in the main process however badly a mount is wedged. */
const MAX_OUTSTANDING_PROJECT_SCANS = 2
/** One scan per directory at a time; concurrent launches into it share it. */
const inFlightScans = new Map<string, Promise<string[]>>()
let projectScanCeilingLogged = false
/** The last verdict per directory, for `peekGateVerdict`. */
const recentVerdicts = new Map<string, { verdict: ProjectGateResult; at: number }>()
/** How long a verdict may be reused by a caller that cannot await. Well inside
 *  the "settings edited after launch" boundary this app already records. */
const GATE_VERDICT_REUSE_MS = 5000

/** Test seam: the counters are process-wide, so a suite that strands a scan on
 *  purpose has to be able to put them back. */
export function _resetProjectScanStateForTest(): void {
  outstandingProjectScans = 0
  inFlightScans.clear()
  recentVerdicts.clear()
  projectScanCeilingLogged = false
}
/** Test seam: the counters as they stand, so a test can assert on the ceiling
 *  episode without spying on the logger. */
export function _projectScanStateForTest(): { inFlight: number; outstanding: number; ceilingLogged: boolean } {
  return { inFlight: inFlightScans.size, outstanding: outstandingProjectScans, ceilingLogged: projectScanCeilingLogged }
}

/**
 * A path whose root is a network share, judged WITHOUT touching the disk.
 *
 * UNC only, which is the shape that produced the measured freeze and the one
 * that can be recognised from the string alone. A MAPPED DRIVE (`Z:` pointing
 * at the same dead host) is not detectable without a call that can itself
 * block, so it is not attempted -- the thread ceiling is what bounds that case,
 * and saying so is better than a check that pretends to cover it.
 */
function isUncPath(p: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(p)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.())

/**
 * THE LAUNCH GATE. Decide, before a managed session starts in `cwd`, whether
 * the project's own settings files carry anything that would redirect it.
 *
 * Returns, never throws:
 *   - `clean`        -- both files were read (or are absent) and carry no
 *                        authority key; the launch may proceed;
 *   - `refused`      -- at least one authority key was found; the caller MUST
 *                        refuse the launch and name `keys` (file and key, never
 *                        a value -- `projectAuthoritySettingsKeys` produces
 *                        names only);
 *   - `not-scanned`  -- the files could not be read safely or in time; the
 *                        caller proceeds and the report carries a WARNING. A
 *                        network path is never read on the launch path; the
 *                        thread ceiling and the deadline are the other two.
 *
 * Owner decision 2026-09-22: a detectable repository override fails visibly
 * BEFORE launch. What is not detectable is a recorded boundary, not a claim.
 * The files are never modified.
 */
export async function gateManagedLaunch(cwd: string): Promise<ProjectGateResult> {
  if (isUncPath(cwd)) {
    logInfo(`[managed-launch] project settings in ${cwd} not checked -- the working directory is a network path`)
    return { status: 'not-scanned', reason: 'network-path' }
  }
  const key = path.resolve(cwd).toLowerCase()
  const deadlineAt = Date.now() + PROJECT_GATE_DEADLINE_MS
  let scan = inFlightScans.get(key)
  if (!scan) {
    // Wait for a slot under the ceiling, but only until the deadline: a wedged
    // mount elsewhere must not hold this launch for ever.
    while (outstandingProjectScans >= MAX_OUTSTANDING_PROJECT_SCANS) {
      if (Date.now() >= deadlineAt) {
        // Logged once per ceiling EPISODE: the flag is cleared when a scan
        // settles and the count drops back under the ceiling (code-quality
        // review, MINOR). The ceiling is transient, not a switch.
        if (!projectScanCeilingLogged) {
          projectScanCeilingLogged = true
          logWarn(`[managed-launch] project settings not checked -- ${outstandingProjectScans} earlier checks have not returned and each still holds a filesystem thread; checks resume when one settles`)
        }
        return { status: 'not-scanned', reason: 'thread-ceiling' }
      }
      await sleep(25)
      scan = inFlightScans.get(key)
      if (scan) break
    }
    if (!scan) {
      outstandingProjectScans += 1
      scan = projectAuthoritySettingsKeys(cwd)
        .catch(() => [] as string[])
        .finally(() => {
          // The THREAD is back only now.
          outstandingProjectScans = Math.max(0, outstandingProjectScans - 1)
          if (outstandingProjectScans < MAX_OUTSTANDING_PROJECT_SCANS) projectScanCeilingLogged = false
          if (inFlightScans.get(key) === scan) inFlightScans.delete(key)
        })
      inFlightScans.set(key, scan)
    }
  }
  const remaining = Math.max(0, deadlineAt - Date.now())
  const keys = await Promise.race([
    scan,
    sleep(remaining).then(() => null),
  ])
  if (keys === null) {
    logInfo(`[managed-launch] project settings in ${cwd} not checked -- the check did not answer within ${PROJECT_GATE_DEADLINE_MS} ms`)
    return { status: 'not-scanned', reason: 'timed-out' }
  }
  const verdict: ProjectGateResult = keys.length === 0 ? { status: 'clean' } : { status: 'refused', keys }
  recentVerdicts.set(key, { verdict, at: Date.now() })
  return verdict
}

/**
 * A recent verdict for `cwd`, SYNCHRONOUSLY, or undefined when there is none
 * fresh enough. For the two launch paths that must stay synchronous up to
 * their spawn -- the auth-status probe and the headless runner, where
 * overlapping calls for one profile deliberately share a single subprocess so
 * that two CLIs cannot race one single-use refresh token -- an `await` before
 * the spawn would reopen that race. They ask here first and await the gate
 * only on a miss, which is the first call for a directory and once per
 * `GATE_VERDICT_REUSE_MS` after. A `not-scanned` verdict is never reused: it
 * is worth a fresh attempt.
 */
export function peekGateVerdict(cwd: string): ProjectGateResult | undefined {
  const hit = recentVerdicts.get(path.resolve(cwd).toLowerCase())
  if (!hit || Date.now() - hit.at > GATE_VERDICT_REUSE_MS) return undefined
  return hit.verdict
}

/**
 * Run the preflight for one composed managed launch and record it.
 *
 * Never throws and never blocks: it is called on the spawn path, and a
 * diagnostic that can break a launch is worse than no diagnostic. The project
 * gate has ALREADY answered by the time this runs -- its result is passed in
 * -- so nothing here touches the filesystem, and the refusal itself is the
 * caller's (`withProfileHome` throws after recording), not this function's.
 *
 * `gate` is `null` for a launch with no working directory to gate; the report
 * then says nothing about project settings, which is honest for a launch that
 * inherits the app's own directory.
 */
export function recordManagedLaunchPreflight(
  sessionId: string,
  profileId: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  gate: ProjectGateResult | null = null,
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
      ...(gate?.status === 'refused' ? { repositorySettingsKeys: gate.keys } : {}),
      ...(gate?.status === 'not-scanned' ? { projectScanSkipped: gate.reason } : {}),
    }
    const preflight = managedLaunchPreflightFor('claude', input)
    if (!preflight) return null
    const report: StoredReport = { home, profileId, sessionId, kind, at: Date.now(), seq: nextSeq++, preflight, input }
    const ring = ringFor(kind)
    const max = kind === 'probe' ? MAX_PROBE_REPORTS : MAX_REPORTS
    ring.push(report)
    if (ring.length > max) ring.splice(0, ring.length - max)
    logPreflight(sessionId, preflight)
    return preflight
  } catch (e) {
    logWarn(`[managed-launch] preflight failed for session ${sessionId}: ${(e as Error)?.message ?? e}`)
    return null
  }
}

function logPreflight(sessionId: string, preflight: ManagedLaunchPreflight): void {
  for (const f of preflight.findings) {
    const line = `[managed-launch] session ${sessionId}: ${f.id} -- ${f.title}: ${f.detail}${f.action ? ` -> ${f.action}` : ''}`
    if (f.severity === 'info') logInfo(line)
    else logWarn(line)
  }
  if (preflight.findings.length === 0) {
    logInfo(`[managed-launch] session ${sessionId}: preflight clean (Claude Code ${preflight.compatibility.found ?? 'unknown'}) -- a record of what the launch did, not a claim of isolation`)
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
