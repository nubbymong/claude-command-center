import { execFile } from 'child_process'
import * as os from 'os'
import { logInfo } from './debug-logger'
import { findOnPosixPath, findOnPosixPathAsync, loginShellPathAsync, loginShellPathSync, loginShellWithOwnPath, shFamilyLoginShell } from './login-shell'
import { findOnWindowsPathAsync, windowsEnvValue } from './windows-programs'

/**
 * Is the `claude` CLI actually INSTALLED on this machine?
 *
 * Not to be confused with `isCliReady()` in setup-handlers, which asks a
 * different question -- "has Claude been told to trust the install folder?" --
 * and answers it by looking for a folder under `~/.claude/projects/`. That
 * check passes vacuously when the CLI is absent, because a machine with no
 * `claude` binary also has no trusted project for it. First-run setup used to
 * push straight past step 2 on such a machine, spawn a PTY that printed
 * "'claude' is not recognized", and drop the user into an app in which nothing
 * can ever launch (#, phase 7 item B).
 *
 * `resolveClaudeBinary()` cannot answer it either: off Windows it returns a
 * name or a path without asking whether the file exists, which is the right
 * answer for a spawn and the wrong one for a gate.
 *
 * So probe for real, and probe the way the setup PTY will actually launch it:
 *   - Windows: claude.exe / claude.cmd / claude.bat found in-process in the
 *     folders PATH names (windows-programs.ts), no process at all.
 *   - POSIX: what a Claude session's launcher will run. A login shell outside
 *     the sh family (written for fish and PowerShell 7.3 or later) is asked
 *     for the PATH it builds, and Claude Code is looked for in that PATH's
 *     absolute folders (claudeInLoginShellPathAsync), as the launch names it.
 *     Otherwise, when it reports no PATH, or when Claude Code is not in it,
 *     the launcher's own sh-family LOGIN shell answers
 *     (`<shell> -lc 'command -v claude'`), so PATH picks up Homebrew, nvm, asdf
 *     and friends. A plain `which` from Electron's own environment would
 *     report "missing" for a CLI the login shell can see perfectly well.
 *     `which` is only the fallback if the login shell probe cannot run.
 *
 * ASYNC, and that is a security property rather than a style choice
 * (adversarial review, 2026-09-01 — DoS). This used to be `execFileSync`: up to
 * THREE sequential 8s probes, each of which BLOCKS the main process outright —
 * no IPC served, no PTY data pumped, no window repainted, for up to 24 seconds.
 * `setup:probeCli` is an ungated renderer channel, so any renderer could freeze
 * the whole app on demand simply by invoking it; and even in normal use a
 * hanging login shell (a slow network mount in an rc file is the classic) stalls
 * the app rather than one dialog. `execFile` answers the same question on the
 * event loop, and overlapping calls coalesce onto ONE probe (see `inFlight`), so
 * a loop of invocations costs one process set instead of three per call.
 */
export interface ClaudeCliProbe {
  /** True only when a probe actually resolved a path. Fail-closed on error. */
  installed: boolean
  /** The resolved path, when one was found. */
  path?: string
  /** Which probe answered (or last failed) -- for the log and the notice. */
  probe: string
}

/** Trim, take the first line, and reject the empty/whitespace answer. */
function firstLine(out: string | Buffer): string | null {
  const line = out.toString().split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0)
  return line || null
}

/**
 * Run one probe candidate and resolve its first output line, or null.
 *
 * Never rejects: a non-zero exit (the `where`/`command -v` miss), a missing
 * binary, a timeout kill and a synchronous spawn throw are all the same answer
 * to this function's question — "no". stderr is captured by execFile rather than
 * inherited, so a probe miss cannot leak "INFO: Could not find files..." into
 * whatever terminal launched the app (the job the old `stdio` option did).
 */
function probeOnce(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        bin,
        args,
        { encoding: 'utf-8', timeout: 8000, windowsHide: true },
        (err, stdout) => resolve(err ? null : firstLine(stdout ?? '')),
      )
    } catch {
      resolve(null)
    }
  })
}

/** The names Claude Code goes by on Windows, in the order every check and
 *  every start asks them: claude.exe in any folder PATH names, then
 *  claude.cmd, then claude.bat (claude-cli-version.ts findClaudeOnWindowsPath's
 *  order). One list, so a check never says installed for a program no start
 *  would run. */
export const CLAUDE_WINDOWS_NAMES: readonly string[] = Object.freeze(['claude.exe', 'claude.cmd', 'claude.bat'])

/** What a check or a start says when Claude Code is in none of PATH's folders. */
export const CLAUDE_NOT_ON_PATH = `Claude Code was not found in a folder PATH names (${CLAUDE_WINDOWS_NAMES.join(', ')})`

