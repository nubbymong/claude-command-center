/**
 * Which process on the vision debug port is the app's own vision browser, and
 * ending one only once that is verified.
 *
 * Rule: a pid alone is never enough to end a process. A process is ended only
 * when it is verified as the app's own vision browser by its NAME (a browser
 * executable the app launches), its COMMAND LINE (the exact debug-port and
 * profile-folder arguments the app passes, and no `--type=`, so it is a main
 * browser process) and its START (creation) TIME. The kill itself re-reads the
 * creation time of that same pid immediately before ending it, so a pid that
 * now belongs to another program is left running.
 *
 * Every OS query goes through OwnerPorts: absolute program paths, no shell, a
 * timeout on every call, and any failure or timeout reads as "cannot identify",
 * which ends nothing. Nothing caller-supplied is put into a PowerShell script
 * except a pid and a creation time, both checked as plain digits first; the
 * command-line check runs here in TypeScript, never in PowerShell.
 *
 * No Electron import, so the unit tests load it without a window.
 */

import * as path from 'path'
import * as fs from 'fs'
import { spawn, execFileSync } from 'child_process'

/** What the OS reports about one process. */
export interface ProcessFacts {
  pid: number
  /** Win32_Process.Name on Windows; `ps -o comm=` elsewhere. */
  name: string
  commandLine: string
  /** The creation time as an exact string: CreationDate.ToFileTimeUtc() in
   *  decimal on Windows, `ps -o lstart=` trimmed elsewhere. */
  created: string
}

/** The debug port stays in use by a program not identified as the app's
 *  vision browser, so the launch stops. */
export class VisionPortHeldError extends Error {
  readonly port: number
  constructor(port: number) {
    super(`the vision browser's debug port ${port} is in use; vision was not started`)
    this.name = 'VisionPortHeldError'
    this.port = port
  }
}

/** How this module reaches the OS. Injectable so the tests start no program. */
export interface OwnerPorts {
  platform: NodeJS.Platform
  systemRoot: string | undefined
  /** Run a program by absolute path, no shell. Resolves its standard output;
   *  rejects on a non-zero exit, an error or the timeout. */
  run(file: string, args: string[], timeoutMs: number): Promise<string>
  /** The synchronous counterpart, for the app's quit. Throws on failure. */
  runSync(file: string, args: string[], timeoutMs: number): string
  /** process.kill. */
  signal(pid: number, sig: NodeJS.Signals): void
  exists(file: string): boolean
}

/** Every read, and the awaited kill. */
export const OWNER_QUERY_TIMEOUT_MS = 4000
/** The synchronous kill at quit. */
export const OWNER_SYNC_KILL_TIMEOUT_MS = 5000

const MAX_OUTPUT = 1024 * 1024
const POSIX_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' }
const POSIX_PS = ['/bin/ps', '/usr/bin/ps']
const POSIX_LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof', '/sbin/lsof', '/bin/lsof']
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']

/** Executable names of the browsers the app launches. */
const WINDOWS_BROWSER_NAMES = ['chrome.exe', 'msedge.exe']
const POSIX_BROWSER_NAMES = [
  'chrome', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable',
  'Google Chrome', 'microsoft-edge', 'microsoft-edge-stable', 'Microsoft Edge', 'msedge',
  // Linux reports at most 15 characters of a process name.
  'chromium-browse', 'google-chrome-s', 'microsoft-edge-',
]

const isWindowsAbsolute = (p: string | undefined): p is string => typeof p === 'string' && /^[A-Za-z]:[\\/]/.test(p)
const validPid = (pid: unknown): pid is number => typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff
const validPort = (port: unknown): port is number => typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
const WINDOWS_CREATED_RE = /^\d{1,20}$/

// === The match ===

/** Split a Windows command line the way CommandLineToArgvW does. */
export function splitWindowsCommandLine(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  let has = false
  let i = 0
  while (i < cmd.length) {
    const c = cmd[i]
    if (c === '\\') {
      let n = 0
      while (cmd[i] === '\\') { n++; i++ }
      if (cmd[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2))
        if (n % 2 === 1) { cur += '"'; i++ }
      } else {
        cur += '\\'.repeat(n)
      }
      has = true
      continue
    }
    if (c === '"') {
      if (inQuotes && cmd[i + 1] === '"') { cur += '"'; i += 2; has = true; continue }
      inQuotes = !inQuotes
      has = true
      i++
      continue
    }
    if (!inQuotes && (c === ' ' || c === '\t')) {
      if (has) { out.push(cur); cur = ''; has = false }
      i++
      continue
    }
    cur += c
    has = true
    i++
  }
  if (has) out.push(cur)
  return out
}

