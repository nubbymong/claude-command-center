// How vision recognises and ends its own browsers.
//
// - The browser the app spawned in this run is its own child: while its exit has
//   not been observed (exitCode and signalCode both null) its pid stays its own,
//   so it is ended by that pid with no read-back (taskkill /T on Windows, the
//   process group on Linux and macOS, SIGKILL after a grace).
// - A browser left by an earlier run is found by its profile, whether or not it
//   listens: its name, its command line (the exact debug-port argument, a
//   profile argument naming the same folder, no --type=) and its creation time,
//   which the kill re-reads for the same pid.
// No test here starts a program: every OS call goes through a fake OwnerPorts,
// and child_process is replaced so nothing real can run.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const cp = vi.hoisted(() => ({
  spawn: null as null | ((...a: unknown[]) => unknown),
  execFileSync: null as null | ((...a: unknown[]) => unknown),
}))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const refuse = (n: string) => () => { throw new Error(`test: ${n} must not run here`) }
  const over = {
    spawn: (...a: unknown[]) => (cp.spawn ? cp.spawn(...a) : refuse('spawn')()),
    execFileSync: (...a: unknown[]) => (cp.execFileSync ? cp.execFileSync(...a) : refuse('execFileSync')()),
    exec: refuse('exec'), execFile: refuse('execFile'), execSync: refuse('execSync'),
    spawnSync: refuse('spawnSync'), fork: refuse('fork'),
  }
  return { ...actual, ...over, default: { ...actual, ...over } }
})

// The boot path (conductor-mcp-server) runs against a mocked vision-manager.
const boot = vi.hoisted(() => ({
  launchBrowser: vi.fn(),
  startGlobalVision: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../src/main/vision-manager', () => ({
  startGlobalVision: boot.startGlobalVision,
  stopGlobalVision: vi.fn(),
  isGlobalVisionRunning: vi.fn(() => false),
  getGlobalVisionConfig: vi.fn(),
  cleanupLegacyVisionMarkers: vi.fn(),
  getGlobalManager: vi.fn(() => null),
  launchBrowser: boot.launchBrowser,
}))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => undefined }))
vi.mock('../../../src/main/update-watcher', () => ({
  isPackagedApp: () => false,
  getProjectRootPath: () => '',
  hasSourcePath: () => false,
}))

import {
  isAppVisionBrowser, splitWindowsCommandLine, parseWindowsFacts, parsePsPidArgs, findAppVisionBrowsers,
  scanAppVisionBrowsers, profileLockOf,
  factsOfPid, endVerified, endOwnChild, endOwnChildSync, ownChildRunning, runAwait, defaultOwnerPorts,
  VisionPortHeldError, WINDOWS_BROWSERS_SCRIPT, OWNER_QUERY_TIMEOUT_MS, OWNER_SYNC_KILL_TIMEOUT_MS,
  POSIX_TERM_GRACE_MS, OWN_QUIT_GRACE_MS,
  type OwnerPorts, type ProcessFacts, type OwnChild,
} from '../../../src/main/vision-browser-owner'

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe'
const CREATED = '133700000000000000'
const WIN_DIR = 'C:\\Users\\me\\AppData\\Local\\Temp\\chrome-debug-9222'
const WIN_EXE = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'
const winCmd = (switches: string) => `${WIN_EXE} ${switches}`
const WIN_OK = winCmd(`--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=${WIN_DIR} --no-first-run --no-default-browser-check --headless=new`)
const NIX_DIR = '/tmp/chrome-debug-9222'
const nixCmd = (switches: string) => `/opt/google/chrome/chrome ${switches}`
const NIX_OK = nixCmd(`--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=${NIX_DIR} --no-first-run --headless=new`)

const facts = (name: string, commandLine: string, pid = 4242, created = CREATED): ProcessFacts => ({ pid, name, commandLine, created })
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64')

interface Call { file: string; args: string[]; timeoutMs: number; sync: boolean }
function fakePorts(
  platform: NodeJS.Platform,
  answer: (file: string, args: string[], timeoutMs: number) => string | Error,
  opts: {
    exists?: (f: string) => boolean
    signal?: (pid: number, sig: string) => void
    systemRoot?: string | undefined
    realpath?: (p: string) => string | null
    pidGone?: (pid: number) => boolean
  } = {},
) {
  const calls: Call[] = []
  const signals: Array<[number, string]> = []
  const sleeps: number[] = []
  const syncSleeps: number[] = []
  const reply = (file: string, args: string[], timeoutMs: number, sync: boolean) => {
    calls.push({ file, args, timeoutMs, sync })
    const a = answer(file, args, timeoutMs)
    if (a instanceof Error) throw a
    return a
  }
  const ports: OwnerPorts = {
    platform,
    systemRoot: 'systemRoot' in opts ? opts.systemRoot : 'C:\\Windows',
    run: async (file, args, timeoutMs) => reply(file, args, timeoutMs, false),
    runSync: (file, args, timeoutMs) => reply(file, args, timeoutMs, true),
    signal: (pid, sig) => { signals.push([pid, sig]); opts.signal?.(pid, sig) },
    exists: (f) => (opts.exists ? opts.exists(f) : true),
    realpath: (p) => (opts.realpath ? opts.realpath(p) : null),
    sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, 0)) },
    sleepSync: (ms) => { syncSleeps.push(ms) },
    ...(opts.pidGone ? { pidGone: opts.pidGone } : {}),
  }
  return { ports, calls, signals, sleeps, syncSleeps }
}
const scriptOf = (c: Call) => c.args[c.args.length - 1]

