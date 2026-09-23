// The installed Claude Code version, cached.
//
// Needed because everything the managed launch relies on -- the realm roots the
// CLI honours, the authority manifest the sanitiser and the project gate read,
// the settings scopes the CLI actually applies -- was measured on ONE pinned
// version, and the managed-launch preflight has to say which side of that
// floor the user is on. See src/main/providers/claude/managed-launch.ts.
//
// It RESOLVES the binary rather than execing the bare name. That is not
// tidiness: claude-cli-probe.ts documents why a bare name is wrong here -- a
// GUI-launched Electron's PATH on macOS and Linux does not carry Homebrew, nvm
// or asdf, so `execFile('claude', ...)` reports "missing" for a CLI the user's
// login shell finds perfectly well. Getting that wrong would not fail safe: it
// would leave the version permanently `unknown` and put a blocking preflight
// finding on every managed launch for a user whose CLI is perfectly up to date.
// On macOS and Linux it resolves through `probeClaudeCli()`; on Windows, where
// a GUI app gets the user's full PATH, it walks that PATH in-process (see
// findClaudeOnWindowsPath for why not `where`).
//
// Deliberately NOT on the spawn path. A managed launch must not wait on a
// subprocess, and must not fail because one was slow: the preflight reports
// `unknown` until a probe has answered, which is a loud state rather than a
// silent pass. The probe runs at boot, and again on demand when something asks
// and the answer is still unknown.
import { execFile, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { logInfo, logWarn } from './debug-logger'
import { probeClaudeCli, type ClaudeCliProbe } from './claude-cli-probe'

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
 *  callers on a launch path that must not wait -- `null` means "no version
 *  yet" (not probed, or the probe could not run the CLI), never "old" and
 *  never "fine". */
export function peekClaudeCliVersion(): string | null {
  return cached
}

/** A drive-absolute (`C:\`) or UNC (`\\server\share`) Windows path -- never a
 *  relative, drive-relative (`C:x`) or device-namespace (`\\?\`, `\\.\`, in
 *  either slash, or the bare `\\?` / `\\.` roots) one, none of which cmd.exe
 *  can run from or which resolve against a current directory. One rule for
 *  every path this module runs. */
function isWindowsAbsolute(p: string | undefined): p is string {
  return !!p && /^([A-Za-z]:[\\/]|\\\\)/.test(p) && !/^[\\/]{2}[?.]([\\/]|$)/.test(p)
}

/** Find the CLI on a Windows PATH IN-PROCESS, in the order the managed launch
 *  asks `where` for it (`resolveClaudeBinary`: `claude.exe` anywhere on the
 *  PATH first, then `claude.cmd`). `.bat` is looked for last, which the launch
 *  never asks for.
 *
 *  Not `where` itself: it writes its answer in the console's OEM code page,
 *  which the UTF-8 decode turns into U+FFFD (and CJK into `?`), so every
 *  install under a profile name like `José` resolved to a path that does not
 *  exist and the version stayed unknown -- the same permanent finding as the
 *  shim bug below. This also skips what `where` would search and a launch
 *  could not safely run from: the current directory, relative, drive-relative,
 *  unexpanded (`%VAR%`) and device-namespace entries. So the two can differ
 *  there, for a `.bat`, and for a non-ASCII install path, which the launch's
 *  own `where` still mangles (a recorded follow-up). A trailing dot or space is
 *  dropped from an entry, as Windows path normalisation does.
 *
 *  ASYNC, one stat at a time: a PATH entry on a dead network share can hold a
 *  stat for tens of seconds, which must not be the main process's event loop;
 *  and a folder that could not be reached at all is not asked again for the
 *  next name.
 *
 *  Exported for the test. */
export async function findClaudeOnWindowsPath(
  pathVar: string | undefined,
  statFile: (p: string) => Promise<'file' | 'none' | 'unreachable'>,
): Promise<string | null> {
  const dirs = (pathVar ?? '').split(';')
    // Only after a real name character: `C:\a\..` is the parent, not `C:\a\`.
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1').replace(/([^\\/.])[. ]+$/, '$1'))
    .filter((d) => d !== '' && !d.includes('%') && isWindowsAbsolute(d))
  const unreachable = new Set<string>()
  for (const name of ['claude.exe', 'claude.cmd', 'claude.bat']) {
    for (const dir of dirs) {
      if (unreachable.has(dir)) continue
      const candidate = path.win32.join(dir, name)
      const found = await statFile(candidate)
      if (found === 'file') return candidate
      if (found === 'unreachable') unreachable.add(dir)
    }
  }
  return null
}

/** `none` for an answer that says the file is not there (or is not a file);
 *  `unreachable` for anything else -- a share that did not answer, a denied
 *  folder -- so the walk stops asking that folder. */
async function statRegularFile(p: string): Promise<'file' | 'none' | 'unreachable'> {
  try {
    return (await fs.promises.stat(p)).isFile() ? 'file' : 'none'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'none' : 'unreachable'
  }
}

/** How to run `<resolved> --version`, or why it will not be run.
 *
 *  A resolved EXECUTABLE is run directly, with no shell, which keeps a path
 *  with a space in it out of a shell's word splitting.
 *
 *  A Windows `.cmd` / `.bat` shim -- what `npm install -g` puts on the PATH --
 *  cannot be run that way at all: since the CVE-2024-27980 fix Node refuses to
 *  spawn a batch file without a shell and throws EINVAL. Found on the packaged
 *  app on a Windows VM: every probe threw, the version stayed `unknown`, and
 *  every managed launch carried a blocking "not yet verified" finding for a
 *  current CLI. So a shim is run through cmd.exe the way Node itself runs a
 *  `shell: true` command (`/d /s /c "<line>"`, verbatim), with the path
 *  quoted, AutoRun skipped (`/d`) and delayed expansion off (`/v:off`).
 *
 *  Inside those quotes cmd.exe takes `& ^ ( )` literally, but it still acts on
 *  `%` and a `"` -- and the shim npm writes then re-reads its OWN folder
 *  unquoted (`SET dp0=%~dp0`), where an `&` or `^` in a folder name is a
 *  command separator or an escape again. A shim path carrying any of
 *  `" % & ^` or a control character is therefore NOT run: the version stays
 *  unknown, the loud state. (With an `&` or `^` the shim could not have found
 *  the CLI anyway: its own folder is cut or mangled when it re-reads it.)
 *
 *  The shim runs in its own folder with NoDefaultCurrentDirectoryInExePath
 *  set, so the bare `node` it starts cannot come from whatever directory the
 *  app happens to run in; cmd.exe itself is the absolute System32 one unless
 *  ComSpec names a cmd.exe by absolute path (Node applies the same "is it
 *  cmd.exe" test before using these switches, which mean something else to
 *  any other shell).
 *
 *  Exported for the test. */
export function versionProbeCommand(
  resolved: string,
  platform: NodeJS.Platform,
  env: { ComSpec?: string; SystemRoot?: string },
):
  | { file: string; args: string[]; verbatim: boolean; viaCmd: boolean; cwd?: string; env?: Record<string, string> }
  | { refused: string } {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(resolved)) {
    return { file: resolved, args: ['--version'], verbatim: false, viaCmd: false }
  }
  // eslint-disable-next-line no-control-regex
  if (/["%&^\x00-\x1f]/.test(resolved)) {
    return { refused: 'the shim path carries a character cmd.exe or the shim would re-read (" % & ^ or a control character)' }
  }
  const absoluteCmd = (p: string | undefined): p is string => isWindowsAbsolute(p) && /[\\/]cmd\.exe$/i.test(p)
  const system32 = env.SystemRoot ? path.win32.join(env.SystemRoot, 'System32', 'cmd.exe') : undefined
  const shell = absoluteCmd(env.ComSpec) ? env.ComSpec : absoluteCmd(system32) ? system32 : 'cmd.exe'
  return {
    file: shell,
    args: ['/d', '/v:off', '/s', '/c', `""${resolved}" --version"`],
    verbatim: true,
    viaCmd: true,
    cwd: path.win32.dirname(resolved),
    env: { NoDefaultCurrentDirectoryInExePath: '1' },
  }
}

/** A probe that has not answered in this long counts as failed and is killed. */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000
let probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS

/** Stop a probe that did not answer in time. The probe is already SETTLED by
 *  then (see runVersionProbe): a descendant holding stdout open would keep
 *  execFile's callback from ever firing, and an unsettled probe pins
 *  `inFlight` for the life of the app.
 *
 *  Through cmd.exe the CLI is a GRANDCHILD. `taskkill /T` can only find that
 *  tree while cmd.exe is alive and still its root, so it runs FIRST and cmd.exe
 *  is killed from its callback. Nothing is killed once the child has EXITED:
 *  its pid is Windows's to reuse, and `/T` against a reused pid would take a
 *  stranger's tree. The streams are destroyed either way, so a survivor
 *  holding them cannot keep the probe's handles open. Best-effort, never
 *  throws. */
function abandonProbe(child: ChildProcess | undefined, exited: boolean, viaCmd: boolean): void {
  if (!child) return
  const kill = (): void => { try { child.kill() } catch { /* best-effort */ } }
  try {
    const root = process.env.SystemRoot
    if (!exited && viaCmd && child.pid && process.platform === 'win32' && isWindowsAbsolute(root)) {
      execFile(path.win32.join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 5_000, cwd: root }, () => kill())
    } else if (!exited) {
      kill()
    }
    child.stdout?.destroy()
    child.stderr?.destroy()
  } catch { /* best-effort */ }
}

