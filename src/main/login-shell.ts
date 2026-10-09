import { execFile, execFileSync } from 'child_process'
import { accessSync, constants as fsConstants, existsSync, statSync, promises as fsPromises } from 'fs'
import { homedir } from 'os'
import { posix as posixPath } from 'path'
import { systemTool } from './windows-programs'

/**
 * The login shell the CLI probes AND the local Claude session launch run
 * through on macOS/Linux, so `which claude` and the spawned session see the
 * PATH a user's shell profile builds (Homebrew, nvm, ~/.local/bin).
 *
 * `$SHELL` when the environment carries it. Without it the probes used to fall
 * back to `/bin/zsh` everywhere and the session launch to `/bin/bash`, so on a
 * Linux box without zsh the probe failed with ENOENT ("Claude CLI not found")
 * while the launch would have worked, and on one without bash the reverse
 * (final adversarial pass, 2.1.1). One rule for all of them: on macOS zsh, the
 * platform default since 10.15; elsewhere the first of bash, zsh, sh that
 * exists -- bash because it is the common Linux default and what the launch
 * always fell back to, zsh so a zsh-only box keeps working, `/bin/sh` because
 * every install has it. What PATH that shell builds is the user's profile's
 * business (a non-interactive `bash -l` reads ~/.profile, not ~/.bashrc). A
 * Claude session's launcher is always of the sh family (shFamilyLoginShell).
 * A login shell outside it is asked for the PATH it builds
 * (loginShellWithOwnPath, LOGIN_SHELL_PATH_COMMAND; written for fish and
 * PowerShell 7.3 or later): when it reports one, the launcher carries it;
 * when it reports none, the launcher's own login profile builds the PATH, as
 * for a sh-family user. The CLI checks ask the same question
 * (claude-cli-probe.ts), so the checks and the launch agree on what runs
 * either way.
 */
export function defaultLoginShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (env.SHELL) return env.SHELL
  if (platform === 'darwin') return '/bin/zsh'
  for (const candidate of ['/bin/bash', '/bin/zsh']) {
    if (exists(candidate)) return candidate
  }
  return '/bin/sh'
}

/** The shell a local session's PTY runs: Windows PowerShell on Windows, by its
 *  full path in the system folder (systemTool: it THROWS when SystemRoot is
 *  not a plain drive-absolute folder, so no session starts a shell by name);
 *  the login shell above elsewhere (defaultLoginShell, with the same
 *  environment and file test). */
export function localSessionShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  return platform === 'win32' ? systemTool('WindowsPowerShell\\v1.0\\powershell.exe', env) : defaultLoginShell(env, platform, exists)
}

/** The sh family, by name: the shells Alt+V types an image path into off
 *  Windows (PR-level ADR-009 round 1, A1). */
const SH_FAMILY = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/** PR-level ADR-009 round 1 (A1): whether `shell` (a path or a name) is one of
 *  the sh family by its basename: sh, bash, zsh, dash, ksh, and no other. */
export function isShFamilyShell(shell: string): boolean {
  if (typeof shell !== 'string') return false
  const base = shell.split(/[\\/]/).pop() ?? ''
  return SH_FAMILY.has(base)
}

/** The login shell a Claude session's launcher runs off Windows. The app
 *  types that session's launch line, written for the sh family, into it, so
 *  the line is only ever read by a shell of that family: the login shell
 *  above when it is one (isShFamilyShell), otherwise the same fallback with
 *  `$SHELL` set aside (macOS `/bin/zsh`; elsewhere the first of `/bin/bash`,
 *  `/bin/zsh` that exists, then `/bin/sh`). The launcher ends with the
 *  session, so nobody types into it; a terminal tab keeps the user's own
 *  shell (localSessionShell). */
export function shFamilyLoginShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  const shell = defaultLoginShell(env, platform, exists)
  return isShFamilyShell(shell) ? shell : defaultLoginShell({ ...env, SHELL: '' }, platform, exists)
}

/** The markers around the PATH a login shell reports (LOGIN_SHELL_PATH_COMMAND). */
const LOGIN_PATH_BEGIN = '__CCC_LOGIN_PATH_BEGIN__'
const LOGIN_PATH_END = '__CCC_LOGIN_PATH_END__'

/** What a login shell outside the sh family runs to report the PATH it
 *  builds: `/bin/sh`, started by its full path, prints PATH between two
 *  markers. The login shell itself only reads its own profile and starts
 *  `/bin/sh` with the environment it built: one program by its full path and
 *  one single-quoted word, which fish and PowerShell 7.3 or later pass on as
 *  written. Any other login shell outside the sh family is asked the same
 *  way; one that reports no PATH leaves the launch and the CLI checks on the
 *  launcher's own login profile, together. */
