// The macOS realm guard (decision aicc_planning#172 item 4, 2026-10-07):
// before a NON-primary macOS profile runs Claude on its own config folder
// (CLAUDE_CONFIG_DIR), prove that the CLI it will run honours that folder for
// its sign-in. The evidence is `claude auth status` run under the SAME realm
// environment the launch gets: its JSON reports `configDirectory`, which must
// be exactly the realm folder (verified on a Mac, 2026-10-07: with
// CLAUDE_CONFIG_DIR set the field is that folder; unset, it is ~/.claude). A
// CLI that ignores CLAUDE_CONFIG_DIR would report ~/.claude -- the primary's
// sign-in -- and the launch would run as the wrong account.
//
// Missing field, unparseable output, a non-zero exit without JSON, or a
// different folder: REFUSED, "update Claude Code". A probe that did not answer
// in time, or could not start: REFUSED with a retryable message. Never run
// unisolated.
//
// Cost: the verdict is cached (mac-realm-verdict.ts) per (realm folder, CLI
// path, CLI file identity); this runs only on a miss. Overlapping checks of
// one folder share one probe.
import { execFile } from 'node:child_process'
import path from 'node:path'
import { macProfileConfigDir, withProfileHome, MANAGED_LAUNCH_REFUSAL } from './account-profiles'
import { profileIdFromHome } from './profile-id'
import { resolveClaudeExecutable } from './claude-cli-version'
import { resolveVersionBinary } from './legacy-version-manager'
import { gateManagedLaunch, peekGateVerdict } from './managed-launch-diagnostics'
import { acquireProfileConsumer, pendingProfileRefresh } from './profile-consumers'
import { logInfo, logWarn } from './debug-logger'
import {
  setMacRealmVerdictHooks, currentInstalledCli, setCurrentInstalledCli, cliStampSync,
  recordMacRealmVerdict, noteMacRealmRefusal, hasMacRealmVerdict, MAC_REALM_NOT_ISOLATED,
  previousInstalledCli, CLI_RESOLVE_TTL_MARGIN_MS, setNextInstalledCli, takeNextInstalledCli,
} from './mac-realm-verdict'

export const MAC_REALM_CHECK_TIMEOUT_MS = 15_000

/** The retryable refusal (a probe that did not answer or could not start). */
export function macRealmCheckRetryable(why: string): string {
  return `could not check whether the installed Claude Code keeps a separate sign-in for this account folder (${why}); try again`
}

export const MAC_REALM_CLI_NOT_FOUND =
  'Claude Code was not found on this Mac, so this account folder could not be checked; install Claude Code, then try again'

export type RealmProbeResult = { code: number | null; stdout: string; timedOut: boolean; spawnError?: string; oversize?: boolean }
export type RealmProbeRunner = (file: string, args: readonly string[], opts: { env: Record<string, string>; cwd: string; timeoutMs: number }) => Promise<RealmProbeResult>

/** The refusal when the probe's answer could not be read at all (no JSON
 *  object in it, or more output than the probe keeps) -- distinct from a
 *  readable answer that names another folder (re-attack r3, MINOR 4). */
export const MAC_REALM_UNREADABLE =
  "the installed Claude Code's `auth status` answer could not be read, so this account folder could not be checked; update Claude Code"

const defaultRunner: RealmProbeRunner = (file, args, opts) => new Promise((resolve) => {
  try {
    execFile(file, [...args], { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 20, shell: false }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string | null }) | null
      // More than maxBuffer: Node kills the child and says so in the code --
      // that is an unreadable answer, not a slow one.
      if (e && e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { resolve({ code: null, stdout: '', timedOut: false, oversize: true }); return }
      const timedOut = !!e && (e.killed === true || e.signal === 'SIGTERM')
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : null
      const spawnError = e && typeof e.code === 'string' ? e.code : undefined
      resolve({ code, stdout: String(stdout ?? ''), timedOut, ...(spawnError ? { spawnError } : {}) })
    })
  } catch (e) {
    resolve({ code: null, stdout: '', timedOut: false, spawnError: String((e as Error)?.message ?? e) })
  }
})

let runner: RealmProbeRunner = defaultRunner