interface Switch { name: string; value: string | null }

/** The browser switches of a Windows command line (after the program, up to
 *  a bare `--`). Chromium reads `--`, `-` and `/` as switch prefixes there and
 *  switch names without regard to case. */
function windowsSwitches(cmd: string): Switch[] {
  const out: Switch[] = []
  for (const t of splitWindowsCommandLine(cmd).slice(1)) {
    if (t === '--') break
    const m = /^(?:--|-|\/)([^=]+)(?:=([\s\S]*))?$/.exec(t)
    if (m) out.push({ name: m[1].toLowerCase(), value: m[2] ?? null })
  }
  return out
}

/** At least one `name` switch, and every one of them carries exactly `value`. */
function onlyValue(switches: Switch[], name: string, value: string): boolean {
  const hits = switches.filter((s) => s.name === name)
  return hits.length > 0 && hits.every((s) => s.value === value)
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** POSIX `ps -o args=` joins the arguments with spaces, so an argument is
 *  found at a whitespace boundary: at least one `name` switch, and each one is
 *  `=value` followed by the end or whitespace. */
function posixOnlyValue(cmd: string, name: string, value: string): boolean {
  const re = new RegExp(`(?:^|\\s)--?${escapeRe(name)}(?==|\\s|$)`, 'g')
  const want = `=${value}`
  let found = false
  for (const m of cmd.matchAll(re)) {
    const rest = cmd.slice((m.index ?? 0) + m[0].length)
    if (!rest.startsWith(want)) return false
    if (rest.length > want.length && !/\s/.test(rest[want.length])) return false
    found = true
  }
  return found
}

function posixHasSwitch(cmd: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)--?${escapeRe(name)}(?==|\\s|$)`).test(cmd)
}

function isBrowserName(name: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return WINDOWS_BROWSER_NAMES.includes(name.toLowerCase())
  return POSIX_BROWSER_NAMES.includes(path.posix.basename(name))
}

/**
 * True only for the app's own vision browser on `port` with profile folder
 * `profileDir`: a browser executable the app launches, whose command line
 * carries `--remote-debugging-port=<port>` and `--user-data-dir=<profileDir>`
 * as whole arguments (every occurrence of each, so a second, different value
 * does not pass), and no `--type=` (a main browser process, not a child).
 */
export function isAppVisionBrowser(
  facts: ProcessFacts,
  port: number,
  profileDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!facts || !validPort(port) || typeof profileDir !== 'string' || profileDir === '') return false
  if (typeof facts.name !== 'string' || typeof facts.commandLine !== 'string') return false
  if (!isBrowserName(facts.name, platform)) return false
  const cmd = facts.commandLine
  if (platform === 'win32') {
    const sw = windowsSwitches(cmd)
    return onlyValue(sw, 'remote-debugging-port', String(port))
      && onlyValue(sw, 'user-data-dir', profileDir)
      && !sw.some((s) => s.name === 'type')
  }
  return posixOnlyValue(cmd, 'remote-debugging-port', String(port))
    && posixOnlyValue(cmd, 'user-data-dir', profileDir)
    && !posixHasSwitch(cmd, 'type')
}

// === Windows: one PowerShell call per question ===

function powershellPath(ports: OwnerPorts): string | null {
  return isWindowsAbsolute(ports.systemRoot)
    ? path.win32.join(ports.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : null
}

/** The facts of each process id in `$ids`, each read by a filtered CIM query
 *  (never every process), as compressed JSON in base64 so a non-ASCII command
 *  line survives the console code page. */
function windowsFactsScript(idsLine: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    idsLine,
    '$out = @()',
    'foreach ($id in $ids) {',
    '  try {',
    "    $p = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + [uint32]$id)",
    '    if ($p) { $out += [pscustomobject]@{ pid = [int64]$p.ProcessId; name = [string]$p.Name; commandLine = [string]$p.CommandLine; created = [string]$p.CreationDate.ToFileTimeUtc() } }',
    '  } catch { }',
    '}',
    '$json = ConvertTo-Json -InputObject @($out) -Compress',
    '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))',
  ].join('\n')
}

/** The listening owners of `port`, then each one's facts. `port` is checked. */
export function windowsListenerScript(port: number): string {
  if (!validPort(port)) throw new Error('invalid port')
  return windowsFactsScript(`$ids = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)`)
}

export function windowsFactsOfPidScript(pid: number): string {
  if (!validPid(pid)) throw new Error('invalid pid')
  return windowsFactsScript(`$ids = @(${pid})`)
}

/** Ends `pid`'s tree only when that pid still has creation time `created` at
 *  that moment. Both are checked as digits; nothing else goes in. */
export function windowsEndScript(pid: number, created: string): string {
  if (!validPid(pid)) throw new Error('invalid pid')
  if (!WINDOWS_CREATED_RE.test(created)) throw new Error('invalid creation time')
  return [
    "$ErrorActionPreference = 'Stop'",
    `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}'`,
    `if ($p -and ([string]$p.CreationDate.ToFileTimeUtc()) -eq '${created}') {`,
    `  & (Join-Path ([Environment]::SystemDirectory) 'taskkill.exe') /PID ${pid} /T /F | Out-Null`,
    "  'ended'",
    "} else { 'left' }",
  ].join('\n')
}

