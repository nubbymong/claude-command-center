/**
 * How vision recognises and ends its own browsers.
 *
 * Two kinds of browser, two ways to end one:
 *
 * - The browser the app spawned in this run is its own child. Until its exit
 *   has been observed (exitCode and signalCode both null), libuv still holds
 *   that process, so its pid cannot name another one. It is ended by that pid
 *   with no read-back: `taskkill /PID <pid> /T /F` on Windows, its process
 *   group on Linux and macOS (SIGTERM, then SIGKILL after a grace). Once its
 *   exit was observed, nothing is done with that pid.
 *
 * - A browser left by an earlier run of the app is found by its profile,
 *   whether or not it listens on the debug port, and ended only once it is
 *   identified as the app's vision browser by its NAME (a browser executable
 *   the app launches), its COMMAND LINE (the exact debug-port argument, a
 *   profile argument naming the same folder, and no `--type=`, so a main
 *   browser process) and its START (creation) TIME. The kill re-reads the
 *   creation time of that same pid immediately before ending it.
 *
 * Every OS call goes through OwnerPorts: absolute program paths, no shell, a
 * timeout on every call, and any failure or timeout reads as "cannot
 * identify", which ends nothing. The queries run asynchronously; the only
 * synchronous call is the taskkill of the app's own browser. Nothing is put
 * into a PowerShell script except a pid and a creation time, both checked as
 * plain digits first; command lines are matched here in TypeScript.
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
  /** The synchronous counterpart, used only for the taskkill of the app's own
   *  browser. Throws on failure. */
  runSync(file: string, args: string[], timeoutMs: number): string
  /** process.kill. */
  signal(pid: number, sig: NodeJS.Signals): void
  exists(file: string): boolean
  /** The long real path of an existing file or folder, or null. */
  realpath(p: string): string | null
  /** Resolve after `ms`. */
  sleep(ms: number): Promise<void>
  /** Block for `ms` (bounded; the quit path only). */
  sleepSync(ms: number): void
}

/** Every async query and the awaited verified kill: a cold PowerShell on a
 *  busy machine can take well over 4 s to answer. */
export const OWNER_QUERY_TIMEOUT_MS = 20000
/** The synchronous taskkill of the app's own browser. */
export const OWNER_SYNC_KILL_TIMEOUT_MS = 5000
/** POSIX: how long a browser gets after SIGTERM before SIGKILL (async paths). */
export const POSIX_TERM_GRACE_MS = 3000
/** POSIX, at quit: the bounded wait between SIGTERM and SIGKILL. */
export const OWN_QUIT_GRACE_MS = 500
/** How long an end waits for the app's own browser's exit to be observed. */
export const OWN_EXIT_WAIT_MS = 5000

const POSIX_POLL_MS = 150
const MAX_OUTPUT = 1024 * 1024
const POSIX_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' }
const POSIX_PS = ['/bin/ps', '/usr/bin/ps']
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

type Realpath = (p: string) => string | null
type PathKind = 'win32' | 'posix'

function realOrNull(realpath: Realpath, p: string): string | null {
  try {
    const r = realpath(p)
    return typeof r === 'string' && r !== '' ? r : null
  } catch { return null }
}

function trimSeparators(p: string, kind: PathKind): string {
  const root = kind === 'win32' ? /^[A-Za-z]:[\\/]?$/ : /^\/$/
  let out = p
  while (out.length > 1 && /[\\/]$/.test(out) && !root.test(out)) out = out.slice(0, -1)
  return out
}

/** The long real spelling of a folder: its real path when it exists, else its
 *  parent's real path joined with its own name, else the path as written,
 *  normalised. On Windows the real path also expands short (8.3) names. */
function longPath(dir: string, kind: PathKind, realpath: Realpath): string {
  const p = kind === 'win32' ? path.win32 : path.posix
  const norm = trimSeparators(p.normalize(dir), kind)
  const real = realOrNull(realpath, norm)
  if (real) return trimSeparators(p.normalize(real), kind)
  const parent = realOrNull(realpath, p.dirname(norm))
  return parent ? trimSeparators(p.join(parent, p.basename(norm)), kind) : norm
}

/** Whether a profile argument names the expected profile folder: the same
 *  string, or both absolute with the same last folder name and the same long
 *  real path (without regard to case on Windows). A prefix of the folder, or
 *  another folder, never matches. */