/** Exported for its test only: the real probe runner. */
export const _defaultRealmProbeRunnerForTest: RealmProbeRunner = defaultRunner
let resolveCli: () => Promise<string | null> = resolveClaudeExecutable

/** Test seam. */
export function _setMacRealmGuardSeamsForTest(s: { runner?: RealmProbeRunner | null; resolveCli?: (() => Promise<string | null>) | null }): void {
  if ('runner' in s) runner = s.runner ?? defaultRunner
  if ('resolveCli' in s) resolveCli = s.resolveCli ?? resolveClaudeExecutable
}

/** Every JSON object in `s` that starts a line: each such line on its own,
 *  then the block from that line to the last `}`. Latest first. */
function jsonObjectsIn(s: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const lines = s.split(/\r?\n/)
  const tryParse = (text: string): void => {
    try {
      const o = JSON.parse(text) as unknown
      if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o as Record<string, unknown>)
    } catch { /* not this one */ }
  }
  let attempts = 0
  // Start offset of every line, so a block can be cut from the original text.
  const starts: number[] = []
  let at = 0
  for (const l of lines) { starts.push(at); at += l.length + 1 }
  // Each line-initial `{` up to each later line-final `}`: a pretty-printed
  // object spans lines, a one-line object is one; latest start first.
  const ends: number[] = []
  for (let i = 0; i < lines.length; i++) if (lines[i].trimEnd().endsWith('}')) ends.push(starts[i] + lines[i].trimEnd().length)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trimStart().startsWith('{')) continue
    const from = starts[i] + (lines[i].length - lines[i].trimStart().length)
    for (let j = ends.length - 1; j >= 0; j--) {
      if (ends[j] <= from) break
      if (++attempts > 2_000) return out // bounded: a hostile or huge answer cannot spin here
      const before = out.length
      tryParse(s.slice(from, ends[j]))
      if (out.length > before) break // the longest object from this start
    }
  }
  return out
}

/** The verdict from `claude auth status` stdout for realm folder `dir` (already
 *  normalised the way the launch builds it: path.resolve + NFC). The output is
 *  scanned for the LAST JSON object carrying `configDirectory`, so a warning
 *  line or a trailing note around it is not mistaken for a refusal (re-attack
 *  r3, MINOR 4). The field is normalised the same way before the compare.
 *  'unreadable': no JSON object at all. Pure; exported for its tests. */
export function realmVerdictFromAuthStatus(stdout: string, dir: string): 'isolated' | 'not-isolated' | 'unreadable' {
  const objects = jsonObjectsIn(String(stdout ?? ''))
  if (objects.length === 0) return 'unreadable'
  const withField = objects.find((o) => typeof o.configDirectory === 'string')
  const cd = withField?.configDirectory
  if (typeof cd !== 'string' || !cd || !path.isAbsolute(cd)) return 'not-isolated'
  return path.resolve(cd).normalize('NFC') === dir ? 'isolated' : 'not-isolated'
}

const inFlight = new Map<string, Promise<void>>()

async function ensure(home: string, pinnedCliPath?: string | null): Promise<void> {
  const dir = macProfileConfigDir(home)
  if (!dir) return
  const k = `${dir}\u0000${pinnedCliPath ?? ''}`
  const running = inFlight.get(k)
  if (running) return running
  const run = check(home, dir, pinnedCliPath ?? null).finally(() => { if (inFlight.get(k) === run) inFlight.delete(k) })
  inFlight.set(k, run)
  return run
}

let backgroundResolve: Promise<void> | null = null

/** Re-resolve the installed CLI without holding up a launch (MINOR 2). A
 *  failure keeps what there was; a different binary replaces it, and the next
 *  launch then checks that one. */
function refreshInstalledCliInBackground(): void {
  if (backgroundResolve) return
  backgroundResolve = (async () => {
    try {
      const p = await resolveCli()
      const stamp = p ? cliStampSync(p) : null
      if (p && stamp) setNextInstalledCli({ path: p, stamp })
      else logWarn('[mac-realm] background CLI lookup found nothing; keeping the previous (unchanged) binary')
    } catch { /* keep the previous one */ } finally { backgroundResolve = null }
  })()
}

/** Test seam: await a background re-resolution, if one is running. */
export async function _settleBackgroundResolveForTest(): Promise<void> { if (backgroundResolve) await backgroundResolve }