/** Parse the base64 JSON the facts script prints: one object or an array.
 *  Anything malformed is no facts at all. */
export function parseWindowsFacts(stdout: string): ProcessFacts[] {
  const b64 = String(stdout ?? '').trim()
  if (b64 === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return []
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) } catch { return [] }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  const out: ProcessFacts[] = []
  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return []
    const { pid, name, commandLine, created } = it as Record<string, unknown>
    if (!validPid(pid) || typeof name !== 'string' || typeof commandLine !== 'string') return []
    if (typeof created !== 'string' || !WINDOWS_CREATED_RE.test(created)) return []
    out.push({ pid, name, commandLine, created })
  }
  return out
}

// === POSIX: lsof, then ps per pid ===

function posixTool(ports: OwnerPorts, candidates: string[]): string | null {
  return candidates.find((f) => { try { return ports.exists(f) } catch { return false } }) ?? null
}

/** `lsof -t` output: one pid a line. Anything else is no pids at all. */
export function parseLsofPids(stdout: string): number[] {
  const out: number[] = []
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (!/^\d{1,10}$/.test(line)) return []
    const pid = Number(line)
    if (!validPid(pid)) return []
    if (!out.includes(pid)) out.push(pid)
  }
  return out
}

/** One line of `ps -o <field>=` output, or null. */
function oneLine(stdout: string): string | null {
  const s = String(stdout ?? '').trim()
  return s === '' || /[\r\n]/.test(s) ? null : s
}

async function posixFactsOfPid(pid: number, ports: OwnerPorts): Promise<ProcessFacts | null> {
  const ps = posixTool(ports, POSIX_PS)
  if (!ps) return null
  const read = (field: string) => ports.run(ps, ['-ww', '-p', String(pid), '-o', field], OWNER_QUERY_TIMEOUT_MS)
  try {
    const [comm, args, lstart] = await Promise.all([read('comm='), read('args='), read('lstart=')])
    const name = oneLine(comm), commandLine = oneLine(args), created = oneLine(lstart)
    if (name === null || commandLine === null || created === null) return null
    return { pid, name, commandLine, created }
  } catch { return null }
}

// === The questions ===

/** The facts of every process listening on `port`. Any failure, timeout or
 *  malformed answer is [] (cannot identify: nothing gets ended). */
export async function listenerFacts(port: number, ports: OwnerPorts = defaultOwnerPorts()): Promise<ProcessFacts[]> {
  if (!validPort(port)) return []
  try {
    if (ports.platform === 'win32') {
      const ps = powershellPath(ports)
      if (!ps) return []
      return parseWindowsFacts(await ports.run(ps, [...POWERSHELL_ARGS, windowsListenerScript(port)], OWNER_QUERY_TIMEOUT_MS))
    }
    const lsof = posixTool(ports, POSIX_LSOF)
    if (!lsof) return []
    const pids = parseLsofPids(await ports.run(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], OWNER_QUERY_TIMEOUT_MS))
    const out: ProcessFacts[] = []
    for (const pid of pids) {
      const f = await posixFactsOfPid(pid, ports)
      if (f) out.push(f)
    }
    return out
  } catch { return [] }
}

/** The facts of one pid, or null when it cannot be read (or has exited). */
export async function factsOfPid(pid: number, ports: OwnerPorts = defaultOwnerPorts()): Promise<ProcessFacts | null> {
  if (!validPid(pid)) return null
  try {
    if (ports.platform === 'win32') {
      const ps = powershellPath(ports)
      if (!ps) return null
      const facts = parseWindowsFacts(await ports.run(ps, [...POWERSHELL_ARGS, windowsFactsOfPidScript(pid)], OWNER_QUERY_TIMEOUT_MS))
      return facts.length === 1 && facts[0].pid === pid ? facts[0] : null
    }
    return await posixFactsOfPid(pid, ports)
  } catch { return null }
}

/** The identity a kill re-checks: the pid and its exact creation time. */
export interface VerifiedTarget { pid: number; created: string }

