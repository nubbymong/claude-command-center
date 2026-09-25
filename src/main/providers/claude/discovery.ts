// Finding and proving the Claude Code CLI for a reviewer launch (WP2 commit
// 5b; plan "Commit 5b", design 5.6, 8.4). The executable is resolved the way
// the version probe resolves it (the PATH walk on Windows, the login shell
// elsewhere), canonicalised, and its version proven by running it --
// `--version`, through the CLI runner, no shell -- against the managed-launch
// floor (2.1.278, the version the reviewer's flags were verified on). Its
// identity (canonical path, device and inode, size, modification and change
// times) is recorded and re-read after the run, so a launch can tell whether
// the file it is about to run is the one that answered.
//
// Claude Code updates itself in place (the native installer replaces the
// file, or repoints the link, on its own schedule), so a changed executable is
// not refused outright as Codex's is: the launch proves the new file again
// before it runs it (see verifyClaudeExecutable's caller in review-launch.ts).
//
// Every side effect is a port, so the logic is tested without a filesystem or
// a process; the real ports are built in review-launch.ts.
import type { DiscoveryResult } from '../core'
import type { Compatibility } from '../../../shared/providers'
import { claudeManagedCliCompatibility } from './managed-launch'

export interface ClaudeExecutableIdentity {
  /** Canonical absolute path. */
  path: string
  size: number
  /** Whole milliseconds (NTFS reports fractions; a stored value must compare equal). */
  mtimeMs: number
  ctimeMs: number
  /** Device and file id as decimal strings: NTFS file ids exceed 2^53. */
  dev: string
  ino: string
}

export interface ClaudeFileStat { size: number; mtimeMs: number; ctimeMs: number; dev: string; ino: string; isFile: boolean }

/** One `--version` run's outcome, as the CLI runner reports it. */
export interface ClaudeVersionRun { exitCode: number | null; stdout: string; timedOut: boolean; spawnError?: string }

export interface ClaudeDiscoveryDeps {
  /** The executable the version probe would find (absolute), or null. */
  resolve(): Promise<string | null>
  /** Canonical path; throws when it does not exist. */
  realpath(p: string): string
  /** Throws when it cannot be read. */
  stat(p: string): ClaudeFileStat
  /** `<canonical> --version`, no shell; a refusal to build the command line
   *  comes back as `{ refused }`. */
  runVersion(executable: string): Promise<ClaudeVersionRun | { refused: string }>
  platform: NodeJS.Platform
  now(): number
}

export type ClaudeDiscovery = DiscoveryResult & { identity?: ClaudeExecutableIdentity }

/** Only a CLI proven at or above the floor may run a reviewer. */
export function claudeCompatibilityAllowsUse(c: Compatibility): boolean {
  return c === 'supported'
}

/** The version `claude --version` prints ("2.1.278 (Claude Code)"). */
export function parseClaudeVersion(raw: string): string | null {
  const m = /^\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(raw ?? '')
  return m ? m[1] : null
}

function identityOf(path: string, st: ClaudeFileStat): ClaudeExecutableIdentity {
  return { path, size: st.size, mtimeMs: Math.floor(st.mtimeMs), ctimeMs: Math.floor(st.ctimeMs), dev: st.dev, ino: st.ino }
}

/** The same file with the same content: path-independent parts only. */
const sameFile = (a: ClaudeExecutableIdentity, b: ClaudeExecutableIdentity) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.dev === b.dev && a.ino === b.ino
/** ...and not touched since (a copy with preserved size and mtime still
 *  changes the change time). */
const sameIdentity = (a: ClaudeExecutableIdentity, b: ClaudeExecutableIdentity) => sameFile(a, b) && a.ctimeMs === b.ctimeMs