async function check(home: string, dir: string, pinned: string | null): Promise<void> {
  let cli: { path: string; stamp: string } | null
  if (pinned) {
    const stamp = cliStampSync(pinned)
    if (!stamp) { noteMacRealmRefusal(dir, MAC_REALM_CLI_NOT_FOUND); return }
    cli = { path: pinned, stamp }
  } else {
    // A background lookup's answer is adopted here, at the start of a check.
    const next = takeNextInstalledCli()
    if (next && cliStampSync(next.path) === next.stamp) setCurrentInstalledCli(next)
    cli = currentInstalledCli(CLI_RESOLVE_TTL_MARGIN_MS)
    if (!cli) {
      // TTL (nearly) up. The binary resolved last time, still the same file,
      // keeps serving while a fresh lookup runs in the background -- a slow or
      // failed login-shell lookup must not refuse an unchanged CLI (MINOR 2).
      const prev = previousInstalledCli()
      if (prev) {
        setCurrentInstalledCli(prev)
        refreshInstalledCliInBackground()
        cli = prev
      } else {
        let p: string | null = null
        try { p = await resolveCli() } catch { p = null }
        const stamp = p ? cliStampSync(p) : null
        if (!p || !stamp) { setCurrentInstalledCli(null); noteMacRealmRefusal(dir, MAC_REALM_CLI_NOT_FOUND); return }
        cli = { path: p, stamp }
        setCurrentInstalledCli(cli)
      }
    }
  }  if (hasMacRealmVerdict(dir, pinned)) return

  // The probe is a credential consumer like the auth-status probe
  // (claude-cli-auth): held for its life, and started only after an in-flight
  // token refresh of this profile has landed.
  const profileId = profileIdFromHome(home)
  const release = profileId ? acquireProfileConsumer(profileId) : null
  try {
    const rotation = profileId ? pendingProfileRefresh(profileId) : null
    if (rotation) await rotation
    const cwd = process.cwd()
    const projectGate = peekGateVerdict(cwd) ?? await gateManagedLaunch(cwd)
    let env: Record<string, string>
    try {
      env = withProfileHome({ ...process.env } as Record<string, string>, home, { launchId: 'realm-verdict', cwd, probe: true, projectGate, realmVerdictProbe: true })
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).replace(`${MANAGED_LAUNCH_REFUSAL}: `, '')
      noteMacRealmRefusal(dir, msg)
      return
    }
    const r = await runner(cli.path, ['auth', 'status'], { env, cwd, timeoutMs: MAC_REALM_CHECK_TIMEOUT_MS })
    if (r.timedOut) { noteMacRealmRefusal(dir, macRealmCheckRetryable('it did not answer in time')); logWarn(`[mac-realm] ${dir}: auth status timed out`); return }
    if (r.code === null && r.spawnError) { noteMacRealmRefusal(dir, macRealmCheckRetryable('it could not be started')); logWarn(`[mac-realm] ${dir}: auth status could not start (${r.spawnError})`); return }
    if (r.oversize) { noteMacRealmRefusal(dir, MAC_REALM_UNREADABLE); logWarn(`[mac-realm] ${dir}: auth status printed more than the probe keeps`); return }
    const verdict = realmVerdictFromAuthStatus(r.stdout, dir)
    if (verdict === 'unreadable') { noteMacRealmRefusal(dir, MAC_REALM_UNREADABLE); logWarn(`[mac-realm] ${dir}: auth status printed no JSON (exit ${r.code})`); return }
    if (verdict === 'isolated') {
      recordMacRealmVerdict(dir, cli)
      logInfo(`[mac-realm] verified: ${cli.path} keeps a separate sign-in for ${dir}`)
      return
    }
    logWarn(`[mac-realm] REFUSED: ${cli.path} did not report ${dir} as its configDirectory (exit ${r.code})`)
    noteMacRealmRefusal(dir, MAC_REALM_NOT_ISOLATED)
  } finally {
    release?.()
  }
}

/** Wire the guard into the launch path (composition root, and tests). */
export function installMacRealmGuard(): void {
  setMacRealmVerdictHooks({
    realmDir: (home) => (process.platform === 'darwin' ? macProfileConfigDir(home) : null),
    ensure,
    pinnedPath: (version) => resolveVersionBinary(version),
  })
}
