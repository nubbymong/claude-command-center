// Finding and proving the Codex CLI (WP2, plan A8; design 5.6, 8.4). The
// executable is resolved the way sessions resolve it, canonicalised, and its
// version proven by running it -- under the allowlisted environment the setup
// and sign-in operations use, with the PATH the resolving login shell had --
// and classified against the tested range. Its identity (canonical path,
// device and inode, size, and modification and change times) is recorded, and
// re-read after the run, so a later sign-in or launch can refuse an executable
// that was replaced or is now shadowed on PATH (design 8.4: "reject PATH
// shadowing, canonical-path drift or a changed executable identity until the
// user re-runs setup").
//
// `codex --version` is NOT side-effect free: the CLI prepares its home (loads
// CODEX_HOME/.env, creates helper directories) before it parses arguments. So
// it runs against a fresh, empty, throwaway home -- never the user's own
// ~/.codex, which a first-time user may not even have yet.
//
// Every side effect is a port, so the logic is tested without a filesystem or
// a process; the real ports live in index.ts's package factory.
import type { DiscoveryResult } from '../core'
import type { Compatibility } from '../../../shared/providers'
import { parseCodexVersion, classifyCodexVersion } from './cli-contract'
import { codexCommandLine, codexShellEnv } from './cli-runner'
import type { CodexCommand, CodexRunResult } from './cli-runner'
import { codexCliEnv } from './cli-env'

