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
// A stopped run settles once that kill has landed and its root has exited, or
// at CODEX_KILL_SETTLE_MS, whichever is first, so the caller hears back on
// time. A kill still reading a slow process table at that bound carries on
// (it never kills the root alone to meet the bound: that would leave the chain
// below running), for at most CODEX_KILL_WORST_MS from the stop, and the
// result says so (`killSettled`): a caller that holds a realm or a lease for
// the run lets go only once that kill has finished. Nothing is killed once the
// root has exited: its pid may have been reused. At app quit, kills still
// reading kill what they know at once (flushPendingCodexKills). See
// runCodexCli and makeCodexKillTree.
import path from 'node:path'
import fs from 'node:fs'
import { spawn as nodeSpawn, execFile, execFileSync } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

export type CodexCliOperation = 'version' | 'status' | 'logout' | 'login-browser' | 'login-device' | 'login-api-key' | 'review' | 'app-server'

const ARGS: Readonly<Record<CodexCliOperation, readonly string[]>> = {
  'version': ['--version'],
  'status': ['login', 'status'],
  'logout': ['logout'],
  'login-browser': ['login'],
  'login-device': ['login', '--device-auth'],
  // The key arrives on stdin, never here (the pinned CLI refuses a TTY stdin).
  'login-api-key': ['login', '--with-api-key'],
  // A reviewer invocation (WP2 commit 5a): non-interactive, JSONL events on
  // stdout, nothing persisted, read-only sandbox; the prompt arrives on stdin
  // (`-`), never here. The caller runs it in the project folder.
  'review': ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'gpt-5.5', '-'],
  // Usage track MP7 (ADR-022; the owner's scoped WP1.41 exception): the
  // protocol helper for one usage read, on its default stdio transport only:
  // never `daemon`, `proxy`, `--listen` or `--enable`. Its messages arrive
  // on stdin (the runner's open-stdin mode), never here. MP8 round 2 (VM
  // hosts): `--disable remote_plugin` turns the default-on remote plugin
  // feature off for this process only (it is `-c features.remote_plugin=
  // false`, nothing written); `codex app-server --help` and `codex features
  // list` show both on 0.153.4 and 0.155.1. It turns nothing on.
  'app-server': ['app-server', '--disable', 'remote_plugin'],
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
  return cliCommandLine(executable, args, platform, env, 'Codex')
}

/** The characters a constant argv element may carry: none that cmd.exe, a
 *  shim or a shell reads (no space, quote, `% & ^ | < > ( ) !`). */
const PLAIN_ARG = /^[A-Za-z0-9._,:=/-]+$/

/** codexCommandLine's rules for any CLI's CONSTANT argv (WP2 commit 5b: the
 *  composition root hands this to the Claude package, which imports nothing
 *  of this one). `label` names the CLI in a refusal. An argv element outside
 *  PLAIN_ARG is refused: on the shim route it lands on a cmd.exe line
 *  verbatim, so no text there may be a caller's. */