describe('isAppVisionBrowser on Windows', () => {
  const ok = (f: ProcessFacts, port = 9222, dir = WIN_DIR, realpath?: (p: string) => string | null) =>
    isAppVisionBrowser(f, port, dir, 'win32', realpath)

  it('matches the app vision browser: browser name, exact port and profile arguments', () => {
    expect(ok(facts('chrome.exe', WIN_OK))).toBe(true)
    expect(ok(facts('CHROME.EXE', WIN_OK))).toBe(true)
    expect(ok(facts('msedge.exe', WIN_OK))).toBe(true)
  })

  it('does not match a program that is not a browser the app launches', () => {
    for (const name of ['node.exe', 'cmd.exe', 'notchrome.exe', 'chrome.exe.old', 'chrome', '']) {
      expect(ok(facts(name, WIN_OK)), name).toBe(false)
    }
  })

  it('needs the port argument exactly: 922 is not 9222, 92220 is not 9222', () => {
    expect(ok(facts('chrome.exe', WIN_OK), 922)).toBe(false)
    expect(ok(facts('chrome.exe', WIN_OK.replace('port=9222', 'port=922')))).toBe(false)
    expect(ok(facts('chrome.exe', WIN_OK.replace('port=9222', 'port=92220')))).toBe(false)
    expect(ok(facts('chrome.exe', WIN_OK.replace('--remote-debugging-port=9222 ', '')))).toBe(false)
    expect(ok(facts('chrome.exe', `${WIN_OK} --remote-debugging-port=1234`))).toBe(false)
  })

  it('needs the profile argument to name the same folder: a prefix or another folder does not match', () => {
    expect(ok(facts('chrome.exe', WIN_OK.replace(WIN_DIR, `${WIN_DIR}-other`)))).toBe(false)
    expect(ok(facts('chrome.exe', WIN_OK), 9222, 'C:\\Users\\me\\AppData\\Local\\Temp\\chrome-debug')).toBe(false)
    expect(ok(facts('chrome.exe', WIN_OK), 9222, `${WIN_DIR}-other`)).toBe(false)
    expect(ok(facts('chrome.exe', WIN_OK.replace(`--user-data-dir=${WIN_DIR} `, '')))).toBe(false)
    expect(ok(facts('chrome.exe', `${WIN_OK} --user-data-dir=C:\\Users\\me\\Profile`))).toBe(false)
    expect(ok(facts('chrome.exe', WIN_OK.replace(WIN_DIR, 'D:\\Temp\\chrome-debug-9222')))).toBe(false)
    expect(ok(facts('chrome.exe', WIN_OK.replace(WIN_DIR, 'chrome-debug-9222')))).toBe(false)
  })

  it('reads a quoted profile path, either way it is quoted', () => {
    const dir = 'C:\\Users\\Jo Doe\\AppData\\Local\\Temp\\chrome-debug-9222'
    expect(ok(facts('chrome.exe', winCmd(`--remote-debugging-port=9222 "--user-data-dir=${dir}" --headless=new`)), 9222, dir)).toBe(true)
    expect(ok(facts('chrome.exe', winCmd(`--remote-debugging-port=9222 --user-data-dir="${dir}" --headless=new`)), 9222, dir)).toBe(true)
    expect(ok(facts('chrome.exe', winCmd(`--remote-debugging-port=9222 "--user-data-dir=${dir}" --headless=new`)), 9222, 'C:\\Users\\Jo')).toBe(false)
  })

  it('B-M8-2: the same profile folder in another case still matches', () => {
    const lower = WIN_OK.replace(WIN_DIR, WIN_DIR.toLowerCase())
    expect(ok(facts('chrome.exe', lower))).toBe(true)
    expect(ok(facts('chrome.exe', WIN_OK), 9222, WIN_DIR.toUpperCase())).toBe(true)
    expect(ok(facts('chrome.exe', WIN_OK.replace(WIN_DIR, `${WIN_DIR}\\`)))).toBe(true)
  })

  it('B-M8-2: the profile folder written with a short (8.3) TEMP still matches, through the real long path', () => {
    const SHORT = 'C:\\Users\\LONGUS~1\\AppData\\Local\\Temp\\chrome-debug-9222'
    const LONG = 'C:\\Users\\longusername\\AppData\\Local\\Temp\\chrome-debug-9222'
    const realpath = (p: string) => (p.toLowerCase() === SHORT.toLowerCase() || p.toLowerCase() === LONG.toLowerCase() ? LONG : null)
    const orphan = facts('chrome.exe', WIN_OK.replace(WIN_DIR, SHORT))
    expect(ok(orphan, 9222, LONG, realpath)).toBe(true)
    // Without the real path the short form is another spelling: no match.
    expect(ok(orphan, 9222, LONG)).toBe(false)
    // A short form of another folder resolves elsewhere: no match.
    const otherReal = (p: string) => (p === SHORT ? 'C:\\Users\\other\\AppData\\Local\\Temp\\chrome-debug-9222' : p === LONG ? LONG : null)
    expect(ok(orphan, 9222, LONG, otherReal)).toBe(false)
  })

  it('resolves the TEMP folder when the profile folder itself is gone', () => {
    const SHORT_T = 'C:\\PROGRA~3\\T'
    const LONG_T = 'C:\\ProgramData\\Temp'
    const realpath = (p: string) => (p === SHORT_T || p === LONG_T ? LONG_T : null)
    expect(ok(facts('chrome.exe', WIN_OK.replace(WIN_DIR, `${SHORT_T}\\chrome-debug-9222`)), 9222, `${LONG_T}\\chrome-debug-9222`, realpath)).toBe(true)
  })

  it('a different last folder never matches, even when both resolve to one place', () => {
    const realpath = () => 'C:\\Same'
    expect(ok(facts('chrome.exe', WIN_OK.replace(WIN_DIR, 'C:\\Temp\\edge-debug-9222')), 9222, 'C:\\Temp\\chrome-debug-9222', realpath)).toBe(false)
  })

  it('a resolver that throws reads as no real path', () => {
    const realpath = () => { throw new Error('EPERM') }
    expect(ok(facts('chrome.exe', WIN_OK), 9222, WIN_DIR, realpath)).toBe(true)
    expect(ok(facts('chrome.exe', WIN_OK.replace(WIN_DIR, 'C:\\X\\chrome-debug-9222')), 9222, WIN_DIR, realpath)).toBe(false)
  })

  it('a relative profile path never matches, even one that would resolve to the folder', () => {
    const realpath = (p: string) => (p === 'chrome-debug-9222' || p === WIN_DIR ? WIN_DIR : null)
    expect(ok(facts('chrome.exe', WIN_OK.replace(WIN_DIR, 'chrome-debug-9222')), 9222, WIN_DIR, realpath)).toBe(false)
    expect(ok(facts('chrome.exe', WIN_OK.replace(WIN_DIR, '.\\chrome-debug-9222')), 9222, WIN_DIR, realpath)).toBe(false)
  })

  it('every profile argument must name the folder', () => {
    expect(ok(facts('chrome.exe', `${WIN_OK} --user-data-dir=${WIN_DIR.toLowerCase()}`))).toBe(true)
    expect(ok(facts('chrome.exe', `${WIN_OK} --user-data-dir=${WIN_DIR}-x`))).toBe(false)
    expect(ok(facts('chrome.exe', `${WIN_OK} --user-data-dir`))).toBe(false)
  })

  it('does not match a child process (--type=)', () => {
    expect(ok(facts('chrome.exe', `${WIN_OK} --type=renderer`))).toBe(false)
    expect(ok(facts('chrome.exe', `${WIN_OK} --type=gpu-process --field-trial-handle=1`))).toBe(false)
  })

  it('does not take a switch that only appears inside another argument', () => {
    const cmd = winCmd(`--app-args=--remote-debugging-port=9222 --user-data-dir=${WIN_DIR}`)
    expect(ok(facts('chrome.exe', cmd))).toBe(false)
  })

  it('splits a command line the way Windows does', () => {
    expect(splitWindowsCommandLine('"C:\\a b\\c.exe" --x="y z" "--w=v u" plain')).toEqual(['C:\\a b\\c.exe', '--x=y z', '--w=v u', 'plain'])
    expect(splitWindowsCommandLine('a "b\\"c" d\\\\"e f"')).toEqual(['a', 'b"c', 'd\\e f'])
  })
})

