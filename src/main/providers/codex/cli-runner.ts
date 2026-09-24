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
// whichever is first. At the deadline or on cancel the run's OWN processes are
// killed -- the root and, below it, only the launcher and CLI images (cmd.exe
// -> node -> codex would otherwise outlive a cancelled sign-in) -- and never
// what the CLI started beyond them: a browser a sign-in opened is the user's.
// A stopped run settles only once that kill has landed (bounded), so a caller
// that holds a realm for the run does not let go while it still runs. Nothing
// is killed once the root has exited: its pid may have been reused. See
// runCodexCli and makeCodexKillTree.
import path from 'node:path'
import fs from 'node:fs'
import { spawn as nodeSpawn, execFile } from 'node:child_process'
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

/** ComSpec and SystemRoot from an environment COPY, for codexCommandLine.
 *  process.env looks names up case-insensitively on Windows; a plain-object
 *  copy of it does not, and a parent may spell them SYSTEMROOT and COMSPEC (a
 *  CI runner does). So on Windows they are matched the way Windows matches
 *  them -- ASCII names only (a long s upper-cases onto S) -- and two
 *  spellings that disagree are refused (absent), never guessed between. */
export function codexShellEnv(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): { ComSpec?: string; SystemRoot?: string } {
  const win = platform === 'win32'
  const pick = (name: string): string | undefined => {
    const values = new Set<string>()
    for (const k of Object.keys(env)) {
      const v = env[k]
      if (typeof v !== 'string' || v === '') continue
      if (win ? /^[A-Za-z]+$/.test(k) && k.toUpperCase() === name.toUpperCase() : k === name) values.add(v)
    }
    return values.size === 1 ? [...values][0] : undefined
  }
  const out: { ComSpec?: string; SystemRoot?: string } = {}
  const comSpec = pick('ComSpec')
  const systemRoot = pick('SystemRoot')
  if (comSpec !== undefined) out.ComSpec = comSpec
  if (systemRoot !== undefined) out.SystemRoot = systemRoot
  return out
}

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
  /** The run was stopped (cancel or deadline) -- also when its root had
   *  already exited and it settled with the root's own exit code: a
   *  descendant may have been cut off mid-line. */
  stopped?: 'cancel' | 'deadline'
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

/** Kills a run's own processes (see makeCodexKillTree). `prime`, when
 *  present, reads the run's chain once the run is established, so a kill
 *  whose own table read fails still names the whole chain. */
export type CodexKillTree = ((child: ChildProcess) => Promise<void> | void) & { prime?: (child: ChildProcess) => void }

export interface CodexRunDeps {
  spawn: (file: string, args: readonly string[], opts: SpawnOptions) => ChildProcess
  platform: NodeJS.Platform
  /** Kill the run's own processes (see makeCodexKillTree); the runner waits
   *  for the returned promise, bounded, before a stopped run settles. */
  killTree: CodexKillTree
}

/** One row of the process table. `created` is in milliseconds, when known. */
export interface CodexProcessEntry { pid: number; ppid: number; name: string; created?: number }

/** The images a run's own chain is made of: cmd.exe (the shim route), the
 *  JavaScript launchers a global install runs codex.js with (node, bun, deno)
 *  and codex and its own helpers. */
const CHAIN_IMAGE = /^(cmd\.exe|node|node\.exe|bun|bun\.exe|deno|deno\.exe|codex(?:[-._][a-z0-9._-]*)?)$/

/** Images that only wrap the codex binary and wait for it. */
const WRAPPER_IMAGE = /^(cmd\.exe|node|node\.exe|bun|bun\.exe|deno|deno\.exe)$/

/** The wrapper line alone: the root, then its ONLY chain child, down to the
 *  codex binary (cmd.exe -> node -> codex). Each member waits for the next,
 *  and Windows reuses no pid while a handle to it is open, so while the root
 *  runs this line is still this run's. Anything the codex binary started (a
 *  command runner, say) is left out: one it has already reaped may have
 *  handed its pid to a stranger. */