export interface CodexExecutableIdentity {
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

export interface CodexFileStat { size: number; mtimeMs: number; ctimeMs: number; dev: string; ino: string; isFile: boolean }

export interface CodexDiscoveryDeps {
  /** The executable a session would run (PATH / login-shell resolution). */
  resolve(): string | null
  /** Canonical path; throws when it does not exist. */
  realpath(p: string): string
  /** Throws when it cannot be read. */
  stat(p: string): CodexFileStat
  run(cmd: CodexCommand, env: Record<string, string>): Promise<CodexRunResult>
  /** The environment to allowlist from -- on macOS and Linux with the login
   *  shell's PATH, which is the one that found the CLI. */
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  /** A fresh, empty CODEX_HOME for `--version`, removed by `dispose`. */
  versionHome(): { home: string; dispose(): void }
  now(): number
}

export type CodexDiscovery = DiscoveryResult & { identity?: CodexExecutableIdentity }

/** Only a proven, not-too-old CLI may be used for sign-in or a managed
 *  launch: `unknown` is unproven and blocks exactly like `too-old`. */
export function codexCompatibilityAllowsUse(c: Compatibility): boolean {
  return c === 'supported' || c === 'too-new'
}

function identityOf(path: string, st: CodexFileStat): CodexExecutableIdentity {
  return { path, size: st.size, mtimeMs: Math.floor(st.mtimeMs), ctimeMs: Math.floor(st.ctimeMs), dev: st.dev, ino: st.ino }
}

/** The same file with the same content: path-independent parts only. */
const sameFile = (a: CodexExecutableIdentity, b: CodexExecutableIdentity) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.dev === b.dev && a.ino === b.ino
/** ...and not touched since (a copy with preserved size and mtime still
 *  changes the change time). */
const sameIdentity = (a: CodexExecutableIdentity, b: CodexExecutableIdentity) => sameFile(a, b) && a.ctimeMs === b.ctimeMs

export async function discoverCodex(deps: CodexDiscoveryDeps): Promise<CodexDiscovery> {
  const checkedAt = deps.now()
  const base = { checkedAt, compatibility: 'unknown' as Compatibility }
  let resolved: string | null
  try { resolved = deps.resolve() } catch { resolved = null }
  if (!resolved) return { ...base, state: 'missing', detail: 'the Codex CLI was not found on PATH' }
  let canonical: string
  let st: CodexFileStat
  try {
    canonical = deps.realpath(resolved)
    st = deps.stat(canonical)
  } catch {
    return { ...base, state: 'invalid', detail: 'the Codex CLI on PATH could not be read' }
  }
  if (!st.isFile) return { ...base, state: 'invalid', detail: 'the Codex CLI on PATH is not a file' }
  const identity = identityOf(canonical, st)
  const cmd = codexCommandLine(canonical, 'version', deps.platform, codexShellEnv(deps.env, deps.platform))
  if ('refused' in cmd) return { ...base, state: 'invalid', executable: canonical, identity, detail: cmd.refused }
  let run: CodexRunResult
  let scratch: { home: string; dispose(): void } | null = null
  try {
    scratch = deps.versionHome()
    run = await deps.run(cmd, codexCliEnv(deps.env, scratch.home, deps.platform))
  } catch {
    return { ...base, state: 'error', executable: canonical, identity, detail: 'the Codex CLI could not be started' }
  } finally {
    try { scratch?.dispose() } catch { /* a leftover temp directory is harmless */ }
  }
  if (run.spawnError || run.timedOut) {
    return { ...base, state: 'error', executable: canonical, identity, detail: run.timedOut ? 'the Codex CLI did not answer --version in time' : 'the Codex CLI could not be started' }
  }
  // The file that answered must still be the file that was checked. Its
  // change time alone may move on a first run (macOS Gatekeeper clears the
  // quarantine attribute), so the identity kept is the one read AFTER the run.
  let after: CodexExecutableIdentity
  try {
    after = identityOf(canonical, deps.stat(canonical))
  } catch {
    return { ...base, state: 'invalid', executable: canonical, identity, detail: 'the Codex CLI disappeared while it was being checked' }
  }
  if (!sameFile(after, identity)) return { ...base, state: 'invalid', executable: canonical, identity, detail: 'the Codex CLI changed while it was being checked' }
  const version = run.exitCode === 0 ? parseCodexVersion(run.stdout) : null
  if (!version) return { ...base, state: 'invalid', executable: canonical, identity: after, detail: 'the Codex CLI did not report a version this app recognises' }
  return { state: 'found', executable: canonical, identity: after, version, compatibility: classifyCodexVersion(version), checkedAt }
}

export type CodexExecutableCheck =
  | { ok: true; executable: string }
  | { ok: false; reason: 'missing' | 'moved' | 'replaced'; detail: string }

/** Before a sign-in or a launch: is the executable PATH resolves NOW the one
 *  setup proved? A different canonical path (shadowing, a reinstall
 *  elsewhere) or a changed file identity (replaced in place, even with its
 *  size and modification time preserved) blocks until the user re-checks. On
 *  success it returns the canonical path, and the caller runs exactly that
 *  path -- it never resolves a second time. */
export function verifyCodexExecutable(recorded: CodexExecutableIdentity, deps: Pick<CodexDiscoveryDeps, 'resolve' | 'realpath' | 'stat' | 'platform'>): CodexExecutableCheck {
  let resolved: string | null
  try { resolved = deps.resolve() } catch { resolved = null }
  if (!resolved) return { ok: false, reason: 'missing', detail: 'the Codex CLI is no longer on PATH' }
  let canonical: string
  let st: CodexFileStat
  try {
    canonical = deps.realpath(resolved)
    st = deps.stat(canonical)
  } catch {
    return { ok: false, reason: 'missing', detail: 'the Codex CLI on PATH can no longer be read' }
  }
  const same = deps.platform === 'win32' ? canonical.toLowerCase() === recorded.path.toLowerCase() : canonical === recorded.path
  if (!same) return { ok: false, reason: 'moved', detail: 'PATH now resolves a different Codex CLI than the one setup checked' }
  if (!st.isFile || !sameIdentity(identityOf(canonical, st), recorded)) return { ok: false, reason: 'replaced', detail: 'the Codex CLI was replaced since setup checked it' }
  return { ok: true, executable: canonical }
}