export async function discoverClaude(deps: ClaudeDiscoveryDeps): Promise<ClaudeDiscovery> {
  const checkedAt = deps.now()
  const base = { checkedAt, compatibility: 'unknown' as Compatibility }
  let resolved: string | null
  try { resolved = await deps.resolve() } catch { resolved = null }
  if (!resolved) return { ...base, state: 'missing', detail: 'the Claude Code CLI was not found' }
  let canonical: string
  let st: ClaudeFileStat
  try {
    canonical = deps.realpath(resolved)
    st = deps.stat(canonical)
  } catch {
    return { ...base, state: 'invalid', detail: 'the Claude Code CLI could not be read' }
  }
  if (!st.isFile) return { ...base, state: 'invalid', detail: 'the Claude Code CLI is not a file' }
  const identity = identityOf(canonical, st)
  let run: ClaudeVersionRun | { refused: string }
  try {
    run = await deps.runVersion(canonical)
  } catch {
    return { ...base, state: 'error', executable: canonical, identity, detail: 'the Claude Code CLI could not be started' }
  }
  if ('refused' in run) return { ...base, state: 'invalid', executable: canonical, identity, detail: run.refused }
  if (run.spawnError || run.timedOut) {
    return { ...base, state: 'error', executable: canonical, identity, detail: run.timedOut ? 'the Claude Code CLI did not answer --version in time' : 'the Claude Code CLI could not be started' }
  }
  // The file that answered must still be the file that was checked; the
  // identity kept is the one read AFTER the run (a first run on macOS may
  // move the change time as Gatekeeper clears the quarantine attribute).
  let after: ClaudeExecutableIdentity
  try {
    after = identityOf(canonical, deps.stat(canonical))
  } catch {
    return { ...base, state: 'invalid', executable: canonical, identity, detail: 'the Claude Code CLI disappeared while it was being checked' }
  }
  if (!sameFile(after, identity)) return { ...base, state: 'invalid', executable: canonical, identity, detail: 'the Claude Code CLI changed while it was being checked' }
  const version = run.exitCode === 0 ? parseClaudeVersion(run.stdout) : null
  if (!version) return { ...base, state: 'invalid', executable: canonical, identity: after, detail: 'the Claude Code CLI did not report a version this app recognises' }
  const compat = claudeManagedCliCompatibility(version)
  return { state: 'found', executable: canonical, identity: after, version, compatibility: compat.state === 'supported' ? 'supported' : 'too-old', checkedAt }
}

export type ClaudeExecutableCheck =
  | { ok: true; executable: string }
  | { ok: false; reason: 'missing' | 'moved' | 'replaced'; detail: string }

/** Before a launch: is the executable resolved NOW the one discovery proved?
 *  A different canonical path or a changed file identity is reported, never
 *  run; on success the caller runs exactly the canonical path returned. */
export async function verifyClaudeExecutable(recorded: ClaudeExecutableIdentity, deps: Pick<ClaudeDiscoveryDeps, 'resolve' | 'realpath' | 'stat' | 'platform'>): Promise<ClaudeExecutableCheck> {
  let resolved: string | null
  try { resolved = await deps.resolve() } catch { resolved = null }
  if (!resolved) return { ok: false, reason: 'missing', detail: 'the Claude Code CLI is no longer found' }
  let canonical: string
  let st: ClaudeFileStat
  try {
    canonical = deps.realpath(resolved)
    st = deps.stat(canonical)
  } catch {
    return { ok: false, reason: 'missing', detail: 'the Claude Code CLI can no longer be read' }
  }
  const same = deps.platform === 'win32' ? canonical.toLowerCase() === recorded.path.toLowerCase() : canonical === recorded.path
  if (!same) return { ok: false, reason: 'moved', detail: 'a different Claude Code CLI is found now than the one that was checked' }
  if (!st.isFile || !sameIdentity(identityOf(canonical, st), recorded)) return { ok: false, reason: 'replaced', detail: 'the Claude Code CLI was replaced since it was checked' }
  return { ok: true, executable: canonical }
}