export function codexWrapperLinePids(rootPid: number, table: readonly CodexProcessEntry[]): number[] {
  const inChain = new Set(codexChainPids(rootPid, table))
  const byPid = new Map<number, CodexProcessEntry>()
  for (const e of table) if (e && inChain.has(e.pid)) byPid.set(e.pid, e)
  const image = (p: number) => ((byPid.get(p)?.name ?? '').split(/[\\/]/).pop() ?? '').trim().toLowerCase()
  const out = [rootPid]
  let cur = rootPid
  while (WRAPPER_IMAGE.test(image(cur))) {
    const kids = [...byPid.values()].filter((e) => e.ppid === cur && e.pid !== cur && !out.includes(e.pid))
    if (kids.length !== 1) break
    cur = kids[0].pid
    out.push(cur)
  }
  return out.reverse()
}

/** The processes a run owns: its root and, below it, only chain images. A
 *  process of any other image -- a browser the sign-in opened -- is not the
 *  run's, and nor is anything below it. A child that says it started before
 *  its parent is a stale parent id on a reused pid (Windows keeps the parent
 *  id of a process whose parent has exited), not a child. Leaves first.
 *  Exported for the test. */
export function codexChainPids(rootPid: number, table: readonly CodexProcessEntry[]): number[] {
  const byPid = new Map<number, CodexProcessEntry>()
  const children = new Map<number, CodexProcessEntry[]>()
  for (const e of table) {
    if (!e || !Number.isSafeInteger(e.pid) || !Number.isSafeInteger(e.ppid) || e.pid <= 0 || e.pid === e.ppid || typeof e.name !== 'string') continue
    byPid.set(e.pid, e)
    const list = children.get(e.ppid)
    if (list) list.push(e)
    else children.set(e.ppid, [e])
  }
  const out = [rootPid]
  const seen = new Set(out)
  for (let i = 0; i < out.length; i++) {
    const parent = byPid.get(out[i])
    for (const c of children.get(out[i]) ?? []) {
      if (seen.has(c.pid)) continue
      const image = (c.name.split(/[\\/]/).pop() ?? '').trim().toLowerCase()
      if (!CHAIN_IMAGE.test(image)) continue
      // Where the table knows start times, a child with none, or one before
      // its parent's, is not provably a child.
      if (parent?.created !== undefined && (c.created === undefined || c.created < parent.created)) continue
      seen.add(c.pid)
      out.push(c.pid)
    }
  }
  return out.reverse()
}

/** `pid,ppid,created,name` lines (created: a Windows FILETIME). Exported for the test. */
export function parseWindowsProcessTable(text: string): CodexProcessEntry[] {
  const out: CodexProcessEntry[] = []
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(\d+),(\d+),(\d+),(.+)$/.exec(line.trim())
    if (!m) continue
    // FILETIME counts 100 ns steps: whole milliseconds fit a double exactly.
    const created = m[3] === '0' ? undefined : Number(BigInt(m[3]) / 10000n)
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[4], ...(created !== undefined ? { created } : {}) })
  }
  return out
}

/** One `/proc/<pid>/stat` line: `pid (comm) state ppid ... starttime ...`.
 *  The name is between the FIRST `(` and the LAST `)` -- it may itself hold
 *  spaces and parentheses. `created` is the start time in clock ticks, which
 *  orders processes like any other time. Exported for the test. */
export function parseLinuxStat(text: string): CodexProcessEntry | null {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 1 || close < open) return null
  const pid = Number(text.slice(0, open).trim())
  const rest = text.slice(close + 1).trim().split(/\s+/)
  const ppid = Number(rest[1])
  const created = Number(rest[19])
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) return null
  return { pid, ppid, name: text.slice(open + 1, close), ...(Number.isFinite(created) ? { created } : {}) }
}

/** `ps -o pid= -o ppid= -o comm=` lines; macOS prints the image path, which
 *  may hold spaces. Exported for the test. */
export function parsePosixProcessTable(text: string): CodexProcessEntry[] {
  const out: CodexProcessEntry[] = []
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] })
  }
  return out
}

/** A constant query with no double quote in it: passed as plain -Command
 *  text (an encoded command is what endpoint protection flags). */