async function resolveForVersionProbe(): Promise<ClaudeCliProbe> {
  if (process.platform !== 'win32') return probeClaudeCli()
  const found = await findClaudeOnWindowsPath(process.env.PATH, statRegularFile)
  const probe = 'PATH walk (claude.exe, claude.cmd, claude.bat)'
  return found ? { installed: true, path: found, probe } : { installed: false, probe }
}

function runVersionProbe(): Promise<string | null> {
  return resolveForVersionProbe().then((probe) => new Promise<string | null>((resolve) => {
    if (!probe.installed || !probe.path) {
      logWarn(`[claude-version] no Claude CLI resolved (${probe.probe}); version stays unknown`)
      resolve(null)
      return
    }
    const command = versionProbeCommand(probe.path, process.platform, { ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot })
    if ('refused' in command) {
      logWarn(`[claude-version] not running ${probe.path}: ${command.refused}; version stays unknown`)
      resolve(null)
      return
    }
    try {
      // Settled exactly once, by whichever comes first: the answer or the
      // timer. After that the timer can kill nothing (see abandonProbe).
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (v: string | null): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(v)
      }
      const child = execFile(
        command.file,
        command.args,
        {
          encoding: 'utf-8',
          windowsHide: true,
          windowsVerbatimArguments: command.verbatim,
          ...(command.cwd ? { cwd: command.cwd } : {}),
          ...(command.env ? { env: { ...process.env, ...command.env } } : {}),
        },
        (err, stdout) => {
          if (settled) return
          if (err) { logWarn(`[claude-version] probe failed: ${err.message}`); settle(null); return }
          const v = parseClaudeCliVersion(String(stdout ?? ''))
          if (v) logInfo(`[claude-version] installed Claude Code ${v} (${probe.path})`)
          else logWarn('[claude-version] probe returned no recognisable version')
          settle(v)
        },
      )
      if (!settled) {
        timer = setTimeout(() => {
          if (settled) return
          logWarn(`[claude-version] probe timed out after ${probeTimeoutMs} ms (${probe.path})`)
          settle(null)
          // Node sets exitCode / signalCode before it emits 'exit' and before it
          // releases the process handle, so while both are null the pid is
          // still this child's.
          abandonProbe(child, child?.exitCode != null || child?.signalCode != null, command.viaCmd)
        }, probeTimeoutMs)
        timer.unref?.()
      }
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
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS
}

/** Test-only: a shorter probe timeout, so a real-process test can prove a hung
 *  probe settles and leaves nothing running. Reset by the function above. */
export function _setProbeTimeoutForTest(ms: number): void {
  probeTimeoutMs = ms
}
