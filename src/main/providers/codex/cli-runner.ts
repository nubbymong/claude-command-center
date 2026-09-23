// The one way this app runs the Codex CLI outside a terminal session (WP2,
// plan A6, A8; design 8.4, 9.2; owner decision D3). Only a fixed set of
// operations exists -- the argv is a constant per operation, so no user or
// provider text ever reaches a command line -- and every run gets the
// allowlisted environment the caller built with codexCliEnv.
//
// A Windows `.cmd` shim (what `npm install -g` puts on PATH) cannot be spawned
// without a shell since the CVE-2024-27980 fix, so it goes through cmd.exe
// exactly as src/main/claude-cli-version.ts runs Claude's shim: the absolute
// System32 cmd.exe (or an absolute ComSpec naming cmd.exe), `/d /v:off /s /c`
// with the path quoted, verbatim arguments, started in the shim's own folder.
// A shim path carrying `" % & ^` or a control character is refused: cmd.exe
// still acts on `%` and `"` inside quotes, and the shim re-reads its own
// folder unquoted, where `&` and `^` are syntax again.
//
// A run settles on close, on a spawn error, at its deadline or on cancel --
// whichever is first. At the deadline or on cancel the whole process tree is
// killed (cmd.exe -> node -> codex would otherwise outlive a cancelled
// sign-in), but only while its root is still running: a pid is not killed
// once it may have been reused. See runCodexCli.
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

export type CodexCliOperation = 'version' | 'status' | 'logout' | 'login-browser' | 'login-device' | 'login-api-key'

const ARGS: Readonly<Record<CodexCliOperation, readonly string[]>> = {
  'version': ['--version'],
  'status': ['login', 'status'],
  'logout': ['logout'],
  'login-browser': ['login'],
  'login-device': ['login', '--device-auth'],
  // The key arrives on stdin, never here (the pinned CLI refuses a TTY stdin).
  'login-api-key': ['login', '--with-api-key'],
}

export interface CodexCommand {
  file: string
  args: string[]
  /** Pass args to CreateProcess untouched (the cmd.exe line is pre-quoted). */
  verbatim: boolean
  cwd: string
}

const isWindowsAbsolute = (p: string | undefined): p is string => !!p && /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/?.])/.test(p)

/** How to run one operation against one resolved executable, or why not. */
export function codexCommandLine(
  executable: string,
  operation: CodexCliOperation,
  platform: NodeJS.Platform,
  env: { ComSpec?: string; SystemRoot?: string },
): CodexCommand | { refused: string } {
  const args = ARGS[operation]
  if (!args) return { refused: 'not a Codex CLI operation this app runs' }
  if (typeof executable !== 'string' || !executable) return { refused: 'no Codex executable' }
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (!pathApi.isAbsolute(executable)) return { refused: 'the Codex executable path is not absolute' }
  if (platform === 'win32') {
    // A drive or a share, never `\x` (the current drive), `\\?\` or `\\.\`;
    // and no trailing dot or space, which Windows drops -- `codex.cmd.` must
    // not dodge the shim route below.
    if (!/^([A-Za-z]:\\|\\\\[^\\?.][^\\]*\\[^\\]+\\)/.test(executable)) return { refused: 'the Codex executable is not on a drive or a share' }
    if (/[. ]$/.test(executable)) return { refused: 'the Codex executable name ends in a dot or a space' }
  }
  const cwd = pathApi.dirname(executable)
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) {
    return { file: executable, args: [...args], verbatim: false, cwd }
  }
  // eslint-disable-next-line no-control-regex
  if (/["%&^\x00-\x1f]/.test(executable)) {
    return { refused: 'the Codex shim path carries a character cmd.exe or the shim would re-read (" % & ^ or a control character)' }
  }
  const absoluteCmd = (p: string | undefined): p is string => isWindowsAbsolute(p) && /[\\/]cmd\.exe$/i.test(p)
  const system32 = env.SystemRoot ? path.win32.join(env.SystemRoot, 'System32', 'cmd.exe') : undefined
  const shell = absoluteCmd(env.ComSpec) ? env.ComSpec : absoluteCmd(system32) ? system32 : null
  if (!shell) return { refused: 'no absolute cmd.exe to run the Codex shim with (SystemRoot is not set)' }
  return { file: shell, args: ['/d', '/v:off', '/s', '/c', `""${executable}" ${args.join(' ')}"`], verbatim: true, cwd }
}

export interface CodexRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Output beyond the cap was dropped. */
  truncated: boolean
  /** The process could not be started (the message is the spawn error's). */
  spawnError?: string
}

export interface CodexRunOptions {
  env: Record<string, string>
  timeoutMs: number
  /** Written to the child's stdin pipe once, then closed. Absent: stdin is ignored. */
  stdin?: string
  /** Per stream; the rest is dropped (default 64 KiB). */
  maxOutput?: number
  onOutput?: (text: string, stream: 'stdout' | 'stderr') => void
  signal?: AbortSignal
}

export interface CodexRunDeps {
  spawn: (file: string, args: readonly string[], opts: SpawnOptions) => ChildProcess
  platform: NodeJS.Platform
  /** Kill a process and everything it started. */
  killTree: (child: ChildProcess) => void
}