describe('isAppVisionBrowser on Linux and macOS', () => {
  const ok = (f: ProcessFacts, port = 9222, dir = NIX_DIR, platform: NodeJS.Platform = 'linux', realpath?: (p: string) => string | null) =>
    isAppVisionBrowser(f, port, dir, platform, realpath)

  it('matches the app vision browser', () => {
    expect(ok(facts('chrome', NIX_OK))).toBe(true)
    expect(ok(facts('chromium', NIX_OK))).toBe(true)
    expect(ok(facts('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', NIX_OK), 9222, NIX_DIR, 'darwin')).toBe(true)
  })

  it('does not match another program', () => {
    for (const name of ['node', 'bash', 'python3', 'chrome-helper', '']) expect(ok(facts(name, NIX_OK)), name).toBe(false)
  })

  it('needs the port argument exactly', () => {
    expect(ok(facts('chrome', NIX_OK), 922)).toBe(false)
    expect(ok(facts('chrome', NIX_OK.replace('port=9222', 'port=922')))).toBe(false)
    expect(ok(facts('chrome', NIX_OK.replace('port=9222', 'port=92220')))).toBe(false)
    expect(ok(facts('chrome', `${NIX_OK} --remote-debugging-port=1234`))).toBe(false)
  })

  it('needs the profile argument to name the same folder', () => {
    expect(ok(facts('chrome', NIX_OK.replace(NIX_DIR, `${NIX_DIR}-other`)))).toBe(false)
    expect(ok(facts('chrome', NIX_OK), 9222, '/tmp/chrome-debug')).toBe(false)
    expect(ok(facts('chrome', NIX_OK), 9222, `${NIX_DIR}-other`)).toBe(false)
    expect(ok(facts('chrome', `${NIX_OK} --user-data-dir=/home/me/.config/chrome`))).toBe(false)
    // Case matters off Windows.
    expect(ok(facts('chrome', NIX_OK.replace(NIX_DIR, NIX_DIR.toUpperCase())))).toBe(false)
  })

  it('matches the same folder through its real path (macOS /var and /private/var)', () => {
    const A = '/var/folders/ab/T/chrome-debug-9222'
    const B = '/private/var/folders/ab/T/chrome-debug-9222'
    const realpath = (p: string) => (p === A || p === B ? B : null)
    expect(ok(facts('chrome', NIX_OK.replace(NIX_DIR, A)), 9222, B, 'darwin', realpath)).toBe(true)
    expect(ok(facts('chrome', NIX_OK.replace(NIX_DIR, A)), 9222, B, 'darwin')).toBe(false)
  })

  it('a relative profile path never matches, even one that would resolve to the folder', () => {
    const realpath = (p: string) => (p === 'chrome-debug-9222' || p === NIX_DIR ? NIX_DIR : null)
    expect(ok(facts('chrome', NIX_OK.replace(NIX_DIR, 'chrome-debug-9222')), 9222, NIX_DIR, 'linux', realpath)).toBe(false)
  })

  it('reads the profile argument when it is the last one', () => {
    expect(ok(facts('chrome', nixCmd(`--remote-debugging-port=9222 --user-data-dir=${NIX_DIR}`)))).toBe(true)
    expect(ok(facts('chrome', nixCmd(`--remote-debugging-port=9222 --user-data-dir=${NIX_DIR}x`)))).toBe(false)
  })

  it('reads a profile folder with a space in it', () => {
    const dir = '/Users/Jo Doe/T/chrome-debug-9222'
    expect(ok(facts('chrome', nixCmd(`--remote-debugging-port=9222 --user-data-dir=${dir} --headless=new`)), 9222, dir)).toBe(true)
  })

  it('does not match a child process (--type=)', () => {
    expect(ok(facts('chrome', `${NIX_OK} --type=renderer`))).toBe(false)
  })

  it('does not take a switch that only appears inside another argument', () => {
    expect(ok(facts('chrome', nixCmd(`--app-args=--remote-debugging-port=9222 --user-data-dir=${NIX_DIR}`)))).toBe(false)
  })
})

describe('parsing what the OS reports', () => {
  const one = { pid: 4242, name: 'chrome.exe', commandLine: WIN_OK, created: CREATED }

  it('reads the PowerShell answer: one object or an array, non-ASCII intact', () => {
    expect(parseWindowsFacts(b64(one))).toEqual([one])
    const two = { ...one, pid: 5, commandLine: `C:\\Users\\Zo${String.fromCodePoint(0xeb)}\\x.exe` }
    expect(parseWindowsFacts(b64([one, two]))).toEqual([one, two])
    expect(parseWindowsFacts(b64([]))).toEqual([])
  })

  it('reads anything malformed as no facts at all', () => {
    expect(parseWindowsFacts('')).toEqual([])
    expect(parseWindowsFacts('not base64 at all!')).toEqual([])
    expect(parseWindowsFacts(Buffer.from('{"pid":', 'utf8').toString('base64'))).toEqual([])
    expect(parseWindowsFacts(b64(null))).toEqual([])
    expect(parseWindowsFacts(b64({ ...one, pid: '4242' }))).toEqual([])
    expect(parseWindowsFacts(b64({ ...one, pid: 0 }))).toEqual([])
    expect(parseWindowsFacts(b64({ ...one, created: 'yesterday' }))).toEqual([])
    expect(parseWindowsFacts(b64({ ...one, commandLine: null }))).toEqual([])
    expect(parseWindowsFacts(b64([one, { ...one, name: 7 }]))).toEqual([])
  })

  it('reads ps pid and args lines, and skips a line that is not one', () => {
    expect(parsePsPidArgs(`  311 ${NIX_OK}\n512 /bin/bash -l\n\nnot a row\n  9 \n77777777777 x\n`)).toEqual([
      { pid: 311, args: NIX_OK }, { pid: 512, args: '/bin/bash -l' },
    ])
    expect(parsePsPidArgs('')).toEqual([])
  })
})