export function cliCommandLine(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  env: { ComSpec?: string; SystemRoot?: string },
  label: string,
): CodexCommand | { refused: string } {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || !PLAIN_ARG.test(a))) return { refused: `not a ${label} CLI command line this app runs` }
  if (typeof executable !== 'string' || !executable) return { refused: `no ${label} executable` }
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (!pathApi.isAbsolute(executable)) return { refused: `the ${label} executable path is not absolute` }
  if (platform === 'win32') {
    // A drive or a share, never `\x` (the current drive), `\\?\` or `\\.\`;
    // and no trailing dot or space, which Windows drops -- `codex.cmd.` must
    // not dodge the shim route below.
    if (!/^([A-Za-z]:\\|\\\\[^\\?.][^\\]*\\[^\\]+\\)/.test(executable)) return { refused: `the ${label} executable is not on a drive or a share` }
    if (/[. ]$/.test(executable)) return { refused: `the ${label} executable name ends in a dot or a space` }
  }
  const cwd = pathApi.dirname(executable)
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) {
    return { file: executable, args: [...args], verbatim: false, cwd }
  }
  // eslint-disable-next-line no-control-regex
  if (/["%&^\x00-\x1f]/.test(executable)) {
    return { refused: `the ${label} shim path carries a character cmd.exe or the shim would re-read (" % & ^ or a control character)` }
  }
  const absoluteCmd = (p: string | undefined): p is string => isWindowsAbsolute(p) && /[\\/]cmd\.exe$/i.test(p)
  const system32 = env.SystemRoot ? path.win32.join(env.SystemRoot, 'System32', 'cmd.exe') : undefined
  const shell = absoluteCmd(env.ComSpec) ? env.ComSpec : absoluteCmd(system32) ? system32 : null
  if (!shell) return { refused: `no absolute cmd.exe to run the ${label} shim with (SystemRoot is not set)` }
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
  /** Present only when a stopped run settled at CODEX_KILL_SETTLE_MS with
   *  its kill still under way (a slow process table): resolves once that
   *  kill has finished, or CODEX_KILL_WORST_MS after the stop, and never
   *  rejects. The run's processes may live until then, so a caller holding a
   *  realm lock or an account lease for the run lets go only after it. */
  killSettled?: Promise<void>
}

/** Usage track MP7: the writer an open-stdin run hands its caller. */
export interface CodexStdinWriter {
  /** Writes to the child's stdin; false (and nothing written) once the run
   *  has settled, begun stopping or had its stdin ended. */
  write(text: string): boolean
  /** Closes the child's stdin (once). */
  end(): void
}

export interface CodexRunOptions {
  env: Record<string, string>
  timeoutMs: number
  /** Written to the child's stdin pipe once, then closed. Absent (and no
   *  `openStdin`): stdin is ignored. */
  stdin?: string
  /** Usage track MP7 (ADR-022): stdin kept open for a protocol helper. Called
   *  once, just after the spawn, with a writer; the caller writes whole
   *  messages and ends stdin when it is done. The deadline, cancel and kill
   *  chain are the runner's as for any run. Exclusive with `stdin`. */
  openStdin?: (io: CodexStdinWriter) => void
  /** Per stream; the rest is dropped (default 64 KiB). */
  maxOutput?: number
  onOutput?: (text: string, stream: 'stdout' | 'stderr') => void
  /** Every chunk as it arrives, whether or not the cap keeps it: for a
   *  consumer that reads a long stream as it goes and bounds its own memory. */
  onChunk?: (text: string, stream: 'stdout' | 'stderr') => void
  signal?: AbortSignal
}

/** Kills a run's own processes (see makeCodexKillTree). `prime`, when
 *  present, reads the run's chain once the run is established, so a kill on a
 *  slow machine awaits a read already under way instead of starting a cold
 *  one, and one whose own read fails still has an earlier table. */
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

/** Room past the kill's phases for a taskkill ended by its own timeout,
 *  which reports a moment after that timeout. */
const CODEX_KILL_MARGIN_MS = 1000
/** The longest a kill can take: the kill's own table read, one more read with
 *  the early read's longer budget, then taskkill, plus CODEX_KILL_MARGIN_MS
 *  (makeCodexKillTree). A caller holding a realm or a lease for a stopped run
 *  holds it this long at most after the stop (CodexRunResult.killSettled). */
export const CODEX_KILL_WORST_MS = CODEX_PROCESS_TABLE_TIMEOUT_MS + CODEX_PRIME_TABLE_TIMEOUT_MS + CODEX_TASKKILL_TIMEOUT_MS + CODEX_KILL_MARGIN_MS

/** A kill still reading its table, as the quit flush sees it. */
interface PendingKill {
  platform: NodeJS.Platform
  systemRoot: string | undefined
  /** What it would kill right now; null once its root has exited. */
  pids(): number[] | null
  killRoot(): void
  /** Set by the flush: the kill does not kill again when its read lands. */
  flushed: boolean
}

/** Every kill still reading its table, for the app's quit. Module-wide:
 *  every run builds its own kill (defaultCodexRunDeps). */