export const WINDOWS_PROCESS_QUERY = "Get-CimInstance Win32_Process | ForEach-Object { $c = 0; if ($_.CreationDate) { $c = $_.CreationDate.ToFileTimeUtc() }; '{0},{1},{2},{3}' -f $_.ProcessId, $_.ParentProcessId, $c, $_.Name }"
/** How long reading the process table may take at kill time. */
export const CODEX_PROCESS_TABLE_TIMEOUT_MS = 8000
/** How long the EARLY read (see CodexKillTree.prime) may take: it runs in the
 *  background, so a loaded machine gets far longer than a kill can wait. */
export const CODEX_PRIME_TABLE_TIMEOUT_MS = 30_000
/** How long taskkill may take. */
export const CODEX_TASKKILL_TIMEOUT_MS = 5000

type ExecFileLike = (file: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => unknown

/** How the real process table is read: PowerShell's CIM query from the
 *  absolute System32 path on Windows; `/proc` on Linux (no `ps` needed);
 *  `ps -ww` (never cut at a terminal width) from an absolute path elsewhere,
 *  with no inherited COLUMNS. Null when none is available (the kill then
 *  falls back to the root). The ports are for the test. */
export function makeCodexProcessLister(
  platform: NodeJS.Platform,
  systemRoot: string | undefined,
  ports: { execFile?: ExecFileLike; readProc?: () => CodexProcessEntry[]; exists?: (f: string) => boolean; timeoutMs?: number } = {},
): (() => Promise<CodexProcessEntry[]>) | null {
  const exec = ports.execFile ?? (execFile as unknown as ExecFileLike)
  const exists = ports.exists ?? ((f: string) => { try { return fs.statSync(f).isFile() } catch { return false } })
  const read = (file: string, args: string[], opts: Record<string, unknown>, parse: (t: string) => CodexProcessEntry[]) => () =>
    new Promise<CodexProcessEntry[]>((resolve, reject) => {
      exec(file, args, { encoding: 'utf8', timeout: ports.timeoutMs ?? CODEX_PROCESS_TABLE_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout) => {
        if (err) reject(err)
        else resolve(parse(String(stdout)))
      })
    })
  if (platform === 'win32') {
    if (!systemRoot || !isWindowsAbsolute(systemRoot)) return null
    const ps = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return read(ps, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY], { cwd: systemRoot }, parseWindowsProcessTable)
  }
  if (platform === 'linux') {
    const readProc = ports.readProc ?? (() => {
      const out: CodexProcessEntry[] = []
      for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue
        try {
          const e = parseLinuxStat(fs.readFileSync(`/proc/${name}/stat`, 'utf8'))
          if (e) out.push(e)
        } catch { /* exited meanwhile */ }
      }
      return out
    })
    return async () => readProc()
  }
  const ps = ['/bin/ps', '/usr/bin/ps'].find(exists)
  return ps ? read(ps, ['-ww', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'comm='], { cwd: '/', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } }, parsePosixProcessTable) : null
}

/** Exported for the test: the kill with its guards. It reads the process
 *  table, kills the run's own chain (codexChainPids) and resolves when that is
 *  done -- never the whole tree, which may hold the user's browser. When the
 *  table cannot be read at kill time it falls back to the EARLY read (prime,
 *  with its own longer budget, `primeListProcesses`): still running, it is
 *  awaited -- bounded -- and used whole, since it is as fresh as a kill-time
 *  read; finished earlier, only its wrapper line is used
 *  (codexWrapperLinePids). With neither, the root alone. */