describe('finding the app vision browsers on Windows: by profile, whether or not they listen', () => {
  const mine = facts('chrome.exe', WIN_OK, 900)
  const edge = facts('msedge.exe', WIN_OK.replace(WIN_DIR, WIN_DIR.replace('chrome-debug', 'edge-debug')), 901)
  const user = facts('chrome.exe', winCmd('--remote-debugging-port=9222 --user-data-dir=C:\\Users\\me\\Profile'), 902)
  const child = facts('chrome.exe', `${WIN_OK} --type=renderer`, 903)
  const dirs = [WIN_DIR, WIN_DIR.replace('chrome-debug', 'edge-debug')]

  it('asks ONE PowerShell by its absolute path, with a query filtered to the browser names, and matches in TypeScript', async () => {
    const { ports, calls } = fakePorts('win32', () => b64([mine, edge, user, child]))
    expect((await findAppVisionBrowsers(9222, dirs, ports)).map((f) => f.pid)).toEqual([900, 901])
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe(PS)
    expect(calls[0].args).toContain('-NoProfile')
    expect(calls[0].args).toContain('-NonInteractive')
    expect(scriptOf(calls[0])).toBe(WINDOWS_BROWSERS_SCRIPT)
  })

  it('the query is one constant script: filtered by name, never every process, nothing put into it', async () => {
    const queries = WINDOWS_BROWSERS_SCRIPT.match(/Get-CimInstance[^\n]*/g) ?? []
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain("-Filter 'Name=''chrome.exe'' OR Name=''msedge.exe'''")
    expect(WINDOWS_BROWSERS_SCRIPT).toContain('CreationDate.ToFileTimeUtc()')
    expect(WINDOWS_BROWSERS_SCRIPT).not.toMatch(/\d{4}/)
    expect(WINDOWS_BROWSERS_SCRIPT).not.toContain('chrome-debug')
    const a = fakePorts('win32', () => b64([]))
    const b = fakePorts('win32', () => b64([]))
    await findAppVisionBrowsers(9222, dirs, a.ports)
    await findAppVisionBrowsers(9335, ['C:\\x\\chrome-debug-9335'], b.ports)
    expect(scriptOf(a.calls[0])).toBe(scriptOf(b.calls[0]))
  })

  it('B-M8-4: an answer slower than 4 s still identifies (the query has a 20 s bound, async)', async () => {
    expect(OWNER_QUERY_TIMEOUT_MS).toBeGreaterThanOrEqual(20000)
    // The fake answers only when its latency fits the bound it was given.
    const { ports, calls } = fakePorts('win32', (_f, _a, timeoutMs) => (timeoutMs >= 6000 ? b64([mine]) : new Error('timed out')))
    expect((await findAppVisionBrowsers(9222, dirs, ports)).map((f) => f.pid)).toEqual([900])
    expect(calls[0].sync).toBe(false)
  })

  it('B-M8-2: a browser started with TEMP in another case or in its short form is found', async () => {
    const SHORT = 'C:\\Users\\ME~1\\AppData\\Local\\Temp\\chrome-debug-9222'
    const realpath = (p: string) => ([SHORT.toLowerCase(), WIN_DIR.toLowerCase()].includes(p.toLowerCase()) ? WIN_DIR : null)
    const shortOne = facts('chrome.exe', WIN_OK.replace(WIN_DIR, SHORT), 910)
    const caseOne = facts('chrome.exe', WIN_OK.replace(WIN_DIR, WIN_DIR.toUpperCase()), 911)
    const { ports } = fakePorts('win32', () => b64([shortOne, caseOne]), { realpath })
    expect((await findAppVisionBrowsers(9222, dirs, ports)).map((f) => f.pid)).toEqual([910, 911])
  })

  it('finds nothing on a failure, a malformed answer, a bad port or no system folder', async () => {
    expect(await findAppVisionBrowsers(9222, dirs, fakePorts('win32', () => new Error('timed out')).ports)).toEqual([])
    expect(await findAppVisionBrowsers(9222, dirs, fakePorts('win32', () => 'garbage!').ports)).toEqual([])
    for (const port of [0, -1, 65536, 9222.5, Number.NaN]) {
      const { ports, calls } = fakePorts('win32', () => b64([mine]))
      expect(await findAppVisionBrowsers(port, dirs, ports)).toEqual([])
      expect(calls).toHaveLength(0)
    }
    for (const systemRoot of [undefined, 'Windows', '\\Windows']) {
      const { ports, calls } = fakePorts('win32', () => b64([mine]), { systemRoot })
      expect(await findAppVisionBrowsers(9222, dirs, ports)).toEqual([])
      expect(calls).toHaveLength(0)
    }
    const none = fakePorts('win32', () => b64([mine]))
    expect(await findAppVisionBrowsers(9222, [], none.ports)).toEqual([])
    expect(none.calls).toHaveLength(0)
  })

  it('reads one pid with a filtered query, and only that pid', async () => {
    const { ports, calls } = fakePorts('win32', () => b64([mine]))
    expect(await factsOfPid(900, ports)).toEqual(mine)
    expect(scriptOf(calls[0])).toContain('$ids = @(900)')
    expect(calls[0].timeoutMs).toBe(OWNER_QUERY_TIMEOUT_MS)
    expect(await factsOfPid(77, fakePorts('win32', () => b64([mine])).ports)).toBeNull()
    for (const pid of [0, -4, 1.5, Number.NaN]) {
      const f = fakePorts('win32', () => b64([mine]))
      expect(await factsOfPid(pid, f.ports)).toBeNull()
      expect(f.calls).toHaveLength(0)
    }
  })
})