const pendingKills = new Set<PendingKill>()

type RunSync = (file: string, args: string[], opts: Record<string, unknown>) => void
const runSyncDefault: RunSync = (file, args, opts) => { execFileSync(file, args, opts) }

/** At app quit: every kill still reading its table kills at once what it
 *  knows -- an earlier table's wrapper line, else the root alone, and nothing
 *  for a root that has exited -- rather than leave node and codex running
 *  once the app is gone (the job that ends the app's own children at exit
 *  does not reach below cmd.exe). On Windows it is ONE synchronous taskkill
 *  per Windows root (in practice one), bounded by CODEX_TASKKILL_TIMEOUT_MS,
 *  as killSpawnedBrowser does, so the exit cannot cut it off. A taskkill
 *  that fails or times out makes sure of each root. Never throws; best
 *  effort, like the rest of the quit. `runSync` is for the test. */
export function flushPendingCodexKills(runSync: RunSync = runSyncDefault): void {
  const now = [...pendingKills]
  pendingKills.clear()
  const byRoot = new Map<string, { pids: number[]; kills: PendingKill[] }>()
  for (const k of now) {
    k.flushed = true
    try {
      const pids = k.pids()
      if (!pids) continue
      if (k.platform !== 'win32') {
        for (const p of pids) { try { process.kill(p, 'SIGKILL') } catch { /* already gone */ } }
        continue
      }
      if (!k.systemRoot || !isWindowsAbsolute(k.systemRoot)) { k.killRoot(); continue }
      const group = byRoot.get(k.systemRoot) ?? { pids: [], kills: [] }
      group.pids.push(...pids)
      group.kills.push(k)
      byRoot.set(k.systemRoot, group)
    } catch { /* best effort at quit */ }
  }
  for (const [root, group] of byRoot) {
    try {
      runSync(path.win32.join(root, 'System32', 'taskkill.exe'), ['/F', ...group.pids.flatMap((p) => ['/PID', String(p)])], { stdio: 'ignore', windowsHide: true, cwd: root, timeout: CODEX_TASKKILL_TIMEOUT_MS })
    } catch {
      // Non-zero (some pid already gone), a timeout or no taskkill.
      for (const k of group.kills) { try { k.killRoot() } catch { /* best effort at quit */ } }
    }
  }
}