export function makeCodexKillTree(
  platform: NodeJS.Platform,
  spawn: CodexRunDeps['spawn'],
  systemRoot: string | undefined,
  listProcesses: (() => Promise<CodexProcessEntry[]>) | null,
  primeListProcesses: (() => Promise<CodexProcessEntry[]>) | null = listProcesses,
): CodexKillTree {
  const running = (child: ChildProcess) => !!child.pid && child.exitCode === null && child.signalCode === null
  const killRoot = (child: ChildProcess) => { try { if (running(child)) child.kill('SIGKILL') } catch { /* already gone */ } }
  // What each run's early read (prime) found, by run: `table` stays
  // undefined while the read is running, null when it failed.
  const primed = new WeakMap<ChildProcess, { done: Promise<void>; table?: CodexProcessEntry[] | null }>()
  const bounded = <T>(p: Promise<T>, ms: number): Promise<T | null> => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    p.then((v) => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(null) })
  })
  const kill: CodexKillTree = async (child) => {
    const pid = child.pid
    // Only a process that is still running: once the root has exited its pid
    // can be reused, and a kill by pid would hit a stranger.
    if (!pid || !running(child)) return
    let pids = [pid]
    const early = primed.get(child)
    if (early && early.table === undefined) {
      // The early read is still running -- a slow table, the very case this
      // is for. Wait for it rather than start a second cold read beside it
      // (two would compete on a loaded machine). The CIM query captures the
      // table when it runs, at the end of the slow PowerShell start, so an
      // answer that arrives now is as fresh as a kill-time read: its whole
      // chain is used. If it fails, the kill's own read gets the time left.
      // Both together stay inside the settle bound, with taskkill's.
      const started = Date.now()
      await bounded(early.done, CODEX_KILL_READ_BUDGET_MS)
      if (early.table) {
        pids = codexChainPids(pid, early.table)
      } else if (early.table === null && listProcesses) {
        const left = CODEX_KILL_READ_BUDGET_MS - (Date.now() - started)
        const own = left > 0 ? await bounded(listProcesses(), left) : null
        if (own) pids = codexChainPids(pid, own)
      }
    } else if (listProcesses) {
      try {
        pids = codexChainPids(pid, await listProcesses())
      } catch {
        // The table could not be read now (PowerShell blocked, or too slow on
        // a loaded machine: Windows CI went past its 8 s budget). An earlier
        // read stands in for it, but only its wrapper line -- the root still
        // running (checked again below) vouches for that line, not for a
        // helper the codex binary may since have reaped. With no earlier
        // read, the root alone.
        pids = early?.table ? codexWrapperLinePids(pid, early.table) : [pid]
      }
    }
    // The table took time to read. A root that exited meanwhile means its
    // chain has almost certainly exited before it (cmd.exe waits for node,
    // node for codex), so those pids may already belong to strangers: kill
    // nothing by pid.
    if (!running(child)) return
    if (platform === 'win32') {
      // taskkill only from an absolute Windows root, run there, bounded; no
      // search of the current directory or PATH for a bare name. No /T: the
      // chain is exactly the pids named.
      if (!systemRoot || !isWindowsAbsolute(systemRoot)) { killRoot(child); return }
      const taskkill = path.win32.join(systemRoot, 'System32', 'taskkill.exe')
      await new Promise<void>((resolve) => {
        let k: ChildProcess
        try {
          k = spawn(taskkill, ['/F', ...pids.flatMap((p) => ['/PID', String(p)])], { stdio: 'ignore', windowsHide: true, cwd: systemRoot, timeout: CODEX_TASKKILL_TIMEOUT_MS })
        } catch {
          killRoot(child)
          resolve()
          return
        }
        k.on('error', () => { killRoot(child); resolve() })
        // Non-zero: some pid was not killed (perhaps already gone) -- make sure of the root.
        k.on('exit', (code) => { if (code !== 0) killRoot(child); resolve() })
      })
    } else {
      for (const p of pids) { try { process.kill(p, 'SIGKILL') } catch { /* already gone */ } }
    }
  }
  kill.prime = (child) => {
    const pid = child.pid
    if (!primeListProcesses || !pid || primed.has(child) || !running(child)) return
    const entry: { done: Promise<void>; table?: CodexProcessEntry[] | null } = { done: Promise.resolve() }
    let read: Promise<CodexProcessEntry[]>
    try { read = primeListProcesses() } catch { read = Promise.reject(new Error('no table')) }
    entry.done = read.then(
      (table) => { entry.table = Array.isArray(table) ? table : null },
      () => { entry.table = null },
    )
    primed.set(child, entry)
  }
  return kill
}

export function defaultCodexRunDeps(platform: NodeJS.Platform = process.platform, systemRoot = process.env.SystemRoot): CodexRunDeps {
  return {
    spawn: nodeSpawn,
    platform,
    killTree: makeCodexKillTree(platform, nodeSpawn, systemRoot, makeCodexProcessLister(platform, systemRoot), makeCodexProcessLister(platform, systemRoot, { timeoutMs: CODEX_PRIME_TABLE_TIMEOUT_MS })),
  }
}