/** How long an answer of findClaudeOnWindowsAsync is reused by
 *  recentClaudeOnWindows. The CLI check asks every 30 s while the app runs. */
export const CLAUDE_LOOKUP_REUSE_MS = 60_000

/** Recent finds, by the PATH value each was found under (a profile run's PATH
 *  differs from the app's: it adds the profile's own folder). A few only. */
const recentLookups = new Map<string, { found: string; at: number }>()
const RECENT_LOOKUPS_KEPT = 8

/** Claude Code on Windows, found IN-PROCESS in the folders PATH names (`env`),
 *  in CLAUDE_WINDOWS_NAMES order, one stat at a time off the event loop
 *  (windows-programs.ts findOnWindowsPathAsync); null when none is there.
 *  A found path is kept for recentClaudeOnWindows. */
export async function findClaudeOnWindowsAsync(
  env: NodeJS.ProcessEnv,
  stat?: (p: string) => Promise<boolean>,
  now: () => number = Date.now,
): Promise<string | null> {
  const pathValue = windowsEnvValue(env, 'PATH') ?? ''
  const found = await findOnWindowsPathAsync(CLAUDE_WINDOWS_NAMES, env, stat, 'name')
  recordClaudeOnWindows(pathValue, found, now())
  return found
}

/** Keep an answer of a PATH walk for Claude Code under `pathValue`; a walk
 *  that found nothing forgets what was kept for it. */
export function recordClaudeOnWindows(pathValue: string, found: string | null, at: number): void {
  recentLookups.delete(pathValue)
  if (!found) return
  recentLookups.set(pathValue, { found, at })
  while (recentLookups.size > RECENT_LOOKUPS_KEPT) recentLookups.delete(recentLookups.keys().next().value as string)
}

/** The Claude Code a walk of the same PATH value found less than
 *  CLAUDE_LOOKUP_REUSE_MS ago, or null. Synchronous and reads no file, so a
 *  caller that cannot wait (the session launch) skips the walk while the
 *  answer is recent. */
export function recentClaudeOnWindows(env: NodeJS.ProcessEnv, now: () => number = Date.now): string | null {
  const kept = recentLookups.get(windowsEnvValue(env, 'PATH') ?? '')
  if (!kept) return null
  const age = now() - kept.at
  return age >= 0 && age < CLAUDE_LOOKUP_REUSE_MS ? kept.found : null
}

/** Test seam: forget every answer. */
export function _resetClaudeWindowsLookupForTest(): void {
  recentLookups.clear()
}

/** The Windows probe: an in-process walk of PATH's folders, no process. */
const WINDOWS_PROBE = `PATH walk (${CLAUDE_WINDOWS_NAMES.join(', ')})`

async function runProbe(): Promise<ClaudeCliProbe> {
  if (os.platform() === 'win32') {
    // claude.exe in any folder PATH names, then claude.cmd, then claude.bat
    // (claude-cli-version.ts findClaudeOnWindowsPath's order), each a full
    // path in a fully qualified folder; one stat at a time off the event loop.
    const found = await findClaudeOnWindowsAsync(process.env)
    if (found) {
      logInfo(`[setup] Claude CLI found: ${found} (${WINDOWS_PROBE})`)
      return { installed: true, path: found, probe: WINDOWS_PROBE }
    }
    logInfo(`[setup] Claude CLI NOT found (${WINDOWS_PROBE})`)
    return { installed: false, probe: WINDOWS_PROBE }
  }

  // os.platform(), not the helper's process.platform default: this file gates
  // on os.platform() above, and the two must agree (they differ only under a
  // test's os mock, which is exactly when it matters).
  // Asked only of a login shell outside the sh family; a sh-family user's
  // probe goes straight to its own login shell, as before.
  const own = loginShellWithOwnPath(process.env, os.platform()) ? await claudeInLoginShellPathAsync(process.env, os.platform()) : null
  if (own?.claude) {
    logInfo(`[setup] Claude CLI found: ${own.claude} (the login shell's PATH)`)
    return { installed: true, path: own.claude, probe: 'login shell PATH' }
  }
  const shell = shFamilyLoginShell(process.env, os.platform())
  const viaLoginShell = await probeOnce(shell, ['-lc', 'command -v claude'])
  if (viaLoginShell) {
    logInfo(`[setup] Claude CLI found: ${viaLoginShell} (${shell} -lc "command -v claude")`)
    return { installed: true, path: viaLoginShell, probe: `${shell} -lc 'command -v claude'` }
  }

  const viaWhich = await probeOnce('which', ['claude'])
  if (viaWhich) {
    logInfo(`[setup] Claude CLI found: ${viaWhich} (which claude)`)
    return { installed: true, path: viaWhich, probe: 'which claude' }
  }

  logInfo('[setup] Claude CLI NOT found (login shell and `which` both missed)')
  return { installed: false, probe: 'command -v claude' }
}

