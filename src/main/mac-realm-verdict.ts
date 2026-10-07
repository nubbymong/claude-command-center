// The macOS realm VERDICT: whether the installed Claude Code CLI really keeps
// a profile's sign-in in its own config folder (CLAUDE_CONFIG_DIR), measured
// by running `claude auth status` under that profile's realm environment and
// requiring its `configDirectory` to be the realm folder. Owner decision on
// aicc_planning#172 (2026-10-07), item 4: refuse a non-primary macOS launch
// without that evidence. See architecture/decisions/ (macOS Claude
// multi-account ADR) and src/main/mac-realm-guard.ts, which runs the probe.
//
// THIS MODULE IS A LEAF -- node built-ins only -- because the synchronous
// launch choke point (account-profiles withProfileHome / profileRealmLaunch)
// reads the cache, and claude-headless (which must not import account-profiles)
// asks whether a launch still needs a verdict. The async probe lives in
// mac-realm-guard.ts and is injected here at start (installMacRealmGuard).
//
// What is cached: POSITIVE verdicts only, keyed by (realm folder, CLI binary
// path, CLI binary identity). The identity is the resolved file's realpath,
// size and mtime -- an update in place or a symlink re-point (the native
// installer's ~/.local/bin/claude -> versions/<v>) changes it, which drops the
// verdict. The installed CLI's path is re-resolved at most every
// CLI_RESOLVE_TTL_MS, so a PATH that now finds another `claude` is noticed.
import fs from 'node:fs'

export const CLI_RESOLVE_TTL_MS = 10 * 60_000

/** The refusal when a realm launch has no positive verdict and no recorded
 *  reason (a caller that never asked for one: fails closed). */
export const MAC_REALM_UNVERIFIED =
  'this app has not yet checked that the installed Claude Code keeps a separate sign-in for this account folder; start it again'

/** The refusal when the check ran and the CLI does not isolate (decision #172 item 4). */
export const MAC_REALM_NOT_ISOLATED =
  'the installed Claude Code does not keep a separate sign-in per account folder; update Claude Code'

/** Identity of a CLI binary on disk, or null when it cannot be read. */
export function cliStampSync(cliPath: string): string | null {
  try {
    const real = fs.realpathSync(cliPath)
    const st = fs.statSync(real)
    if (!st.isFile()) return null
    return `${real}|${st.size}|${Math.round(st.mtimeMs)}`
  } catch { return null }
}

let currentCli: { path: string; stamp: string; resolvedAt: number } | null = null
const verdicts = new Map<string, string>() // `${dir}\0${cliPath}` -> stamp
const refusals = new Map<string, string>() // dir -> last refusal reason
let nowMs: () => number = () => Date.now()

const key = (dir: string, cliPath: string) => `${dir}\u0000${cliPath}`

/** The installed CLI as last resolved, when still within its TTL and its file
 *  unchanged; null otherwise (the guard must resolve again). */
export function currentInstalledCli(): { path: string; stamp: string } | null {
  if (!currentCli) return null
  if (nowMs() - currentCli.resolvedAt >= CLI_RESOLVE_TTL_MS) return null
  if (cliStampSync(currentCli.path) !== currentCli.stamp) return null
  return { path: currentCli.path, stamp: currentCli.stamp }
}

export function setCurrentInstalledCli(cli: { path: string; stamp: string } | null): void {
  currentCli = cli ? { ...cli, resolvedAt: nowMs() } : null
}

export function recordMacRealmVerdict(dir: string, cli: { path: string; stamp: string }): void {
  verdicts.set(key(dir, cli.path), cli.stamp)
  refusals.delete(dir)
}

export function noteMacRealmRefusal(dir: string, reason: string): void {
  refusals.set(dir, reason)
}

/** Whether `dir` has a positive verdict for the CLI the launch will run: the
 *  pinned binary when one is named, else the installed CLI (current, within
 *  its TTL, file unchanged). Synchronous; reads one stat per check. */
export function hasMacRealmVerdict(dir: string, pinnedCliPath?: string | null): boolean {
  if (pinnedCliPath) {
    const stamp = cliStampSync(pinnedCliPath)
    return stamp !== null && verdicts.get(key(dir, pinnedCliPath)) === stamp
  }
  const cli = currentInstalledCli()
  return !!cli && verdicts.get(key(dir, cli.path)) === cli.stamp
}

/** Why a realm launch for `dir` is refused right now (no verdict): the last
 *  check's own reason, or MAC_REALM_UNVERIFIED. */
export function macRealmRefusalReason(dir: string): string {
  return refusals.get(dir) ?? MAC_REALM_UNVERIFIED
}

// -- hooks the guard installs (account-profiles / claude-headless read them) --

interface Hooks {
  /** The realm folder for a launch under `home`, or null (not a macOS realm
   *  launch: win32/linux, setting off, the primary, not a profile). */
  realmDir: (home: string) => string | null
  /** Run the check if needed. Never rejects; the outcome is in the cache. */
  ensure: (home: string, pinnedCliPath?: string | null) => Promise<void>
  /** The binary a pinned legacy version runs, or null when not installed. */
  pinnedPath: (version: string) => string | null
}
let hooks: Hooks | null = null

export function setMacRealmVerdictHooks(h: Hooks | null): void { hooks = h }

/** The realm folder for `home`, or null. Without the guard installed: null
 *  (account-profiles applies its own rule; see withProfileHome). */
export function macRealmDirFor(home: string | null): string | null {
  if (!home || !hooks) return null
  try { return hooks.realmDir(home) } catch { return null }
}

export function pinnedCliPathFor(version: string | undefined): string | null {
  if (!version || !hooks) return null
  try { return hooks.pinnedPath(version) } catch { return null }
}

/** True when a launch under `home` is a macOS realm launch that has no
 *  positive verdict yet -- the caller must await ensureMacRealmVerdict. */
export function macRealmVerdictPending(home: string | null, pinnedCliPath?: string | null): boolean {
  const dir = macRealmDirFor(home)
  return dir !== null && !hasMacRealmVerdict(dir, pinnedCliPath)
}

/** Run the realm check for a launch under `home` when it has no verdict.
 *  Never rejects. A no-op off the macOS realm. */
export async function ensureMacRealmVerdict(home: string | null, pinnedCliPath?: string | null): Promise<void> {
  if (!home || !hooks || !macRealmVerdictPending(home, pinnedCliPath)) return
  try { await hooks.ensure(home, pinnedCliPath) } catch { /* the cache says what happened */ }
}

/** Test seam. */
export function _resetMacRealmVerdictsForTest(clock?: () => number): void {
  currentCli = null
  verdicts.clear()
  refusals.clear()
  nowMs = clock ?? (() => Date.now())
}