export const LOGIN_SHELL_PATH_COMMAND = `/bin/sh -c 'printf "%s%s%s" ${LOGIN_PATH_BEGIN} "$PATH" ${LOGIN_PATH_END}'`

/** A PATH value with only its absolute entries (`/...`), or null when none is. */
export function absolutePosixPathEntries(value: string): string | null {
  const kept = value.split(':').filter((p) => p.startsWith('/'))
  return kept.length ? kept.join(':') : null
}

/** The PATH between the markers in a login shell's output: a profile may
 *  print before or after it, so only the text between the LAST opening
 *  marker and the first closing marker after it counts, with only its
 *  absolute entries kept. Null when there is no such text. */
export function extractLoginShellPath(out: string): string | null {
  const open = out.lastIndexOf(LOGIN_PATH_BEGIN)
  if (open < 0) return null
  const start = open + LOGIN_PATH_BEGIN.length
  const end = out.indexOf(LOGIN_PATH_END, start)
  if (end < 0) return null
  const value = out.slice(start, end)
  if (!value || /[\r\n\0]/.test(value)) return null
  return absolutePosixPathEntries(value)
}

/** The login shell asked for the PATH a Claude session's launcher carries
 *  (when it reports one): the user's own (defaultLoginShell) when it is NOT
 *  of the sh family -- the case where the launcher is another shell
 *  (shFamilyLoginShell) -- else null: a sh-family user's launcher is their
 *  own shell, which builds its own PATH. */
export function loginShellWithOwnPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (platform === 'win32') return null
  const shell = defaultLoginShell(env, platform, exists)
  return isShFamilyShell(shell) ? null : shell
}

/** How the PATH question is put to `shell`: as a login shell (`-l`), the
 *  command as one argument, started directly (no shell parses `shell`), in
 *  the home folder, with `env`. */
function loginShellPathRun(shell: string, env: NodeJS.ProcessEnv): { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  return { file: shell, args: ['-l', '-c', LOGIN_SHELL_PATH_COMMAND], cwd: homedir(), env }
}

/** The PATH `shell` (a login shell outside the sh family) builds, asked off
 *  the event loop (at most `timeoutMs`); null when it did not answer. */
export function loginShellPathAsync(shell: string, env: NodeJS.ProcessEnv, timeoutMs = 8000): Promise<string | null> {
  const run = loginShellPathRun(shell, env)
  return new Promise((resolve) => {
    try {
      execFile(run.file, run.args, { cwd: run.cwd, env: run.env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : extractLoginShellPath(String(stdout ?? '')))
      })
    } catch {
      resolve(null)
    }
  })
}

/** loginShellPathAsync, for a caller that cannot wait: on the event loop,
 *  bounded by `timeoutMs`. Callers keep its answer (claude-cli-probe.ts), so
 *  it runs at most once per answer's life. */
export function loginShellPathSync(shell: string, env: NodeJS.ProcessEnv, timeoutMs = 3000): string | null {
  const run = loginShellPathRun(shell, env)
  try {
    const out = execFileSync(run.file, run.args, { cwd: run.cwd, env: run.env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return extractLoginShellPath(String(out ?? ''))
  } catch {
    return null
  }
}

/** A plain program name (no separator, not `.` or `..`). */
function plainProgramName(name: string): boolean {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0')
}

/** A file this process's user may run: a regular file, and run access for
 *  this user (not only a run bit for someone). */
function runnableFileSync(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function runnableFileAsync(p: string): Promise<boolean> {
  try {
    if (!(await fsPromises.stat(p)).isFile()) return false
    await fsPromises.access(p, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The full path of `name` in the first of PATH's absolute folders that holds
 *  it as a file this user may run, in PATH's order (what `command -v`
 *  answers, without a shell); null when none does. Never a bare or relative
 *  name. */
export function findOnPosixPath(name: string, pathValue: string, runnable: (p: string) => boolean = runnableFileSync): string | null {
  if (!plainProgramName(name)) return null
  for (const dir of pathValue.split(':')) {
    if (!dir.startsWith('/')) continue
    const file = posixPath.join(dir, name)
    if (runnable(file)) return file
  }
  return null
}

/** findOnPosixPath, one stat at a time off the event loop. */
export async function findOnPosixPathAsync(name: string, pathValue: string, runnable: (p: string) => Promise<boolean> = runnableFileAsync): Promise<string | null> {
  if (!plainProgramName(name)) return null
  for (const dir of pathValue.split(':')) {
    if (!dir.startsWith('/')) continue
    const file = posixPath.join(dir, name)
    if (await runnable(file)) return file
  }
  return null
}