function sameProfile(actual: string, expected: string, kind: PathKind, realpath: Realpath): boolean {
  if (actual === expected) return true
  const p = kind === 'win32' ? path.win32 : path.posix
  const absolute = kind === 'win32' ? isWindowsAbsolute(actual) && isWindowsAbsolute(expected) : actual.startsWith('/') && expected.startsWith('/')
  if (!absolute) return false
  const fold = (s: string) => (kind === 'win32' ? s.toLowerCase() : s)
  if (fold(p.basename(trimSeparators(actual, kind))) !== fold(p.basename(trimSeparators(expected, kind)))) return false
  return fold(longPath(actual, kind, realpath)) === fold(longPath(expected, kind, realpath))
}

/** POSIX: every `--user-data-dir` names the expected folder. `ps` joins the
 *  arguments with spaces, so the value may end at any whitespace boundary: one
 *  of those must name the folder. */
function posixProfileMatches(cmd: string, expected: string, realpath: Realpath): boolean {
  const re = /(?:^|\s)--?user-data-dir(?==|\s|$)/g
  let found = false
  for (const m of cmd.matchAll(re)) {
    const rest = cmd.slice((m.index ?? 0) + m[0].length)
    if (!rest.startsWith('=')) return false
    const value = rest.slice(1)
    const ends: number[] = []
    for (let i = 0; i < value.length && ends.length < 64; i++) if (/\s/.test(value[i])) ends.push(i)
    ends.push(value.length)
    if (!ends.some((e) => sameProfile(value.slice(0, e), expected, 'posix', realpath))) return false
    found = true
  }
  return found
}

/**
 * True only for the app's own vision browser on `port` with profile folder
 * `profileDir`: a browser executable the app launches, whose command line
 * carries `--remote-debugging-port=<port>` as a whole argument and
 * `--user-data-dir` naming that folder (every occurrence of each, so a
 * second, different value does not pass), and no `--type=` (a main browser
 * process, not a child). `realpath` (optional) gives the long real path of a
 * folder, so another spelling of the same folder (a short 8.3 TEMP, another
 * case on Windows) still matches.
 */
export function isAppVisionBrowser(
  facts: ProcessFacts,
  port: number,
  profileDir: string,
  platform: NodeJS.Platform = process.platform,
  realpath: Realpath = () => null,
): boolean {
  if (!facts || !validPort(port) || typeof profileDir !== 'string' || profileDir === '') return false
  if (typeof facts.name !== 'string' || typeof facts.commandLine !== 'string') return false
  if (!isBrowserName(facts.name, platform)) return false
  const cmd = facts.commandLine
  if (platform === 'win32') {
    const sw = windowsSwitches(cmd)
    const dirs = sw.filter((s) => s.name === 'user-data-dir')
    return onlyValue(sw, 'remote-debugging-port', String(port))
      && dirs.length > 0
      && dirs.every((s) => s.value !== null && sameProfile(s.value, profileDir, 'win32', realpath))
      && !sw.some((s) => s.name === 'type')
  }
  return posixOnlyValue(cmd, 'remote-debugging-port', String(port))
    && posixProfileMatches(cmd, profileDir, realpath)
    && !posixHasSwitch(cmd, 'type')
}

// === Windows: one PowerShell call per question ===

function powershellPath(ports: OwnerPorts): string | null {
  return isWindowsAbsolute(ports.systemRoot)
    ? path.win32.join(ports.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : null
}

function taskkillPath(ports: OwnerPorts): string | null {
  return isWindowsAbsolute(ports.systemRoot) ? path.win32.join(ports.systemRoot, 'System32', 'taskkill.exe') : null
}

const FACTS_OUTPUT = [
  '$json = ConvertTo-Json -InputObject @($out) -Compress',
  '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))',
]

/**
 * Every chrome.exe and msedge.exe process whose command line names a
 * remote-debugging-port, with its facts, by ONE CIM query filtered to those
 * two names (never every process), as compressed JSON in base64 so a
 * non-ASCII command line survives the console code page. A constant script:
 * nothing is put into it. Which of them is the app's is decided in TypeScript.
 */
export const WINDOWS_BROWSERS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$out = @()',
  "foreach ($p in @(Get-CimInstance -ClassName Win32_Process -Filter 'Name=''chrome.exe'' OR Name=''msedge.exe''')) {",
  '  try {',
  '    $cmd = [string]$p.CommandLine',
  "    if ($p.CreationDate -and ($cmd -like '*remote-debugging-port*')) {",
  '      $out += [pscustomobject]@{ pid = [int64]$p.ProcessId; name = [string]$p.Name; commandLine = $cmd; created = [string]$p.CreationDate.ToFileTimeUtc() }',
  '    }',
  '  } catch { }',
  '}',
  ...FACTS_OUTPUT,
].join('\n')