/** Exported for the test: the tree kill with its guards. */
export function makeCodexKillTree(platform: NodeJS.Platform, spawn: CodexRunDeps['spawn'], systemRoot: string | undefined): (child: ChildProcess) => void {
  return (child) => {
    const pid = child.pid
    // Only a process that is still running: once the root has exited its pid
    // can be reused, and a tree kill by pid would hit a stranger.
    if (!pid || child.exitCode !== null || child.signalCode !== null) return
    try {
      if (platform === 'win32') {
        // taskkill only from an absolute Windows root, run there, bounded; no
        // search of the current directory or PATH for a bare name.
        if (!systemRoot || !isWindowsAbsolute(systemRoot)) { child.kill(); return }
        const taskkill = path.win32.join(systemRoot, 'System32', 'taskkill.exe')
        const k = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, cwd: systemRoot, timeout: 5000 })
        k.on('error', () => { try { child.kill() } catch { /* gone */ } })
      } else {
        // The child leads its own process group (detached below).
        process.kill(-pid, 'SIGKILL')
      }
    } catch {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
  }
}

export function defaultCodexRunDeps(platform: NodeJS.Platform = process.platform, systemRoot = process.env.SystemRoot): CodexRunDeps {
  return { spawn: nodeSpawn, platform, killTree: makeCodexKillTree(platform, nodeSpawn, systemRoot) }
}

const MAX_TIMEOUT_MS = 2_147_483_647

/** Run one prepared command. Never rejects.
 *
 *  Settles on `close`; at the deadline or on cancel it settles at once. A
 *  process tree is killed only while its root is still running -- if the root
 *  has exited but a descendant holds its output open (a browser a sign-in
 *  opened), the run settles with the root's exit code and the streams are
 *  destroyed instead. Nothing is reported after the run has settled. */
export function runCodexCli(cmd: CodexCommand, opts: CodexRunOptions, deps: CodexRunDeps = defaultCodexRunDeps()): Promise<CodexRunResult> {
  const cap = opts.maxOutput ?? 64 * 1024
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let child: ChildProcess | null = null
    let exited: number | null | undefined
    const finish = (r: Omit<CodexRunResult, 'stdout' | 'stderr' | 'truncated'>) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ ...r, stdout, stderr, truncated })
    }
    const release = () => {
      try { child?.stdout?.destroy() } catch { /* already closed */ }
      try { child?.stderr?.destroy() } catch { /* already closed */ }
      try { child?.stdin?.destroy() } catch { /* already closed */ }
    }
    const stop = (why: 'deadline' | 'cancel') => {
      if (settled || !child) return
      if (exited !== undefined) {
        // The root is gone; only its output pipes remain. Do not kill by pid.
        release()
        finish({ exitCode: exited, timedOut: false })
        return
      }
      try { deps.killTree(child) } catch { /* best effort */ }
      release()
      finish(why === 'deadline' ? { exitCode: null, timedOut: true } : { exitCode: null, timedOut: false, spawnError: 'cancelled' })
    }
    const onAbort = () => stop('cancel')

    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1 || opts.timeoutMs > MAX_TIMEOUT_MS) {
      finish({ exitCode: null, timedOut: false, spawnError: 'invalid timeout' })
      return
    }
    if (opts.signal?.aborted) {
      finish({ exitCode: null, timedOut: false, spawnError: 'cancelled' })
      return
    }
    // A prototype-free copy of exactly the caller's own variables: spawn walks
    // inherited keys, so a polluted Object.prototype must add nothing.
    const env: Record<string, string> = Object.create(null) as Record<string, string>
    for (const k of Object.keys(opts.env)) if (typeof opts.env[k] === 'string') env[k] = opts.env[k]
    try {
      child = deps.spawn(cmd.file, cmd.args, {
        cwd: cmd.cwd,
        env,
        stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: cmd.verbatim,
        shell: false,
        // POSIX: lead a process group so the whole tree can be killed.
        detached: deps.platform !== 'win32',
      })
    } catch (e) {
      finish({ exitCode: null, timedOut: false, spawnError: e instanceof Error ? e.message : String(e) })
      return
    }
    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
      if (settled) return
      const text = chunk.toString()
      const have = stream === 'stdout' ? stdout.length : stderr.length
      const room = Math.max(0, cap - have)
      if (text.length > room) truncated = true
      const kept = text.slice(0, room)
      if (stream === 'stdout') stdout += kept
      else stderr += kept
      if (kept) { try { opts.onOutput?.(kept, stream) } catch { /* a consumer never breaks the run */ } }
    }
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', collect('stdout'))
    child.stderr?.on('data', collect('stderr'))
    child.on('exit', (code) => { exited = typeof code === 'number' ? code : null })
    child.on('error', (e) => finish({ exitCode: null, timedOut: false, spawnError: e.message }))
    child.on('close', (code) => finish({ exitCode: typeof code === 'number' ? code : null, timedOut: false }))
    timer = setTimeout(() => stop('deadline'), opts.timeoutMs)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* the child closed its stdin early; its exit code tells */ })
      child.stdin.end(opts.stdin)
    }
  })
}