/** Exported for the test: the kill with its guards. It kills the run's own
 *  chain and resolves when that is done -- never the whole tree, which may
 *  hold the user's browser -- and nothing once the root has exited.
 *
 *  Which pids, from which table:
 *  - An early read (prime) still running is awaited, up to its own timeout,
 *    rather than raced by a second cold read; the root is left running
 *    meanwhile (the run settles at its bound regardless). Killing the root
 *    alone sooner would leave the chain below it running, and once the root
 *    is gone nothing vouches for those pids. Windows CI saw an early read
 *    outlast a 10 s wait. If it fails or never answers, ONE retry with the
 *    kill's own reader (`listProcesses`, its budget).
 *  - Otherwise the kill reads the table itself (`listProcesses`). If that
 *    fails: an early read that finished earlier stands in; one that FAILED
 *    already had the longer budget, so the root alone; with no early read at
 *    all (a stop inside CODEX_TREE_PRIME_MS), ONE retry with
 *    `primeListProcesses` and its longer budget. `primeListProcesses`
 *    defaults to `listProcesses`: the same reader then gets the longer wait.
 *  - Every table, whichever read gave it, is used whole (codexChainPids) only
 *    while it can be no older than a kill-time read may be:
 *    CODEX_PROCESS_TABLE_TIMEOUT_MS from the start of its read (the query
 *    captures the table somewhere inside it). An older one gives only its
 *    wrapper line (codexWrapperLinePids): the root still running vouches for
 *    that line, not for a helper the codex binary may since have reaped,
 *    whose pid a stranger may hold.
 *  - The root alone when those reads all failed, or with no reader. No kill
 *    waits longer than CODEX_KILL_WORST_MS. Every read is bounded, and a
 *    throw or an answer that is not a list counts as a failed read: the kill
 *    never rejects with nothing killed.
 *  - A kill the quit flush has already dealt with kills nothing more. */
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
  // undefined while the read is running, null when it failed; `started` is
  // when the read began.
  type Primed = { done: Promise<void>; started: number; table?: CodexProcessEntry[] | null }
  const primed = new WeakMap<ChildProcess, Primed>()
  /** A table and when the read that gave it began. */
  type Answer = { table: CodexProcessEntry[]; started: number }
  const bounded = <T>(p: Promise<T>, ms: number): Promise<T | null> => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    p.then((v) => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(null) })
  })
  /** One read, bounded: a throw, a rejection, no answer in time or an answer
   *  that is not a list is null. */
  const read = (reader: (() => Promise<CodexProcessEntry[]>) | null, ms: number): Promise<Answer | null> => {
    if (!reader) return Promise.resolve(null)
    const started = Date.now()
    return bounded(Promise.resolve().then(reader), ms).then((t) => (Array.isArray(t) ? { table: t, started } : null))
  }
  /** The whole chain from a table no older than a kill-time read may be;
   *  only the wrapper line from an older one. */
  const pidsFrom = (pid: number, a: Answer): number[] =>
    Date.now() - a.started <= CODEX_PROCESS_TABLE_TIMEOUT_MS ? codexChainPids(pid, a.table) : codexWrapperLinePids(pid, a.table)
  const choosePids = async (pid: number, early: Primed | undefined): Promise<number[]> => {
    if (early && early.table === undefined) {
      await bounded(early.done, CODEX_PRIME_TABLE_TIMEOUT_MS)
      if (early.table) return pidsFrom(pid, { table: early.table, started: early.started })
      const again = await read(listProcesses, CODEX_PROCESS_TABLE_TIMEOUT_MS)
      return again ? pidsFrom(pid, again) : [pid]
    }
    const own = await read(listProcesses, CODEX_PROCESS_TABLE_TIMEOUT_MS)
    if (own) return pidsFrom(pid, own)
    if (early?.table) return pidsFrom(pid, { table: early.table, started: early.started })
    // An early read that FAILED already had the longer budget.
    if (early) return [pid]
    const again = await read(primeListProcesses, CODEX_PRIME_TABLE_TIMEOUT_MS)
    return again ? pidsFrom(pid, again) : [pid]
  }
  /** taskkill (Windows) or a signal per pid (POSIX), for a root still running. */
  const killPids = async (child: ChildProcess, pids: number[]): Promise<void> => {
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
  const kill: CodexKillTree = async (child) => {
    const pid = child.pid
    // Only a process that is still running: once the root has exited its pid
    // can be reused, and a kill by pid would hit a stranger.
    if (!pid || !running(child)) return
    const early = primed.get(child)
    const pending: PendingKill = {
      platform,
      systemRoot,
      flushed: false,
      pids: () => {
        if (!running(child)) return null
        try { return early?.table ? codexWrapperLinePids(pid, early.table) : [pid] } catch { return [pid] }
      },
      killRoot: () => killRoot(child),
    }
    pendingKills.add(pending)
    let pids: number[]
    try {
      pids = await choosePids(pid, early)
    } catch {
      pids = [pid]
    } finally {
      pendingKills.delete(pending)
    }
    // Killed at quit meanwhile: its root is gone or going, and nothing
    // vouches for the pids below it any more (its exit may not be reported
    // yet). And the table took time to read: a root that exited meanwhile
    // means its chain has almost certainly exited before it (cmd.exe waits
    // for node, node for codex), so those pids may already belong to
    // strangers. Either way, kill nothing by pid.
    if (pending.flushed || !running(child)) return
    await killPids(child, pids)
  }
  kill.prime = (child) => {
    const pid = child.pid
    if (!primeListProcesses || !pid || primed.has(child) || !running(child)) return
    const entry: Primed = { done: Promise.resolve(), started: Date.now() }
    let answer: Promise<CodexProcessEntry[]>
    try { answer = primeListProcesses() } catch { answer = Promise.reject(new Error('no table')) }
    entry.done = Promise.resolve(answer).then(
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
 *  anyway: longer than reading the process table plus taskkill, so a table
 *  read in the usual time does not settle a run whose kill has not been
 *  issued yet. A slower table settles the run with its kill under way
 *  (CodexRunResult.killSettled). */
export const CODEX_KILL_SETTLE_MS = 15_000

/** Resolves once `ended` has, or after `ms`, whichever is first. Never rejects. */
function settleWithin(ended: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms))
    ;(timer as unknown as { unref?: () => void }).unref?.()
    void ended.then(() => { clearTimeout(timer); resolve() })
  })
}