/** The facts of one process id, by a CIM query filtered to that id. */
export function windowsFactsOfPidScript(pid: number): string {
  if (!validPid(pid)) throw new Error('invalid pid')
  return [
    "$ErrorActionPreference = 'Stop'",
    `$ids = @(${pid})`,
    '$out = @()',
    'foreach ($id in $ids) {',
    '  try {',
    "    $p = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + [uint32]$id)",
    '    if ($p) { $out += [pscustomobject]@{ pid = [int64]$p.ProcessId; name = [string]$p.Name; commandLine = [string]$p.CommandLine; created = [string]$p.CreationDate.ToFileTimeUtc() } }',
    '  } catch { }',
    '}',
    ...FACTS_OUTPUT,
  ].join('\n')
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

/** Parse the base64 JSON the facts scripts print: one object or an array.
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

// === POSIX: ps ===

function posixTool(ports: OwnerPorts, candidates: string[]): string | null {
  return candidates.find((f) => { try { return ports.exists(f) } catch { return false } }) ?? null
}

/** `ps -A -o pid= -o args=` output: a pid, then the command line. A line that
 *  is not one is skipped. */
export function parsePsPidArgs(stdout: string): Array<{ pid: number; args: string }> {
  const out: Array<{ pid: number; args: string }> = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const m = /^\s*(\d{1,10})\s+(\S.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    if (validPid(pid)) out.push({ pid, args: m[2] })
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

/**
 * The app's vision browsers for `port`: every main browser process whose
 * command line names this port and one of `profileDirs`, whether or not it
 * listens on the port. One filtered query (Windows: CIM by browser name;
 * elsewhere: `ps -A`, then the facts of the processes naming this port). Any
 * failure, timeout or malformed answer is [] (cannot identify: nothing gets
 * ended).
 */
export async function findAppVisionBrowsers(
  port: number,
  profileDirs: string[],
  ports: OwnerPorts = defaultOwnerPorts(),
): Promise<ProcessFacts[]> {
  if (!validPort(port)) return []
  const dirs = (Array.isArray(profileDirs) ? profileDirs : []).filter((d) => typeof d === 'string' && d !== '')
  if (dirs.length === 0) return []
  const realpath: Realpath = (p) => ports.realpath(p)
  const isApp = (f: ProcessFacts) => dirs.some((d) => isAppVisionBrowser(f, port, d, ports.platform, realpath))
  try {
    if (ports.platform === 'win32') {
      const ps = powershellPath(ports)
      if (!ps) return []
      return parseWindowsFacts(await ports.run(ps, [...POWERSHELL_ARGS, WINDOWS_BROWSERS_SCRIPT], OWNER_QUERY_TIMEOUT_MS)).filter(isApp)
    }
    const ps = posixTool(ports, POSIX_PS)
    if (!ps) return []
    const rows = parsePsPidArgs(await ports.run(ps, ['-A', '-ww', '-o', 'pid=', '-o', 'args='], OWNER_QUERY_TIMEOUT_MS))
    const out: ProcessFacts[] = []
    for (const row of rows) {
      // Only a process naming this port is read further; the full check is isApp.
      if (!posixOnlyValue(row.args, 'remote-debugging-port', String(port))) continue
      const f = await posixFactsOfPid(row.pid, ports)
      if (f && isApp(f)) out.push(f)
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

function signalTree(pid: number, sig: NodeJS.Signals, ports: OwnerPorts): boolean {
  // The negative pid is the process group the browser leads (it is started
  // detached); the pid itself when it leads none.
  try { ports.signal(-pid, sig); return true } catch { /* not a group leader */ }
  try { ports.signal(pid, sig); return true } catch { return false }
}

/**
 * End `target`'s process tree, only if the SAME pid still has the SAME
 * creation time at the moment of the kill. Resolves whether it was ended.
 * Never throws. The caller has identified the process (isAppVisionBrowser)
 * from facts carrying that creation time. On Linux and macOS a browser still
 * running with that start time after POSIX_TERM_GRACE_MS gets SIGKILL.
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
    const startOf = async (): Promise<string | null> => {
      try { return oneLine(await ports.run(ps, ['-p', String(target.pid), '-o', 'lstart='], OWNER_QUERY_TIMEOUT_MS)) } catch { return null }
    }
    if ((await startOf()) !== target.created) return false
    if (!signalTree(target.pid, 'SIGTERM', ports)) return false
    for (let waited = 0; waited < POSIX_TERM_GRACE_MS; waited += POSIX_POLL_MS) {
      await ports.sleep(POSIX_POLL_MS)
      if ((await startOf()) !== target.created) return true
    }
    // The same process after the grace, re-read just above.
    signalTree(target.pid, 'SIGKILL', ports)
    return true
  } catch { return false }
}

// === The app's own browser ===

/** What this module needs of the ChildProcess the app spawned. */
export interface OwnChild {
  readonly pid?: number
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  once(event: 'exit', listener: () => void): unknown
  removeListener(event: 'exit', listener: () => void): unknown
}

/** True while the child's exit has not been observed: libuv still holds the
 *  process, so its pid cannot name another one. */
export function ownChildRunning(child: OwnChild): boolean {
  return !!child && child.exitCode === null && child.signalCode === null
}

/** Resolves true once the child's exit is observed, false after `ms`. Called
 *  right after a kill sent in the same turn, while the child still runs. */
async function exitWithin(child: OwnChild, ms: number, ports: OwnerPorts): Promise<boolean> {
  let onExit: () => void = () => {}
  const exited = new Promise<boolean>((resolve) => { onExit = () => resolve(true); child.once('exit', onExit) })
  try {
    return await Promise.race([exited, ports.sleep(ms).then(() => false)])
  } finally {
    child.removeListener('exit', onExit)
  }
}

/** Windows: taskkill the child's tree by its pid, synchronously, so no event
 *  loop turn (in which its exit could be observed) passes between the check
 *  and the kill. */
function taskkillOwnChild(pid: number, ports: OwnerPorts): boolean {
  const tk = taskkillPath(ports)
  if (!tk) return false
  try {
    ports.runSync(tk, ['/PID', String(pid), '/T', '/F'], OWNER_SYNC_KILL_TIMEOUT_MS)
    return true
  } catch { return false }
}

/**
 * End the app's own browser by its pid, synchronously (stop and quit). Only
 * while its exit has not been observed. Windows: taskkill /T /F, bounded.
 * Linux and macOS: SIGTERM to its process group, a short bounded wait, then
 * SIGKILL to the group (the exit cannot be observed while this blocks, and
 * until it is the pid stays the child's). Returns whether a kill was sent.
 */
export function endOwnChildSync(child: OwnChild, ports: OwnerPorts = defaultOwnerPorts()): boolean {
  if (!ownChildRunning(child) || !validPid(child.pid)) return false
  const pid = child.pid
  if (ports.platform === 'win32') return taskkillOwnChild(pid, ports)
  if (!signalTree(pid, 'SIGTERM', ports)) return false
  try { ports.sleepSync(OWN_QUIT_GRACE_MS) } catch { /* the kill below still runs */ }
  signalTree(pid, 'SIGKILL', ports)
  return true
}

/**
 * End the app's own browser by its pid and wait (bounded) for its exit to be
 * observed (the relaunch path, so the port and the profile are free before
 * the next spawn). Only while its exit has not been observed. Windows: the
 * same bounded taskkill. Linux and macOS: SIGTERM to its process group, and
 * SIGKILL to the group if its exit is not observed within
 * POSIX_TERM_GRACE_MS. Resolves whether its exit was observed.
 */
export async function endOwnChild(child: OwnChild, ports: OwnerPorts = defaultOwnerPorts()): Promise<boolean> {
  if (!ownChildRunning(child) || !validPid(child.pid)) return false
  const pid = child.pid
  if (ports.platform === 'win32') {
    taskkillOwnChild(pid, ports)
    return exitWithin(child, OWN_EXIT_WAIT_MS, ports)
  }
  if (!signalTree(pid, 'SIGTERM', ports)) return false
  if (await exitWithin(child, POSIX_TERM_GRACE_MS, ports)) return true
  // exitWithin resolved false in this same turn (its timer, then microtasks
  // only), so the exit is still not observed and the pid is still the child's.
  signalTree(pid, 'SIGKILL', ports)
  return exitWithin(child, OWN_EXIT_WAIT_MS, ports)
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

/** The longest synchronous wait, whatever is asked. */
const MAX_BLOCK_MS = 1000

/** A bounded synchronous wait. */
function blockFor(ms: number): void {
  const bounded = Math.max(0, Math.min(ms, MAX_BLOCK_MS))
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, bounded)
  } catch {
    const end = Date.now() + bounded
    while (Date.now() < end) { /* bounded */ }
  }
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
    realpath: (p) => { try { return fs.realpathSync.native(p) } catch { return null } },
    sleep: (ms) => new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms)
      if (typeof t.unref === 'function') t.unref()
    }),
    sleepSync: (ms) => blockFor(ms),
  }
}