describe('finding the app vision browsers on Linux and macOS: ps, no lsof', () => {
  const table: Record<number, { comm: string; args: string; lstart: string }> = {
    311: { comm: 'chrome', args: NIX_OK, lstart: 'Wed Oct  1 10:00:00 2026' },
    312: { comm: 'chrome', args: `${NIX_OK} --type=renderer`, lstart: 'Wed Oct  1 10:00:01 2026' },
    313: { comm: 'node', args: NIX_OK, lstart: 'Wed Oct  1 10:00:02 2026' },
    314: { comm: 'bash', args: '/bin/bash -l', lstart: 'Wed Oct  1 10:00:03 2026' },
    315: { comm: 'chrome', args: NIX_OK.replace(NIX_DIR, '/home/me/p'), lstart: 'Wed Oct  1 10:00:04 2026' },
  }
  const answer = (file: string, args: string[]) => {
    if (file.endsWith('lsof')) return new Error('test: lsof must not run')
    if (args[0] === '-A') return Object.entries(table).map(([pid, r]) => `${String(pid).padStart(6)} ${r.args}`).join('\n') + '\n'
    const pid = Number(args[args.indexOf('-p') + 1])
    const row = table[pid]
    if (!row) return new Error('exited with status 1')
    const field = args[args.indexOf('-o') + 1]
    return (field === 'comm=' ? row.comm : field === 'args=' ? row.args : row.lstart) + '\n'
  }

  it('B-M8-3: with no lsof on the machine, ps alone finds the browser by its profile', async () => {
    const { ports, calls } = fakePorts('linux', answer, { exists: (f) => f === '/bin/ps' })
    expect(await findAppVisionBrowsers(9222, [NIX_DIR], ports)).toEqual([
      { pid: 311, name: 'chrome', commandLine: NIX_OK, created: 'Wed Oct  1 10:00:00 2026' },
    ])
    expect(calls[0].file).toBe('/bin/ps')
    expect(calls[0].args).toEqual(['-A', '-ww', '-o', 'pid=', '-o', 'args='])
    expect(calls.every((c) => c.file === '/bin/ps' && !c.sync)).toBe(true)
    // Only the rows naming this debug port are read further.
    const perPid = new Set(calls.slice(1).map((c) => c.args[c.args.indexOf('-p') + 1]))
    expect([...perPid].sort()).toEqual(['311', '312', '313', '315'])
  })

  it('finds nothing on a failure or with no ps', async () => {
    expect(await findAppVisionBrowsers(9222, [NIX_DIR], fakePorts('linux', () => new Error('exited with status 1')).ports)).toEqual([])
    const noPs = fakePorts('linux', answer, { exists: () => false })
    expect(await findAppVisionBrowsers(9222, [NIX_DIR], noPs.ports)).toEqual([])
    expect(noPs.calls).toHaveLength(0)
  })
})