/**
 * The single probe a set of overlapping callers share.
 *
 * `setup:probeCli` is invoked from a dialog that can be clicked repeatedly (and
 * from an effect that can re-fire), so without this a user — or a renderer loop —
 * multiplies the process count by the call count for an answer that cannot
 * change between two calls a millisecond apart. Cleared on settle, so the NEXT
 * call after an install genuinely re-probes; this coalesces concurrent work, it
 * does not cache a result.
 */
let inFlight: Promise<ClaudeCliProbe> | null = null

export function probeClaudeCli(): Promise<ClaudeCliProbe> {
  if (inFlight) return inFlight
  const run = runProbe().then(
    (result) => { inFlight = null; return result },
    (err) => { inFlight = null; throw err },
  )
  inFlight = run
  return run
}

/** Test seam: drop a probe still in flight so cases cannot bleed into each other. */
export function _resetClaudeCliProbeForTest(): void {
  inFlight = null
}

/** Off Windows, for a user whose login shell is not of the sh family (fish
 *  and PowerShell 7.3 or later report it; another such shell may report
 *  none): the PATH that shell builds, and the Claude Code found in it (null
 *  when it is in none of its absolute folders). A Claude session's launcher
 *  is a sh-family shell
 *  (shFamilyLoginShell), so it carries this PATH and names this Claude Code
 *  (providers/claude/spawn.ts), and the CLI checks ask the same question. */
export interface ClaudeInLoginShellPath {
  path: string
  claude: string | null
}

/** The last answer, for the login shell and the PATH it was asked under;
 *  `answer` null when that shell gave none. */
let lastLoginShellAnswer: { key: string; answer: ClaudeInLoginShellPath | null; at: number } | null = null

function loginShellAnswerKey(shell: string, env: NodeJS.ProcessEnv): string {
  return `${shell}\0${env.PATH ?? ''}`
}

/** The user's login shell's PATH and the Claude Code in it, asked off the
 *  event loop; null when the login shell is of the sh family (or on Windows)
 *  or gave no answer. The answer is kept for recentClaudeInLoginShellPath. */
export async function claudeInLoginShellPathAsync(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = os.platform(),
  now: () => number = Date.now,
): Promise<ClaudeInLoginShellPath | null> {
  const shell = loginShellWithOwnPath(env, platform)
  if (!shell) return null
  const path = await loginShellPathAsync(shell, env)
  const answer = path ? { path, claude: await findOnPosixPathAsync('claude', path) } : null
  lastLoginShellAnswer = { key: loginShellAnswerKey(shell, env), answer, at: now() }
  return answer
}

/** The answer claudeInLoginShellPathAsync (or a launch) got less than
 *  CLAUDE_LOOKUP_REUSE_MS ago for the same login shell and PATH: the answer,
 *  null when that shell gave none, undefined when there is no recent one (or
 *  the login shell is of the sh family). Synchronous; starts no process. */
export function recentClaudeInLoginShellPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = os.platform(),
  now: () => number = Date.now,
): ClaudeInLoginShellPath | null | undefined {
  const shell = loginShellWithOwnPath(env, platform)
  if (!shell || !lastLoginShellAnswer || lastLoginShellAnswer.key !== loginShellAnswerKey(shell, env)) return undefined
  const age = now() - lastLoginShellAnswer.at
  return age >= 0 && age < CLAUDE_LOOKUP_REUSE_MS ? lastLoginShellAnswer.answer : undefined
}

/** For the session launch, which cannot wait: the recent answer, else the
 *  login shell asked on the event loop (bounded; its answer, or that it gave
 *  none, is kept, so this runs at most once per answer's life). Null as
 *  claudeInLoginShellPathAsync. */
export function claudeInLoginShellPathForLaunch(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = os.platform(),
  now: () => number = Date.now,
): ClaudeInLoginShellPath | null {
  const shell = loginShellWithOwnPath(env, platform)
  if (!shell) return null
  const recent = recentClaudeInLoginShellPath(env, platform, now)
  if (recent !== undefined) return recent
  const path = loginShellPathSync(shell, env)
  const answer = path ? { path, claude: findOnPosixPath('claude', path) } : null
  lastLoginShellAnswer = { key: loginShellAnswerKey(shell, env), answer, at: now() }
  return answer
}

/** Test seam: forget the last login-shell answer. */
export function _resetClaudeLoginShellLookupForTest(): void {
  lastLoginShellAnswer = null
}
