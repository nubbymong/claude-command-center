// The installed Claude Code version, cached.
//
// Needed because everything the managed launch relies on -- the realm roots the
// CLI honours, the authority manifest the sanitiser and the project gate read,
// the settings scopes the CLI actually applies -- was measured on ONE pinned
// version, and the managed-launch preflight has to say which side of that
// floor the user is on. See src/main/providers/claude/managed-launch.ts.
//
// It RESOLVES the binary through `probeClaudeCli()` rather than execing the
// bare name. That is not tidiness: claude-cli-probe.ts documents why a bare
// name is wrong here -- a GUI-launched Electron's PATH on macOS and Linux does
// not carry Homebrew, nvm or asdf, so `execFile('claude', ...)` reports
// "missing" for a CLI the user's login shell finds perfectly well. Getting that
// wrong would not fail safe: it would leave the version permanently `unknown`
// and put a blocking preflight finding on every managed launch for a user whose
// CLI is perfectly up to date.
//
// Deliberately NOT on the spawn path. A managed launch must not wait on a
// subprocess, and must not fail because one was slow: the preflight reports
// `unknown` until a probe has answered, which is a loud state rather than a
// silent pass. The probe runs at boot, and again on demand when something asks
// and the answer is still unknown.
import { execFile } from 'node:child_process'
import { logInfo, logWarn } from './debug-logger'
import { probeClaudeCli } from './claude-cli-probe'

/** Extract the semver from `claude --version` output ("2.1.278 (Claude Code)").
 *  Exported for the test: the shape of that line is the CLI's to change. */
export function parseClaudeCliVersion(raw: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(raw ?? '')
  return m ? m[1] : null
}

let cached: string | null = null
let inFlight: Promise<string | null> | null = null
let lastFailureAt = 0

/** How long after a FAILED probe `ensureClaudeCliVersion` declines to try again.
 *
 *  `probeClaudeCli()` coalesces only while a probe is in flight; it caches
 *  nothing between calls. Without a floor, a user with no resolvable CLI would
 *  start a fresh resolution chain on every managed spawn -- and on POSIX that
 *  chain spawns a LOGIN SHELL (`$SHELL -lc 'command -v claude'`, 8s timeout).
 *  It is bounded by user-initiated spawns and never blocks a launch, so this is
 *  a floor on wasted work rather than a fix for a hang. */
const FAILED_PROBE_BACKOFF_MS = 60_000

/** The last version a probe returned, or null if none has. SYNCHRONOUS, for
 *  callers on a launch path that must not wait -- `null` means "not probed
 *  yet", never "old" and never "fine". */
export function peekClaudeCliVersion(): string | null {
  return cached
}

function runVersionProbe(): Promise<string | null> {
  return probeClaudeCli().then((probe) => new Promise<string | null>((resolve) => {
    if (!probe.installed || !probe.path) {
      logWarn(`[claude-version] no Claude CLI resolved (${probe.probe}); version stays unknown`)
      resolve(null)
      return
    }
    try {
      execFile(
        probe.path,
        ['--version'],
        // No `shell: true`: the path came from `where` / `command -v`, so it is
        // already the resolved executable. Running it directly also keeps a
        // path with a space in it out of a shell's word splitting.
        { encoding: 'utf-8', timeout: 10_000, windowsHide: true },
        (err, stdout) => {
          if (err) { logWarn(`[claude-version] probe failed: ${err.message}`); resolve(null); return }
          const v = parseClaudeCliVersion(String(stdout ?? ''))
          if (v) logInfo(`[claude-version] installed Claude Code ${v} (${probe.path})`)
          else logWarn('[claude-version] probe returned no recognisable version')
          resolve(v)
        },
      )
    } catch (e) {
      logWarn(`[claude-version] probe threw: ${(e as Error).message}`)
      resolve(null)
    }
  })).catch((e: unknown) => {
    logWarn(`[claude-version] binary resolution failed: ${(e as Error)?.message ?? e}`)
    return null
  })
}

/**
 * Probe and cache. Overlapping calls share one subprocess.
 *
 * A failure is cached as NOTHING, not as a version, so a transient failure can
 * never make an old CLI look verified -- and so a later call genuinely re-runs.
 * That is also what makes "install or update the CLI, then start a session"
 * work: `ensureClaudeCliVersion()` below re-probes while the answer is unknown.
 */
export function probeClaudeCliVersion(): Promise<string | null> {
  if (inFlight) return inFlight
  const run = runVersionProbe().then((v) => {
    if (v) cached = v
    else lastFailureAt = Date.now()
    inFlight = null
    return v
  }, (e: unknown) => {
    lastFailureAt = Date.now()
    inFlight = null
    logWarn(`[claude-version] probe rejected: ${(e as Error)?.message ?? e}`)
    return null
  })
  inFlight = run
  return run
}

/** Kick off a probe IF the version is still unknown, without waiting for it.
 *
 *  Called from the launch path so a user who installs or updates the CLI after
 *  the app started gets a correct answer on a later launch, instead of being
 *  stuck on a permanent `unknown` from one failed boot probe. Never throws,
 *  never waits, and never retries a FAILED probe more often than
 *  FAILED_PROBE_BACKOFF_MS. An explicit `probeClaudeCliVersion()` call ignores
 *  the backoff -- this is the opportunistic path, not the deliberate one. */
export function ensureClaudeCliVersion(): void {
  if (cached !== null) return
  if (lastFailureAt && Date.now() - lastFailureAt < FAILED_PROBE_BACKOFF_MS) return
  void probeClaudeCliVersion()
}

/** Test-only: drop the cache so a suite can drive the probe deterministically. */
export function _resetClaudeCliVersionForTest(): void {
  cached = null
  inFlight = null
  lastFailureAt = 0
}