/** Run one prepared command. Never rejects.
 *
 *  Settles on `close`. At the deadline or on cancel it kills the run's own
 *  chain and settles once the kill has landed and the root has exited, or
 *  after CODEX_KILL_SETTLE_MS, whichever is first; a kill still under way
 *  then is reported as `killSettled`. Nothing is killed once the root has
 *  exited -- if a descendant holds its output open (a browser a sign-in
 *  opened), the run settles with the root's exit code and the streams are
 *  destroyed instead. Nothing is reported once a stop has begun. */
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
      const stoppedAt = Date.now()
      let killed: Promise<unknown>
      try { killed = Promise.resolve(deps.killTree(c)) } catch { killed = Promise.resolve() }
      // Registered before the race below, so it has run by the time a kill
      // that finished in time lets the run settle.
      let killDone = false
      const killEnded = killed.then(() => { killDone = true }, () => { killDone = true })
      const rootGone = new Promise<void>((res) => { if (exited !== undefined) res(); else c.once('exit', () => res()) })
      let bound: ReturnType<typeof setTimeout> | null = null
      const bounded = new Promise<void>((res) => { bound = setTimeout(res, CODEX_KILL_SETTLE_MS) })
      void Promise.race([Promise.all([killEnded, rootGone]), bounded]).then(() => {
        if (bound) clearTimeout(bound)
        release()
        // A kill still reading a slow table carries on past the bound: the
        // result says when it has finished, so a caller holding a realm or a
        // lease for the run lets go only then.
        finish(killDone ? outcome : { ...outcome, killSettled: settleWithin(killEnded, CODEX_KILL_WORST_MS - (Date.now() - stoppedAt)) })
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
    if (opts.stdin !== undefined && opts.openStdin !== undefined) {
      finish({ exitCode: null, timedOut: false, spawnError: 'invalid stdin' })
      return
    }
    const stdinPiped = opts.stdin !== undefined || typeof opts.openStdin === 'function'
    // A prototype-free copy of exactly the caller's own variables: spawn walks
    // inherited keys, so a polluted Object.prototype must add nothing.
    const env: Record<string, string> = Object.create(null) as Record<string, string>
    for (const k of Object.keys(opts.env)) if (typeof opts.env[k] === 'string') env[k] = opts.env[k]
    try {
      child = deps.spawn(cmd.file, cmd.args, {
        cwd: cmd.cwd,
        env,
        stdio: [stdinPiped ? 'pipe' : 'ignore', 'pipe', 'pipe'],
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
      if (opts.onChunk) { try { opts.onChunk(text, stream) } catch { /* a consumer never breaks the run */ } }
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
    if (typeof opts.openStdin === 'function' && child.stdin) {
      const pipe = child.stdin
      pipe.on('error', () => { /* the child closed its stdin early; its exit code tells */ })
      let ended = false
      const io: CodexStdinWriter = {
        write: (text) => {
          if (settled || stopping || ended || typeof text !== 'string') return false
          try { pipe.write(text); return true } catch { return false }
        },
        end: () => {
          if (ended) return
          ended = true
          try { pipe.end() } catch { /* already closed */ }
        },
      }
      // A caller that throws gets its stdin closed; the deadline still bounds the run.
      try { opts.openStdin(io) } catch { io.end() }
    }
  })
}