describe('ending a verified process on Windows', () => {
  const target = facts('chrome.exe', WIN_OK)

  it('re-reads the same pid and ends its tree only when its creation time still matches', async () => {
    const { ports, calls } = fakePorts('win32', () => 'ended\r\n')
    expect(await endVerified(target, ports)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe(PS)
    expect(calls[0].sync).toBe(false)
    expect(calls[0].timeoutMs).toBe(OWNER_QUERY_TIMEOUT_MS)
    const script = scriptOf(calls[0])
    expect(script).toContain("Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=4242'")
    // taskkill runs only inside the branch taken when the creation time matches.
    expect(script).toMatch(new RegExp(
      "if \\(\\$p -and \\(\\[string\\]\\$p\\.CreationDate\\.ToFileTimeUtc\\(\\)\\) -eq '" + CREATED + "'\\) \\{\\n" +
      "  & \\(Join-Path \\(\\[Environment\\]::SystemDirectory\\) 'taskkill\\.exe'\\) /PID 4242 /T /F \\| Out-Null\\n" +
      "  'ended'\\n\\} else \\{ 'left' \\}$",
    ))
    expect(script.match(/taskkill/g)).toHaveLength(1)
  })

  it('reports a process that was left running', async () => {
    expect(await endVerified(target, fakePorts('win32', () => 'left').ports)).toBe(false)
    expect(await endVerified(target, fakePorts('win32', () => new Error('timed out')).ports)).toBe(false)
  })

  it('never builds a script with the profile path or the command line in it', async () => {
    const { ports, calls } = fakePorts('win32', () => 'ended')
    await endVerified(target, ports)
    for (const c of calls) {
      const script = scriptOf(c)
      expect(script).not.toContain(WIN_DIR)
      expect(script).not.toContain('chrome-debug')
      expect(script).not.toContain('user-data-dir')
      expect(script).not.toContain('Program Files')
    }
  })

  it('runs nothing for a pid or a creation time that is not plain digits', async () => {
    for (const bad of [{ pid: 0, created: CREATED }, { pid: 4242, created: 'not-a-number' }, { pid: 4242, created: '12 34' }, { pid: 4242, created: '' }]) {
      const { ports, calls } = fakePorts('win32', () => 'ended')
      expect(await endVerified(bad, ports)).toBe(false)
      expect(calls).toHaveLength(0)
    }
  })
})

describe('ending a verified process on Linux and macOS', () => {
  const LSTART = 'Wed Oct  1 10:00:00 2026'
  const target = facts('chrome', NIX_OK, 4242, LSTART)
  /** ps answers `lstart` for pid 4242 while it runs; `alive` says whether it does. */
  const psFor = (alive: () => boolean, start = LSTART) => (file: string, args: string[]) => {
    expect(file).toBe('/bin/ps')
    expect(args).toEqual(['-p', '4242', '-o', 'lstart='])
    return alive() ? `${start}\n` : new Error('exited with status 1')
  }

  it('signals the process group only when the start time still matches, and stops once it is gone', async () => {
    let alive = true
    const same = fakePorts('linux', psFor(() => alive), { signal: (_p, sig) => { if (sig === 'SIGTERM') alive = false } })
    expect(await endVerified(target, same.ports)).toBe(true)
    expect(same.signals).toEqual([[-4242, 'SIGTERM']])

    const changed = fakePorts('linux', psFor(() => true, 'Wed Oct  1 10:00:01 2026'))
    expect(await endVerified(target, changed.ports)).toBe(false)
    expect(changed.signals).toEqual([])

    const gone = fakePorts('linux', psFor(() => false))
    expect(await endVerified(target, gone.ports)).toBe(false)
    expect(gone.signals).toEqual([])
  })

  it('sends SIGKILL to the group when it is still the same process after the grace', async () => {
    let alive = true
    const f = fakePorts('linux', psFor(() => alive), { signal: (_p, sig) => { if (sig === 'SIGKILL') alive = false } })
    expect(await endVerified(target, f.ports)).toBe(true)
    expect(f.signals).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']])
    expect(f.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(POSIX_TERM_GRACE_MS)
  })

  it('does not send SIGKILL when the pid now has another start time', async () => {
    let start = LSTART
    const f = fakePorts('linux', (file, args) => psFor(() => true, start)(file, args), { signal: (_p, sig) => { if (sig === 'SIGTERM') start = 'Thu Oct  2 10:00:00 2026' } })
    expect(await endVerified(target, f.ports)).toBe(true)
    expect(f.signals).toEqual([[-4242, 'SIGTERM']])
  })

  it('signals the pid itself when it leads no process group', async () => {
    let alive = true
    const f = fakePorts('linux', psFor(() => alive), { signal: (pid) => { if (pid < 0) throw new Error('ESRCH'); alive = false } })
    expect(await endVerified(target, f.ports)).toBe(true)
    expect(f.signals).toEqual([[-4242, 'SIGTERM'], [4242, 'SIGTERM']])
  })
})

/** A ChildProcess stand-in: exitCode/signalCode stay null until its exit is
 *  observed (emitted), as libuv does. */
function fakeOwnChild(pid = 4242, onKill: (exit: (sig?: NodeJS.Signals | null) => void) => void = () => {}) {
  const c = new EventEmitter() as EventEmitter & { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill: (sig?: NodeJS.Signals | number) => boolean }
  c.pid = pid
  c.exitCode = null
  c.signalCode = null
  const exit = (sig: NodeJS.Signals | null = null) => queueMicrotask(() => {
    if (sig) c.signalCode = sig; else c.exitCode = 1
    c.emit('exit', c.exitCode, c.signalCode)
  })
  // P3.16a round 2 (Q5): ChildProcess.kill ends the process through its handle.
  const kills: Array<NodeJS.Signals | number | undefined> = []
  c.kill = (sig) => { kills.push(sig); onKill(exit); return true }
  return { child: c as unknown as OwnChild & EventEmitter, exit, raw: c, kills }
}

describe("ending the app's own browser by its pid", () => {
  it('is running only while neither an exit code nor a signal was observed', () => {
    const { raw } = fakeOwnChild()
    expect(ownChildRunning(raw as unknown as OwnChild)).toBe(true)
    raw.exitCode = 0
    expect(ownChildRunning(raw as unknown as OwnChild)).toBe(false)
    raw.exitCode = null; raw.signalCode = 'SIGTERM'
    expect(ownChildRunning(raw as unknown as OwnChild)).toBe(false)
  })

  it('Windows, sync: taskkill /T /F by the absolute System32 path, bounded, no read-back', () => {
    const { child } = fakeOwnChild()
    const { ports, calls } = fakePorts('win32', () => 'SUCCESS')
    expect(endOwnChildSync(child, ports)).toBe(true)
    expect(calls).toEqual([{ file: TASKKILL, args: ['/PID', '4242', '/T', '/F'], timeoutMs: OWNER_SYNC_KILL_TIMEOUT_MS, sync: true }])
  })

  it('Windows, async (the relaunch, round 2, Q5): the child\'s own kill, through its process handle, nothing run and nothing blocking; then it waits for the exit', async () => {
    const { child, kills } = fakeOwnChild(4242, (exit) => exit('SIGTERM'))
    const { ports, calls } = fakePorts('win32', () => 'SUCCESS')
    expect(await endOwnChild(child, ports)).toBe(true)
    expect(kills).toEqual([undefined])
    expect(calls).toEqual([])
    expect(ownChildRunning(child)).toBe(false)
  })

  it('Windows, async: a child whose kill throws, or whose exit is not observed within the wait, reads as not ended', async () => {
    const throwing = fakeOwnChild()
    throwing.raw.kill = () => { throw new Error('EPERM') }
    const a = fakePorts('win32', () => 'SUCCESS')
    expect(await endOwnChild(throwing.child, a.ports)).toBe(false)
    const silent = fakeOwnChild()
    const b = fakePorts('win32', () => 'SUCCESS')
    expect(await endOwnChild(silent.child, b.ports)).toBe(false)
    expect(silent.kills).toEqual([undefined])
    expect(b.calls).toEqual([])
  })

  it('does nothing once its exit was observed, or with no pid', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const done = fakeOwnChild()
      done.raw.exitCode = 0
      const a = fakePorts(platform, () => 'SUCCESS')
      expect(endOwnChildSync(done.child, a.ports)).toBe(false)
      expect(await endOwnChild(done.child, a.ports)).toBe(false)
      const killed = fakeOwnChild()
      killed.raw.signalCode = 'SIGKILL'
      expect(endOwnChildSync(killed.child, a.ports)).toBe(false)
      const noPid = fakeOwnChild()
      noPid.raw.pid = undefined
      expect(endOwnChildSync(noPid.child, a.ports)).toBe(false)
      expect(await endOwnChild(noPid.child, a.ports)).toBe(false)
      expect(a.calls).toHaveLength(0)
      expect(a.signals).toHaveLength(0)
    }
  })

  it('Windows: no system folder, nothing run', () => {
    const { child } = fakeOwnChild()
    const { ports, calls } = fakePorts('win32', () => 'SUCCESS', { systemRoot: undefined })
    expect(endOwnChildSync(child, ports)).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('POSIX, async: SIGTERM to its group, and no SIGKILL when it exits within the grace', async () => {
    const { child, exit } = fakeOwnChild()
    const { ports, signals, calls } = fakePorts('linux', () => '', { signal: (_p, sig) => { if (sig === 'SIGTERM') exit('SIGTERM') } })
    expect(await endOwnChild(child, ports)).toBe(true)
    expect(signals).toEqual([[-4242, 'SIGTERM']])
    expect(calls).toHaveLength(0)
  })

  it('POSIX, async: SIGKILL to its group when its exit is not observed within the grace', async () => {
    const { child, exit } = fakeOwnChild()
    const { ports, signals, sleeps } = fakePorts('linux', () => '', { signal: (_p, sig) => { if (sig === 'SIGKILL') exit('SIGKILL') } })
    expect(await endOwnChild(child, ports)).toBe(true)
    expect(signals).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']])
    expect(sleeps[0]).toBe(POSIX_TERM_GRACE_MS)
  })

  it('POSIX, sync (quit): SIGTERM, a short bounded wait, then SIGKILL to the group', () => {
    const { child } = fakeOwnChild()
    const { ports, signals, syncSleeps, calls } = fakePorts('linux', () => '')
    expect(endOwnChildSync(child, ports)).toBe(true)
    expect(signals).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']])
    expect(syncSleeps).toEqual([OWN_QUIT_GRACE_MS])
    expect(OWN_QUIT_GRACE_MS).toBeLessThanOrEqual(1000)
    expect(calls).toHaveLength(0)
  })
})

// P3.16a round 2 (Q4): the launch must tell "the query found none" from "the
// query could not answer": only the first lets a launch go ahead while a
// profile folder is locked.
describe('the browser query: none found, or no answer', () => {
  it('Windows: an answer naming no browser is none found; a failed or timed-out run, a malformed answer, an empty answer or no system folder is no answer', async () => {
    const none = fakePorts('win32', () => b64([]))
    expect(await scanAppVisionBrowsers(9222, [WIN_DIR], none.ports)).toEqual([])
    for (const [label, answer, extra] of [
      ['timed out', () => new Error('timed out'), {}],
      ['malformed', () => 'not base64 !!', {}],
      ['an object of the wrong shape', () => b64([{ pid: 'x' }]), {}],
      ['empty', () => '', {}],
      ['no system folder', () => b64([]), { systemRoot: undefined }],
    ] as Array<[string, () => string | Error, { systemRoot?: string | undefined }]>) {
      const f = fakePorts('win32', answer, extra)
      expect(await scanAppVisionBrowsers(9222, [WIN_DIR], f.ports), label).toBeNull()
      // The older question still reads "no answer" as nothing to end.
      expect(await findAppVisionBrowsers(9222, [WIN_DIR], f.ports), label).toEqual([])
    }
  })

  it('Linux and macOS: no process naming the port is none found; no ps, or a failed ps, is no answer', async () => {
    const none = fakePorts('linux', () => '    1 /sbin/init\n')
    expect(await scanAppVisionBrowsers(9222, [NIX_DIR], none.ports)).toEqual([])
    const noPs = fakePorts('linux', () => '', { exists: () => false })
    expect(await scanAppVisionBrowsers(9222, [NIX_DIR], noPs.ports)).toBeNull()
    const failed = fakePorts('linux', () => new Error('timed out'))
    expect(await scanAppVisionBrowsers(9222, [NIX_DIR], failed.ports)).toBeNull()
  })

  // Fixer 3 (F3, lens B VA2): a process naming the port that exits between
  // the list and its own read names nothing now: it is skipped, and the
  // browsers identified are kept. One that still runs, or may (no way to
  // tell), and cannot be read cannot be told apart: no answer.
  it('Linux and macOS: a row naming the port that has exited since the list is skipped; one that still runs and cannot be read is no answer', async () => {
    const answer = (file: string, args: string[]) => {
      if (args[0] === '-A') return `   312 ${NIX_OK} --type=renderer\n   311 ${NIX_OK}\n`
      const pid = Number(args[args.indexOf('-p') + 1])
      if (pid !== 311) return new Error('exited with status 1')
      const field = args[args.indexOf('-o') + 1]
      return (field === 'comm=' ? 'chrome' : field === 'args=' ? NIX_OK : 'Wed Oct  1 10:00:00 2026') + '\n'
    }
    const asked: number[] = []
    const gone = fakePorts('linux', answer, { pidGone: (pid) => { asked.push(pid); return pid === 312 } })
    expect(await scanAppVisionBrowsers(9222, [NIX_DIR], gone.ports)).toEqual([
      { pid: 311, name: 'chrome', commandLine: NIX_OK, created: 'Wed Oct  1 10:00:00 2026' },
    ])
    // Asked only about the row it could not read.
    expect(asked).toEqual([312])
    const running = fakePorts('linux', answer, { pidGone: () => false })
    expect(await scanAppVisionBrowsers(9222, [NIX_DIR], running.ports)).toBeNull()
    const cannotTell = fakePorts('linux', answer, { pidGone: () => { throw new Error('no answer') } })
    expect(await scanAppVisionBrowsers(9222, [NIX_DIR], cannotTell.ports)).toBeNull()
    const noPort = fakePorts('linux', answer)
    expect(await scanAppVisionBrowsers(9222, [NIX_DIR], noPort.ports)).toBeNull()
  })
})

// P3.16a round 2 (Q4, Q5): whether a browser profile folder is locked, read
// the way the browser locks it. Windows: the browser keeps `lockfile` open for
// writing while it runs, sharing it with readers only (a crash closes it, and
// it is deleted on close), so it can be opened for writing only when no
// browser holds it. Linux and macOS: `SingletonLock` is a link naming the
// host and the browser's pid; it is left behind by a crash.
describe('profileLockOf', () => {
  const win = (open: 'ok' | 'missing' | 'busy' | 'error') => {
    const opened: string[] = []
    return { opened, deps: { platform: 'win32' as const, tryOpenForWrite: (f: string) => { opened.push(f); return open }, readlink: () => { throw new Error('not on Windows') }, alive: () => { throw new Error('not on Windows') }, hostname: () => 'h' } }
  }
  it('Windows: no lockfile is free; one open for writing elsewhere is held; one that opens is a stale file (free); any other error is unknown', () => {
    for (const [open, state] of [['missing', 'free'], ['busy', 'held'], ['ok', 'free'], ['error', 'unknown']] as const) {
      const { opened, deps } = win(open)
      expect(profileLockOf(WIN_DIR, deps), open).toBe(state)
      expect(opened, open).toEqual([path.win32.join(WIN_DIR, 'lockfile')])
    }
  })

  const nix = (link: string | null | Error, alive: (pid: number) => boolean = () => true, host = 'box') => ({
    platform: 'linux' as const,
    tryOpenForWrite: () => { throw new Error('not on POSIX') },
    readlink: (f: string) => { expect(f).toBe(path.posix.join(NIX_DIR, 'SingletonLock')); if (link instanceof Error) throw link; return link },
    alive,
    hostname: () => host,
  })
  it('Linux and macOS: no SingletonLock is free; one naming this host and a live pid is held; a dead pid is a crash\'s (free); another host is held; anything else is unknown', () => {
    expect(profileLockOf(NIX_DIR, nix(null))).toBe('free')
    expect(profileLockOf(NIX_DIR, nix('box-4242', (p) => p === 4242))).toBe('held')
    expect(profileLockOf(NIX_DIR, nix('box-4242', () => false))).toBe('free')
    expect(profileLockOf(NIX_DIR, nix('my-box-1-4242', (p) => p === 4242, 'my-box-1'))).toBe('held')
    expect(profileLockOf(NIX_DIR, nix('other-4242', () => false))).toBe('held')
    expect(profileLockOf(NIX_DIR, nix('box-notapid', () => false))).toBe('unknown')
    expect(profileLockOf(NIX_DIR, nix('box-0', () => false))).toBe('unknown')
    expect(profileLockOf(NIX_DIR, nix(new Error('EACCES')))).toBe('unknown')
    expect(profileLockOf(NIX_DIR, nix('box-4242', () => { throw new Error('EINVAL') }))).toBe('unknown')
  })
  it('an empty folder name, or a dependency that throws, is unknown', () => {
    expect(profileLockOf('', win('missing').deps)).toBe('unknown')
    expect(profileLockOf(WIN_DIR, { ...win('missing').deps, tryOpenForWrite: () => { throw new Error('boom') } })).toBe('unknown')
  })
})

describe('the real runner (child_process replaced)', () => {
  beforeEach(() => { cp.spawn = null; cp.execFileSync = null })

  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter & { setEncoding: () => void }; kill: ReturnType<typeof vi.fn> }
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} })
    child.kill = vi.fn()
    return child
  }

  it('spawns with no shell and resolves the output on a clean exit', async () => {
    const child = fakeChild()
    const seen: unknown[][] = []
    cp.spawn = (...a: unknown[]) => { seen.push(a); queueMicrotask(() => { child.stdout.emit('data', 'abc'); child.emit('close', 0) }); return child }
    await expect(runAwait('/bin/ps', ['-p', '1'], 1000)).resolves.toBe('abc')
    const opts = seen[0][2] as Record<string, unknown>
    expect(seen[0][0]).toBe('/bin/ps')
    expect(opts.shell).toBeUndefined()
    expect(opts.windowsHide).toBe(true)
  })

  it('rejects on another status, an error, or the timeout (and ends the program)', async () => {
    const a = fakeChild()
    cp.spawn = () => { queueMicrotask(() => a.emit('close', 1)); return a }
    await expect(runAwait('/bin/ps', [], 1000)).rejects.toThrow()
    const b = fakeChild()
    cp.spawn = () => { queueMicrotask(() => b.emit('error', new Error('ENOENT'))); return b }
    await expect(runAwait('/bin/ps', [], 1000)).rejects.toThrow('ENOENT')
    const c = fakeChild()
    cp.spawn = () => c
    await expect(runAwait('/bin/ps', [], 20)).rejects.toThrow('timed out')
    expect(c.kill).toHaveBeenCalled()
  })

  it('the synchronous runner has a timeout and no shell', () => {
    const seen: unknown[][] = []
    cp.execFileSync = (...a: unknown[]) => { seen.push(a); return 'left' }
    expect(defaultOwnerPorts().runSync('/bin/ps', ['-p', '1'], 5000)).toBe('left')
    const opts = seen[0][2] as Record<string, unknown>
    expect(opts.timeout).toBe(5000)
    expect(opts.shell).toBeUndefined()
    expect(opts.windowsHide).toBe(true)
  })

  it('the real path is the folder resolved by the OS, or null when it does not exist', () => {
    const base = os.tmpdir()
    const dir = fs.mkdtempSync(path.join(base, 'n7-owner-'))
    try {
      expect(defaultOwnerPorts().realpath(dir)).toBe(fs.realpathSync.native(dir))
      expect(defaultOwnerPorts().realpath(path.join(dir, 'missing'))).toBeNull()
    } finally {
      fs.rmdirSync(dir)
    }
  })

  // Fixer 3 (F3): signal 0 only asks whether the pid exists; nothing is sent.
  it('a pid is gone only when the OS says no process has it (ESRCH); a process it may not signal still runs', () => {
    const kill = vi.spyOn(process, 'kill')
    const fail = (code: string) => () => { throw Object.assign(new Error(`kill ${code}`), { code }) }
    try {
      kill.mockImplementation(fail('ESRCH'))
      expect(defaultOwnerPorts().pidGone?.(4242)).toBe(true)
      kill.mockImplementation(fail('EPERM'))
      expect(defaultOwnerPorts().pidGone?.(4242)).toBe(false)
      kill.mockImplementation(fail('EINVAL'))
      expect(defaultOwnerPorts().pidGone?.(4242)).toBe(false)
      kill.mockImplementation(() => true)
      expect(defaultOwnerPorts().pidGone?.(4242)).toBe(false)
      expect(kill.mock.calls).toEqual([[4242, 0], [4242, 0], [4242, 0], [4242, 0]])
    } finally {
      kill.mockRestore()
    }
  })

  it('the sync wait returns, and never blocks longer than a second whatever is asked', () => {
    const t0 = Date.now()
    defaultOwnerPorts().sleepSync(20)
    expect(Date.now() - t0).toBeLessThan(1000)
    const t1 = Date.now()
    defaultOwnerPorts().sleepSync(30000)
    expect(Date.now() - t1).toBeLessThan(2500)
  })
})

describe('boot: vision is not started while its debug port stays in use', () => {
  it('names the port in its message', () => {
    const e = new VisionPortHeldError(9322)
    expect(e.message).toBe("the vision browser's debug port 9322 is in use; vision was not started")
    expect(e.port).toBe(9322)
  })

  it('does not start vision when the launch reports the debug port in use', async () => {
    const { startBrowserAtBoot } = await import('../../../src/main/conductor-mcp-server')
    boot.startGlobalVision.mockClear()
    boot.launchBrowser.mockReset()
    boot.launchBrowser.mockRejectedValueOnce(new VisionPortHeldError(9322))
    await startBrowserAtBoot(() => null)
    expect(boot.launchBrowser).toHaveBeenCalledTimes(1)
    expect(boot.startGlobalVision).not.toHaveBeenCalled()
  })

  it('still starts vision after any other launch failure', async () => {
    const { startBrowserAtBoot } = await import('../../../src/main/conductor-mcp-server')
    boot.startGlobalVision.mockClear()
    boot.launchBrowser.mockReset()
    boot.launchBrowser.mockRejectedValueOnce(new Error('no browser found'))
    await startBrowserAtBoot(() => null)
    expect(boot.startGlobalVision).toHaveBeenCalledTimes(1)
  })
})