const MAX_TIMEOUT_MS = 2_147_483_647
/** A run still going after this long reads its process chain once (see
 *  CodexKillTree.prime): short runs -- a status check -- never pay for it. */
export const CODEX_TREE_PRIME_MS = 2_000
/** How long a stopped run waits for its kill to land before it settles
 *  anyway: longer than reading the process table plus taskkill, so a slow
 *  table does not settle a run whose kill has not been issued yet. */
export const CODEX_KILL_SETTLE_MS = 15_000
/** How long a kill may spend reading the process table -- waiting for the
 *  early read, then its own -- so that taskkill still lands inside the
 *  settle bound. */
const CODEX_KILL_READ_BUDGET_MS = CODEX_KILL_SETTLE_MS - CODEX_TASKKILL_TIMEOUT_MS

/** Run one prepared command. Never rejects.
 *
 *  Settles on `close`. At the deadline or on cancel it kills the run's own
 *  chain and settles once the kill has landed and the root has exited, or
 *  after CODEX_KILL_SETTLE_MS, whichever is first. Nothing is killed once the
 *  root has exited -- if a descendant holds its output open (a browser a
 *  sign-in opened), the run settles with the root's exit code and the streams
 *  are destroyed instead. Nothing is reported once a stop has begun. */
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
    let stopping = false
    let primeTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (r: Omit<CodexRunResult, 'stdout' | 'stderr' | 'truncated'>) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (primeTimer) clearTimeout(primeTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ ...r, stdout, stderr, truncated })
    }
    const release = () => {
      try { child?.stdout?.destroy() } catch { /* already closed */ }
      try { child?.stderr?.destroy() } catch { /* already closed */ }
      try { child?.stdin?.destroy() } catch { /* already closed */ }
    }
    const stop = (why: 'deadline' | 'cancel') => {
      if (settled || stopping || !child) return
      if (exited !== undefined) {
        // The root is gone; only its output pipes remain. Do not kill by pid.
        release()
        finish({ exitCode: exited, timedOut: false, stopped: why === 'deadline' ? 'deadline' : 'cancel' })
        return
      }
      stopping = true
      if (timer) { clearTimeout(timer); timer = null }
      const c = child
      const outcome = why === 'deadline'
        ? { exitCode: null, timedOut: true, stopped: 'deadline' as const }
        : { exitCode: null, timedOut: false, spawnError: 'cancelled', stopped: 'cancel' as const }
      let killed: Promise<unknown>
      try { killed = Promise.resolve(deps.killTree(c)) } catch { killed = Promise.resolve() }
      const rootGone = new Promise<void>((res) => { if (exited !== undefined) res(); else c.once('exit', () => res()) })
      let bound: ReturnType<typeof setTimeout> | null = null
      const bounded = new Promise<void>((res) => { bound = setTimeout(res, CODEX_KILL_SETTLE_MS) })
      void Promise.race([Promise.all([killed.catch(() => undefined), rootGone]), bounded]).then(() => {
        if (bound) clearTimeout(bound)
        release()
        finish(outcome)
      })
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
      if (settled || stopping) return
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
    // While a stop is under way it alone settles the run: a close or an error
    // caused by the kill is not the run's own result.
    child.on('error', (e) => { if (!stopping) finish({ exitCode: null, timedOut: false, spawnError: e.message }) })
    child.on('close', (code) => { if (!stopping) finish({ exitCode: typeof code === 'number' ? code : null, timedOut: false }) })
    timer = setTimeout(() => stop('deadline'), opts.timeoutMs)
    if (deps.killTree.prime) {
      const c = child
      primeTimer = setTimeout(() => {
        primeTimer = null
        if (!settled && !stopping && exited === undefined) { try { deps.killTree.prime?.(c) } catch { /* the kill falls back to its own read */ } }
      }, CODEX_TREE_PRIME_MS)
      ;(primeTimer as unknown as { unref?: () => void }).unref?.()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* the child closed its stdin early; its exit code tells */ })
      child.stdin.end(opts.stdin)
    }
  })
}
