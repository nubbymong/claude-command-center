// The vision browser is ended only when it is verified as the app's own: by its
// name, its command line and its creation time, and the kill re-reads the
// creation time of the same pid immediately before ending it. A pid alone is
// never enough. No test here starts a program: every OS call goes through a
// fake OwnerPorts, and child_process is replaced so nothing real can run.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

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
  isAppVisionBrowser, splitWindowsCommandLine, parseWindowsFacts, parseLsofPids,
  listenerFacts, factsOfPid, endVerified, endVerifiedSync, runAwait, defaultOwnerPorts,
  VisionPortHeldError, OWNER_QUERY_TIMEOUT_MS, OWNER_SYNC_KILL_TIMEOUT_MS,
  type OwnerPorts, type ProcessFacts,
} from '../../../src/main/vision-browser-owner'

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
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
  answer: (file: string, args: string[]) => string | Error,
  opts: { exists?: (f: string) => boolean; signal?: (pid: number) => void; systemRoot?: string | undefined } = {},
) {
  const calls: Call[] = []
  const signals: Array<[number, string]> = []
  const reply = (file: string, args: string[], timeoutMs: number, sync: boolean) => {
    calls.push({ file, args, timeoutMs, sync })
    const a = answer(file, args)
    if (a instanceof Error) throw a
    return a
  }
  const ports: OwnerPorts = {
    platform,
    systemRoot: 'systemRoot' in opts ? opts.systemRoot : 'C:\\Windows',
    run: async (file, args, timeoutMs) => reply(file, args, timeoutMs, false),
    runSync: (file, args, timeoutMs) => reply(file, args, timeoutMs, true),
    signal: (pid, sig) => { signals.push([pid, sig]); opts.signal?.(pid) },
    exists: (f) => (opts.exists ? opts.exists(f) : true),
  }
  return { ports, calls, signals }
}
const scriptOf = (c: Call) => c.args[c.args.length - 1]