function targetOk(t: VerifiedTarget, platform: NodeJS.Platform): boolean {
  if (!t || !validPid(t.pid) || typeof t.created !== 'string') return false
  return platform === 'win32' ? WINDOWS_CREATED_RE.test(t.created) : oneLine(t.created) === t.created
}

function signalTree(pid: number, ports: OwnerPorts): boolean {
  // The negative pid is the process group the browser leads (it is started
  // detached); the pid itself when it leads none.
  try { ports.signal(-pid, 'SIGTERM'); return true } catch { /* not a group leader */ }
  try { ports.signal(pid, 'SIGTERM'); return true } catch { return false }
}

/**
 * End `target`'s process tree, only if the SAME pid still has the SAME
 * creation time at the moment of the kill. Resolves whether it was ended.
 * Never throws. The caller has verified the process (isAppVisionBrowser)
 * from facts carrying that creation time.
 */
export async function endVerified(target: VerifiedTarget, ports: OwnerPorts = defaultOwnerPorts()): Promise<boolean> {
  if (!targetOk(target, ports.platform)) return false
  try {
    if (ports.platform === 'win32') {
      const ps = powershellPath(ports)
      if (!ps) return false
      const out = await ports.run(ps, [...POWERSHELL_ARGS, windowsEndScript(target.pid, target.created)], OWNER_QUERY_TIMEOUT_MS)
      return String(out).trim() === 'ended'
    }
    const ps = posixTool(ports, POSIX_PS)
    if (!ps) return false
    const now = oneLine(await ports.run(ps, ['-p', String(target.pid), '-o', 'lstart='], OWNER_QUERY_TIMEOUT_MS))
    if (now !== target.created) return false
    return signalTree(target.pid, ports)
  } catch { return false }
}

/** endVerified, synchronously, for the app's quit (the process may exit
 *  before an awaited kill runs). */
export function endVerifiedSync(target: VerifiedTarget, ports: OwnerPorts = defaultOwnerPorts()): boolean {
  if (!targetOk(target, ports.platform)) return false
  try {
    if (ports.platform === 'win32') {
      const ps = powershellPath(ports)
      if (!ps) return false
      const out = ports.runSync(ps, [...POWERSHELL_ARGS, windowsEndScript(target.pid, target.created)], OWNER_SYNC_KILL_TIMEOUT_MS)
      return String(out).trim() === 'ended'
    }
    const ps = posixTool(ports, POSIX_PS)
    if (!ps) return false
    const now = oneLine(ports.runSync(ps, ['-p', String(target.pid), '-o', 'lstart='], OWNER_SYNC_KILL_TIMEOUT_MS))
    if (now !== target.created) return false
    return signalTree(target.pid, ports)
  } catch { return false }
}

// === The real OS ===

interface RunOpts { cwd?: string; env?: NodeJS.ProcessEnv }

function runOpts(platform: NodeJS.Platform, systemRoot: string | undefined): RunOpts {
  if (platform === 'win32') return isWindowsAbsolute(systemRoot) ? { cwd: systemRoot } : {}
  return { cwd: '/', env: POSIX_ENV }
}

/** Spawn `file` (no shell) and resolve its standard output when it closes
 *  with status 0; reject on an error, another status or the timeout (the
 *  program is then ended so it does not linger). */
export function runAwait(file: string, args: string[], timeoutMs: number, opts: RunOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let out = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    let child: ReturnType<typeof spawn> | null = null
    const finish = (err: Error | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (err) reject(err)
      else resolve(out)
    }
    try {
      child = spawn(file, args, { ...opts, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { if (out.length < MAX_OUTPUT) out += chunk })
      child.on('error', (e: Error) => finish(e))
      child.on('close', (code: number | null) => finish(code === 0 ? null : new Error(`exited with status ${code}`)))
      timer = setTimeout(() => {
        try { child?.kill() } catch { /* already gone */ }
        finish(new Error('timed out'))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    } catch (e) {
      finish(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/** The real OS, read at call time. */
export function defaultOwnerPorts(): OwnerPorts {
  const platform = process.platform
  const systemRoot = process.env.SystemRoot
  return {
    platform,
    systemRoot,
    run: (file, args, timeoutMs) => runAwait(file, args, timeoutMs, runOpts(platform, systemRoot)),
    runSync: (file, args, timeoutMs) => String(execFileSync(file, args, {
      ...runOpts(platform, systemRoot), encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_OUTPUT,
    })),
    signal: (pid, sig) => { process.kill(pid, sig) },
    exists: (f) => { try { return fs.statSync(f).isFile() } catch { return false } },
  }
}