describe('isAppVisionBrowser on Windows', () => {
  const ok = (f: ProcessFacts, port = 9222, dir = WIN_DIR) => isAppVisionBrowser(f, port, dir, 'win32')

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

  it('needs the profile argument exactly: a folder that is a prefix of another does not match', () => {
    expect(ok(facts('chrome.exe', WIN_OK.replace(WIN_DIR, `${WIN_DIR}-other`)))).toBe(false)
    expect(ok(facts('chrome.exe', WIN_OK), 9222, 'C:\\Users\\me\\AppData\\Local\\Temp\\chrome-debug')).toBe(false)
    expect(ok(facts('chrome.exe', WIN_OK), 9222, `${WIN_DIR}-other`)).toBe(false)
    expect(ok(facts('chrome.exe', WIN_OK.replace(`--user-data-dir=${WIN_DIR} `, '')))).toBe(false)
    expect(ok(facts('chrome.exe', `${WIN_OK} --user-data-dir=C:\\Users\\me\\Profile`))).toBe(false)
  })

  it('reads a quoted profile path, either way it is quoted', () => {
    const dir = 'C:\\Users\\Jo Doe\\AppData\\Local\\Temp\\chrome-debug-9222'
    expect(ok(facts('chrome.exe', winCmd(`--remote-debugging-port=9222 "--user-data-dir=${dir}" --headless=new`)), 9222, dir)).toBe(true)
    expect(ok(facts('chrome.exe', winCmd(`--remote-debugging-port=9222 --user-data-dir="${dir}" --headless=new`)), 9222, dir)).toBe(true)
    expect(ok(facts('chrome.exe', winCmd(`--remote-debugging-port=9222 "--user-data-dir=${dir}" --headless=new`)), 9222, 'C:\\Users\\Jo')).toBe(false)
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
  const ok = (f: ProcessFacts, port = 9222, dir = NIX_DIR, platform: NodeJS.Platform = 'linux') => isAppVisionBrowser(f, port, dir, platform)

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

  it('needs the profile argument exactly', () => {
    expect(ok(facts('chrome', NIX_OK.replace(NIX_DIR, `${NIX_DIR}-other`)))).toBe(false)
    expect(ok(facts('chrome', NIX_OK), 9222, '/tmp/chrome-debug')).toBe(false)
    expect(ok(facts('chrome', NIX_OK), 9222, `${NIX_DIR}-other`)).toBe(false)
    expect(ok(facts('chrome', `${NIX_OK} --user-data-dir=/home/me/.config/chrome`))).toBe(false)
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

  it('reads lsof pids, one a line, and anything else as none', () => {
    expect(parseLsofPids('311\n512\n311\n')).toEqual([311, 512])
    expect(parseLsofPids('')).toEqual([])
    expect(parseLsofPids('COMMAND PID USER\n311\n')).toEqual([])
  })
})

describe('reading the listeners on Windows', () => {
  const chromeFacts = facts('chrome.exe', WIN_OK)

  it('asks ONE PowerShell by its absolute path, for this port, with filtered process queries', async () => {
    const { ports, calls } = fakePorts('win32', () => b64([chromeFacts]))
    expect(await listenerFacts(9222, ports)).toEqual([chromeFacts])
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe(PS)
    expect(calls[0].args).toContain('-NoProfile')
    expect(calls[0].args).toContain('-NonInteractive')
    expect(calls[0].timeoutMs).toBe(OWNER_QUERY_TIMEOUT_MS)
    const script = scriptOf(calls[0])
    expect(script).toContain('Get-NetTCPConnection -State Listen -LocalPort 9222 ')
    expect(script).toContain('CreationDate.ToFileTimeUtc()')
    // Never every process: each process query is filtered to one ProcessId.
    const queries = script.match(/Get-CimInstance[^\n]*/g) ?? []
    expect(queries.length).toBeGreaterThan(0)
    for (const q of queries) expect(q).toMatch(/-Filter \('ProcessId=' \+ \[uint32\]\$id\)/)
  })

  it('cannot identify on a failure, a malformed answer, a bad port or no system folder: nothing', async () => {
    expect(await listenerFacts(9222, fakePorts('win32', () => new Error('timed out')).ports)).toEqual([])
    expect(await listenerFacts(9222, fakePorts('win32', () => 'garbage!').ports)).toEqual([])
    for (const port of [0, -1, 65536, 9222.5, Number.NaN]) {
      const { ports, calls } = fakePorts('win32', () => b64([chromeFacts]))
      expect(await listenerFacts(port, ports)).toEqual([])
      expect(calls).toHaveLength(0)
    }
    for (const systemRoot of [undefined, 'Windows', '\\Windows']) {
      const { ports, calls } = fakePorts('win32', () => b64([chromeFacts]), { systemRoot })
      expect(await listenerFacts(9222, ports)).toEqual([])
      expect(calls).toHaveLength(0)
    }
  })

  it('reads one pid with a filtered query, and only that pid', async () => {
    const { ports, calls } = fakePorts('win32', () => b64([chromeFacts]))
    expect(await factsOfPid(4242, ports)).toEqual(chromeFacts)
    expect(scriptOf(calls[0])).toContain('$ids = @(4242)')
    expect(scriptOf(calls[0])).not.toContain('Get-NetTCPConnection')
    expect(await factsOfPid(77, fakePorts('win32', () => b64([chromeFacts])).ports)).toBeNull()
    for (const pid of [0, -4, 1.5, Number.NaN]) {
      const f = fakePorts('win32', () => b64([chromeFacts]))
      expect(await factsOfPid(pid, f.ports)).toBeNull()
      expect(f.calls).toHaveLength(0)
    }
  })
})

describe('reading the listeners on Linux and macOS', () => {
  const answer = (table: Record<number, { comm: string; args: string; lstart: string }>) => (file: string, args: string[]) => {
    if (file.endsWith('lsof')) return Object.keys(table).join('\n') + '\n'
    const pid = Number(args[args.indexOf('-p') + 1])
    const row = table[pid]
    if (!row) return new Error('exited with status 1')
    const field = args[args.indexOf('-o') + 1]
    return (field === 'comm=' ? row.comm : field === 'args=' ? row.args : row.lstart) + '\n'
  }

  it('asks lsof for this port, then ps for each pid, by absolute paths', async () => {
    const { ports, calls } = fakePorts('linux', answer({ 311: { comm: 'chrome', args: NIX_OK, lstart: 'Wed Oct  1 10:00:00 2026' } }))
    expect(await listenerFacts(9222, ports)).toEqual([{ pid: 311, name: 'chrome', commandLine: NIX_OK, created: 'Wed Oct  1 10:00:00 2026' }])
    expect(calls[0].file).toBe('/usr/sbin/lsof')
    expect(calls[0].args).toEqual(['-nP', '-iTCP:9222', '-sTCP:LISTEN', '-t'])
    const fields = calls.slice(1).map((c) => [c.file, c.args.join(' ')])
    expect(fields).toEqual(expect.arrayContaining([
      ['/bin/ps', '-ww -p 311 -o comm='], ['/bin/ps', '-ww -p 311 -o args='], ['/bin/ps', '-ww -p 311 -o lstart='],
    ]))
  })

  it('cannot identify on a failure or no lsof: nothing', async () => {
    expect(await listenerFacts(9222, fakePorts('linux', () => new Error('exited with status 1')).ports)).toEqual([])
    const noLsof = fakePorts('linux', () => '311\n', { exists: (f) => !f.endsWith('lsof') })
    expect(await listenerFacts(9222, noLsof.ports)).toEqual([])
    expect(noLsof.calls).toHaveLength(0)
  })

  it('skips a pid whose facts cannot be read', async () => {
    const { ports } = fakePorts('linux', (file, args) => (file.endsWith('lsof') ? '311\n512\n' : answer({ 512: { comm: 'chrome', args: NIX_OK, lstart: 'x' } })(file, args)))
    expect((await listenerFacts(9222, ports)).map((f) => f.pid)).toEqual([512])
  })
})

describe('ending a verified process on Windows', () => {
  const target = facts('chrome.exe', WIN_OK)

  it('re-reads the same pid and ends its tree only when its creation time still matches', async () => {
    const { ports, calls } = fakePorts('win32', () => 'ended\r\n')
    expect(await endVerified(target, ports)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe(PS)
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
    endVerifiedSync(target, ports)
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
      expect(endVerifiedSync(bad, ports)).toBe(false)
      expect(calls).toHaveLength(0)
    }
  })

  it('the synchronous kill at quit is the same verified script, with its own timeout', () => {
    const { ports, calls } = fakePorts('win32', () => 'ended')
    expect(endVerifiedSync(target, ports)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].sync).toBe(true)
    expect(calls[0].timeoutMs).toBe(OWNER_SYNC_KILL_TIMEOUT_MS)
    expect(scriptOf(calls[0])).toContain(`-eq '${CREATED}'`)
    expect(endVerifiedSync(target, fakePorts('win32', () => 'left').ports)).toBe(false)
    expect(endVerifiedSync(target, fakePorts('win32', () => new Error('timed out')).ports)).toBe(false)
  })
})

describe('ending a verified process on Linux and macOS', () => {
  const LSTART = 'Wed Oct  1 10:00:00 2026'
  const target = facts('chrome', NIX_OK, 4242, LSTART)
  const lstartIs = (v: string | Error) => (file: string, args: string[]) => {
    expect(file).toBe('/bin/ps')
    expect(args).toEqual(['-p', '4242', '-o', 'lstart='])
    return v instanceof Error ? v : `${v}\n`
  }

  it('signals the process group only when the start time still matches', async () => {
    const same = fakePorts('linux', lstartIs(LSTART))
    expect(await endVerified(target, same.ports)).toBe(true)
    expect(same.signals).toEqual([[-4242, 'SIGTERM']])

    const changed = fakePorts('linux', lstartIs('Wed Oct  1 10:00:01 2026'))
    expect(await endVerified(target, changed.ports)).toBe(false)
    expect(changed.signals).toEqual([])

    const gone = fakePorts('linux', lstartIs(new Error('exited with status 1')))
    expect(await endVerified(target, gone.ports)).toBe(false)
    expect(gone.signals).toEqual([])
  })

  it('signals the pid itself when it leads no process group', async () => {
    const f = fakePorts('linux', lstartIs(LSTART), { signal: (pid) => { if (pid < 0) throw new Error('ESRCH') } })
    expect(await endVerified(target, f.ports)).toBe(true)
    expect(f.signals).toEqual([[-4242, 'SIGTERM'], [4242, 'SIGTERM']])
  })

  it('the synchronous kill re-reads the start time too', () => {
    const same = fakePorts('linux', lstartIs(LSTART))
    expect(endVerifiedSync(target, same.ports)).toBe(true)
    expect(same.calls[0].sync).toBe(true)
    expect(same.signals).toEqual([[-4242, 'SIGTERM']])
    const changed = fakePorts('linux', lstartIs('Thu Oct  2 10:00:00 2026'))
    expect(endVerifiedSync(target, changed.ports)).toBe(false)
    expect(changed.signals).toEqual([])
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
