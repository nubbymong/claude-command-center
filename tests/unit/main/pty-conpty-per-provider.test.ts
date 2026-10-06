// P3.15 (row 71): a local Codex session on Windows runs under node-pty's
// bundled ConPTY (its conpty.dll and OpenConsole.exe, the console host Windows
// Terminal ships), because the ConPTY built into Windows repaints Codex's
// screen in place and leaves the terminal no scrollback (the P3.15 VM run:
// 38 lines kept, the wheel inert; 122 kept and the wheel scrolling under the
// bundled one). Nothing else changes: a Claude session, a plain terminal (of
// either provider) and an SSH session keep the system ConPTY with exactly the
// options they had. When the bundled files are missing, the Codex session
// falls back to the system ConPTY, and its launch line says which it got.
// Round 1: the real choice and its memo (only counted here); a bundled ConPTY
// that fails as the session starts falls back to the system one (F1); the same
// launch under both differs in that one option only (F5); the launch line names
// the bundled folder (F6).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

interface Spawned { cmd: string; args: unknown; opts: Record<string, unknown>; exit: Array<(e: { exitCode: number }) => void>; emitData: (d: string) => void; inSocket: import('events').EventEmitter; outSocket: import('events').EventEmitter; kill: ReturnType<typeof vi.fn> }
interface Attempt { cmd: string; args: unknown; opts: Record<string, unknown> }
const h = vi.hoisted(() => ({
  spawned: [] as Spawned[],
  attempts: [] as Attempt[],
  infos: [] as string[],
  warns: [] as string[],
  choiceCalls: 0,
  failures: [] as string[],
  /** node-pty failing to start the bundled ConPTY (round 1, F1). */
  failDll: false,
  /** node-pty failing whatever the ConPTY (the executable missing). */
  failAll: false,
  /** Round 5 (R1): node-pty's PTY as unixTerminal.js builds it (macOS, Linux). */
  unixHandler: false,
}))

vi.mock('node-pty', () => ({
  spawn: (cmd: string, args: unknown, opts: Record<string, unknown>) => {
    // Round 2 (J3): every attempt, with its command, arguments and options.
    h.attempts.push({ cmd, args, opts })
    // What node-pty's startProcess throws when conpty.dll cannot be loaded or
    // OpenConsole.exe cannot start, and when the executable is missing.
    if (h.failAll) throw new Error(`File not found: ${cmd} (attempt ${h.attempts.length})`)
    if (h.failDll && opts.useConptyDll) throw new Error('Cannot launch conpty')
    const dataCbs: Array<(d: string) => void> = []
    // Round 3 (K1): node-pty's Windows PTY writes its input to a socket on its agent.
    const { EventEmitter } = require('events') as typeof import('events')
    const p: Spawned = { cmd, args, opts, exit: [], emitData: (d) => { for (const cb of dataCbs) cb(d) }, inSocket: new EventEmitter(), outSocket: new EventEmitter(), kill: vi.fn() }
    // Round 4 (P4): node-pty's own handler on the output socket (windowsTerminal.js):
    // EIO is ignored; any other error is thrown unless something else listens.
    // Round 5 (R1): unixTerminal.js returns on an EAGAIN first, ignoring it.
    const unix = h.unixHandler
    p.outSocket.on('error', (err: NodeJS.ErrnoException) => {
      if (unix && err.code && err.code.includes('EAGAIN')) return
      if (err.code && (err.code.includes('errno 5') || err.code.includes('EIO'))) return
      if (p.outSocket.listeners('error').length < 2) throw err
    })
    h.spawned.push(p)
    return {
      pid: 7000 + h.spawned.length,
      process: cmd,
      onData: (cb: (d: string) => void) => { dataCbs.push(cb); return { dispose: () => {} } },
      onExit: (cb: (e: { exitCode: number }) => void) => { p.exit.push(cb); return { dispose: () => {} } },
      write: () => {},
      resize: () => {},
      kill: p.kill,
      // A unix PTY has no input socket (node-pty writes its input itself).
      ...(unix ? {} : { _agent: { inSocket: p.inSocket } }),
      // Terminal.prototype.on: every event but 'close' goes to the output socket.
      on: (ev: string, l: (...a: unknown[]) => void) => { p.outSocket.on(ev, l) },
    }
  },
}))
// The real choice and its memo; only counted.
vi.mock('../../../src/main/bundled-conpty', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/bundled-conpty')>()
  return {
    ...real,
    bundledConptyChoice: () => { h.choiceCalls++; return real.bundledConptyChoice() },
    bundledConptyFailed: (reason: string) => { h.failures.push(reason); return real.bundledConptyFailed(reason) },
  }
})
vi.mock('../../../src/main/debug-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/debug-logger')>()),
  logInfo: (...a: unknown[]) => { h.infos.push(a.map(String).join(' ')) },
  logWarn: (...a: unknown[]) => { h.warns.push(a.map(String).join(' ')) },
}))
// [host] The real logger kept above keeps its log inside the test's own folder, never
// the installed app's (tests/helpers/test-data-dir.ts).
const TEST_DATA = await vi.hoisted(async () => (await import('../../helpers/test-data-dir')).useTestDataDirectory())
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => os.tmpdir(), getDataDirectory: () => os.tmpdir(), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: () => 'tok',
  registerCodexReviewSession: () => {},
  registerClaudeReviewSession: () => {},
  unregisterCodexReviewSession: () => {},
  releaseMcpSessionProvider: () => {},
  disposeCodexReviewUsage: () => {},
}))
vi.mock('../../../src/main/providers', () => ({
  getProvider: () => ({
    resolveBinary: () => ({ cmd: 'claude', source: 'system' }), // WP2 PR 4: the local launch resolves Claude through the provider
    buildSpawnCommand: (opts: Record<string, any>) => {
      // Only a Codex launch carries its realm (the Claude branch asks for its shell).
      if (!opts.realmLaunch) return { cmd: 'pwsh', args: [], env: {} }
      return { cmd: opts.realmLaunch.executable, args: [], env: { ...opts.realmLaunch.env }, hooksInstalled: false }
    },
    ingestSessionTelemetry: () => ({ stop: () => {}, noteExactRollout: () => null, refuteInferredClaim: () => false, recheckShared: () => true }),
  }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({
  getGateway: () => ({ status: () => ({ enabled: false, listening: false, port: null }), registerSession: () => 'x', unregisterSession: () => {} }),
  isExactBindSourceActive: () => true,
}))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => '/nonexistent/settings.json',
  removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => '/nonexistent/mcp.json',
  removeLocalSessionMcpConfig: () => {},
  removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {},
  clearClaudeAccount: () => {},
  getAccountIdentity: () => null,
  pushAccountIdentity: () => {},
  startWatchingAccountIdentity: () => {},
  stopWatchingAccountIdentity: () => {},
  getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {} }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({
  getWatchdogManager: () => ({ startWatchdog: () => {}, stopWatchdog: () => {}, feedData: () => {}, noteRedrawTrigger: () => {}, noteResize: () => {} }),
}))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  getConfigDir: () => os.tmpdir(),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  isValidProfileId: () => false,
  getPrimaryProfileId: () => null,
  getProfileConfigDir: () => path.join(os.tmpdir(), 'ccc-no-such-profile'),
  setupProfileLinks: () => {},
  syncPrimaryCredentialsWithGlobal: () => {},
  backupProfileHomeToCanonical: () => {},
}))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: async () => ({ ok: true }) }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => null }))

const { spawnPty, killPty } = await import('../../../src/main/pty-manager')
const { _resetBundledConptyForTest } = await import('../../../src/main/bundled-conpty')

const CX = 'cx0000000000000000000315'
const CL = 'cl0000000000000000000315'
const SH = 'sh0000000000000000000315'
const sent: Array<[string, unknown]> = []
const fakeWin = { isDestroyed: () => false, webContents: { send: (ch: string, d: unknown) => { sent.push([ch, d]) } } } as unknown as Parameters<typeof spawnPty>[0]
let lastLaunch: { lease: { release: ReturnType<typeof vi.fn> } } | null = null
const launch = () => {
  const l = {
    lease: { release: vi.fn(), accountId: 'acct-a' },
    executable: '/proven/a/codex',
    env: { PATH: '/usr/bin' },
    sessionsDir: '/res/codex-realms/a/sessions',
  }
  lastLaunch = l
  return l as never
}
const startCodex = () => spawnPty(fakeWin, CX, { cwd: os.tmpdir(), provider: 'codex', codexLaunch: launch() } as never)
const last = (): Spawned => h.spawned[h.spawned.length - 1]
const launchLine = (): string | undefined => [...h.infos].reverse().find((l) => l.includes('Launching Codex PTY'))
/** What every PTY but a local Codex session's has always been given. */
const SYSTEM_OPTION_KEYS = ['cols', 'cwd', 'env', 'name', 'rows', 'useConpty']

// node-pty as the app finds it, on Windows: the bundled files there or not.
const LIB = path.join(path.sep, 'np', 'node_modules', 'node-pty', 'lib')
const PREBUILD = path.join(path.sep, 'np', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64')
const BUNDLED_FILES = ['conpty.node', path.join('conpty', 'conpty.dll'), path.join('conpty', 'OpenConsole.exe')].map((f) => path.join(PREBUILD, f))
const bundledThere = () => _resetBundledConptyForTest({ platform: 'win32', arch: 'x64', nodePtyLibDir: LIB, exists: (p) => BUNDLED_FILES.includes(p) })
const dllMissing = () => _resetBundledConptyForTest({ platform: 'win32', arch: 'x64', nodePtyLibDir: LIB, exists: (p) => p === BUNDLED_FILES[0] })
const notWindows = () => _resetBundledConptyForTest({ platform: 'linux', arch: 'x64', nodePtyLibDir: LIB, exists: () => true })

beforeEach(() => {
  for (const sid of [CX, CL, SH]) { try { killPty(sid) } catch { /* none */ } }
  for (const p of h.spawned) for (const cb of [...p.exit]) cb({ exitCode: 0 })
  h.spawned = []
  h.attempts = []
  h.infos = []
  h.warns = []
  h.choiceCalls = 0
  h.failures = []
  h.failDll = false
  h.failAll = false
  h.unixHandler = false
  lastLaunch = null
  bundledThere()
})

describe('the ConPTY each kind of session runs under (P3.15, row 71)', () => {
  it('a local Codex session asks node-pty for its bundled ConPTY when it is there, and its launch line says so, with the folder (round 1, F6)', () => {
    startCodex()
    expect(last().cmd).toBe('/proven/a/codex')
    expect(last().opts.useConpty).toBe(true)
    expect(last().opts.useConptyDll).toBe(true)
    expect(Object.keys(last().opts).sort()).toEqual([...SYSTEM_OPTION_KEYS, 'useConptyDll'].sort())
    expect(launchLine()).toContain(` conpty=bundled (${PREBUILD})`)
  })

  it('falls back to the system ConPTY (no useConptyDll at all) when the bundled files are missing, and the launch line gives the reason', () => {
    dllMissing()
    startCodex()
    expect(last().opts.useConpty).toBe(true)
    expect('useConptyDll' in last().opts).toBe(false)
    expect(Object.keys(last().opts).sort()).toEqual(SYSTEM_OPTION_KEYS)
    expect(launchLine()).toContain(`conpty=system (${path.join(PREBUILD, 'conpty', 'conpty.dll')} is missing)`)
  })

  it('off Windows the Codex options are what they always were, and the launch line names no ConPTY', () => {
    notWindows()
    startCodex()
    expect(Object.keys(last().opts).sort()).toEqual(SYSTEM_OPTION_KEYS)
    expect(launchLine()).not.toMatch(/conpty=/)
  })

  it('round 1 (F5): the same launch under the bundled and the system ConPTY differs in that one option only (command, arguments, environment, folder, size)', () => {
    startCodex()
    const bundled = last()
    killPty(CX)
    dllMissing()
    startCodex()
    const system = last()
    expect(bundled.opts.useConptyDll).toBe(true)
    expect('useConptyDll' in system.opts).toBe(false)
    expect(system.cmd).toBe(bundled.cmd)
    expect(system.args).toEqual(bundled.args)
    const { useConptyDll: _dll, ...bundledRest } = bundled.opts
    expect(system.opts).toEqual(bundledRest)
  })

  it('a local Claude session keeps the system ConPTY, with exactly the options it had, whatever the bundled choice', () => {
    spawnPty(fakeWin, CL, { cwd: os.tmpdir() } as never)
    expect(h.spawned.length).toBe(1)
    expect(last().opts.useConpty).toBe(true)
    expect(Object.keys(last().opts).sort()).toEqual(SYSTEM_OPTION_KEYS)
    expect(h.choiceCalls).toBe(0)
  })

  it('a plain terminal keeps the system ConPTY, whichever provider its config names', () => {
    for (const provider of ['claude', 'codex'] as const) {
      h.spawned = []
      spawnPty(fakeWin, SH, { cwd: os.tmpdir(), shellOnly: true, provider } as never)
      expect(last().opts.useConpty, provider).toBe(true)
      expect(Object.keys(last().opts).sort(), provider).toEqual(SYSTEM_OPTION_KEYS)
      killPty(SH)
    }
    expect(h.choiceCalls).toBe(0)
  })
})

// Round 1 (F1): the bundled files can be there and still fail when a session
// starts (blocked or damaged, OpenConsole.exe unable to start): node-pty then
// throws before any process starts. The session starts on the system ConPTY
// instead, and the rest of the run does not ask for the bundled one again.
describe('the bundled ConPTY failing at a session\'s start (round 1, F1)', () => {
  it('the session starts on the system ConPTY, said in the log, and later sessions go straight to it', () => {
    h.failDll = true
    startCodex()
    expect(h.attempts.map((a) => a.opts.useConptyDll === true)).toEqual([true, false])
    // Round 2 (J3): the retry is the same launch: command, arguments, and every
    // option but useConptyDll (environment, folder, size, name).
    const [first, retry] = h.attempts
    expect(retry.cmd).toBe(first.cmd)
    expect(retry.args).toEqual(first.args)
    const { useConptyDll: _dll, ...firstRest } = first.opts
    expect(retry.opts).toEqual(firstRest)
    expect(h.spawned.length).toBe(1)
    expect(Object.keys(last().opts).sort()).toEqual(SYSTEM_OPTION_KEYS)
    expect(h.failures).toEqual(['Cannot launch conpty'])
    expect(h.infos.some((l) => l.includes(`Codex PTY for ${CX}: the bundled ConPTY failed to start; started on the system ConPTY`))).toBe(true)
    expect(h.warns.filter((w) => w.includes('[conpty]'))).toHaveLength(1)
    killPty(CX)
    h.attempts = []
    startCodex()
    expect(h.attempts.map((a) => a.opts.useConptyDll === true)).toEqual([false])
    expect(launchLine()).toContain('conpty=system (node-pty\'s bundled ConPTY failed to start: Cannot launch conpty)')
  })

  it('a start that fails on the system ConPTY too is not the bundled ConPTY\'s fault: the first error goes on, the choice stays, the lease is let go', () => {
    h.failAll = true
    // The first attempt's error (under the bundled ConPTY), not the retry's.
    expect(() => startCodex()).toThrow('File not found: /proven/a/codex (attempt 1)')
    expect(h.attempts.map((a) => a.opts.useConptyDll === true)).toEqual([true, false])
    expect(h.failures).toEqual([])
    expect(h.warns.filter((w) => w.includes('[conpty]'))).toEqual([])
    expect(lastLaunch!.lease.release).toHaveBeenCalled()
    h.failAll = false
    h.attempts = []
    startCodex()
    expect(h.attempts.map((a) => a.opts.useConptyDll === true)).toEqual([true])
  })

  it('the system choice is never retried: one attempt, its error goes on', () => {
    dllMissing()
    h.failAll = true
    expect(() => startCodex()).toThrow('File not found')
    expect(h.attempts).toHaveLength(1)
    expect(h.failures).toEqual([])
  })
})

// Round 2 (J5): a bundled ConPTY can also fail after node-pty has started it
// (OpenConsole.exe ended at once, or unable to create Codex inside it): the
// session then ends within moments with nothing on screen but the console
// host's own setup. That is told apart from a real quick exit, which always
// draws something, and from the app ending the session itself; the next launch
// then uses the system ConPTY (said once). The session is not relaunched.
describe('a bundled Codex session that ends at once with nothing on screen (round 2, J5)', () => {
  const T0 = 1_800_000_000_000
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0) })
  afterEach(() => { vi.useRealTimers() })
  const exitIt = (code: number | undefined = undefined) => { for (const cb of [...last().exit]) cb({ exitCode: code as number }) }
  const nextIsSystem = () => {
    h.attempts = []
    startCodex()
    return h.attempts.map((a) => a.opts.useConptyDll === true)
  }

  it('no output at all, or only the console host\'s setup sequences: the next launch uses the system ConPTY, said once', () => {
    for (const out of ['', '\x1b[?9001h\x1b[?1004h\x1b[?25l\r\n']) {
      bundledThere()
      h.warns = []
      startCodex()
      if (out) last().emitData(out)
      vi.setSystemTime(T0 + 1500)
      exitIt()
      expect(nextIsSystem(), JSON.stringify(out)).toEqual([false])
      expect(h.warns.filter((w) => w.includes('[conpty]')), JSON.stringify(out)).toHaveLength(1)
      expect(h.warns.find((w) => w.includes('[conpty]')), JSON.stringify(out)).toMatch(/ended within 5 s with nothing on screen/)
      killPty(CX)
      vi.setSystemTime(T0)
    }
  })

  it('a session that drew something, or ran longer than that, or that the app ended, keeps the bundled ConPTY', () => {
    startCodex()
    last().emitData('\x1b[1mError:\x1b[0m config.toml is invalid\r\n')
    exitIt(1)
    expect(nextIsSystem()).toEqual([true])
    vi.setSystemTime(T0 + 6000)
    exitIt()
    expect(nextIsSystem()).toEqual([true])
    killPty(CX)
    exitIt()
    expect(nextIsSystem()).toEqual([true])
    expect(h.warns.filter((w) => w.includes('[conpty]'))).toEqual([])
  })

  it('a session already on the system ConPTY changes nothing', () => {
    dllMissing()
    startCodex()
    h.warns = []
    exitIt()
    expect(nextIsSystem()).toEqual([false])
    expect(h.warns.filter((w) => w.includes('[conpty]'))).toEqual([])
  })
})

// Round 2 (J1): under the bundled ConPTY a Codex that quits by itself can end
// before its exit code is known: the log says the code is unknown.
describe('an exit with no known code (round 2, J1)', () => {
  it('the log line says the code is unknown, never "undefined"', () => {
    startCodex()
    for (const cb of [...last().exit]) cb({ exitCode: undefined as unknown as number })
    const line = h.infos.find((l) => l.includes(`PTY exited for session ${CX}`))
    expect(line).toContain('with code unknown')
    expect(line).not.toContain('undefined')
  })
})

// Round 3 (K1, K2): a failed write to a PTY's input never quits the app, for
// any kind of session. The VM at 98455d52: a key typed just after Codex ended
// (under the bundled ConPTY) failed with "write EAGAIN" on node-pty's input
// socket, which had no listener, and the app quit. Now the error is caught and
// logged once; a session that then ends by itself is left to end; one that has
// not ended within the grace is ended, with a line in its terminal saying why.
describe('a failed write to a PTY\'s input (round 3, K1, K2)', () => {
  beforeEach(() => { vi.useFakeTimers(); sent.length = 0 })
  afterEach(() => { vi.useRealTimers() })
  const failure = (code: string) => Object.assign(new Error(`write ${code}`), { code, syscall: 'write' })
  const kinds: Array<[string, () => void]> = [
    ['Codex, bundled ConPTY', () => startCodex()],
    ['Codex, system ConPTY', () => { dllMissing(); startCodex() }],
    ['Claude', () => spawnPty(fakeWin, CL, { cwd: os.tmpdir() } as never)],
    ['plain terminal', () => spawnPty(fakeWin, SH, { cwd: os.tmpdir(), shellOnly: true } as never)],
  ]
  const idOf = (name: string) => (name.startsWith('Codex') ? CX : name === 'Claude' ? CL : SH)

  it('every kind of session: EAGAIN, EPIPE or any other input error is caught, logged once, never thrown', () => {
    for (const [name, start] of kinds) {
      for (const code of ['EAGAIN', 'EPIPE', 'EINVAL']) {
        h.warns = []
        start()
        const p = last()
        expect(() => p.inSocket.emit('error', failure(code)), `${name} ${code}`).not.toThrow()
        expect(() => p.inSocket.emit('error', failure('ERR_STREAM_DESTROYED')), `${name} ${code}`).not.toThrow()
        const lines = h.warns.filter((w) => w.includes(`input to session ${idOf(name)} failed`))
        expect(lines, `${name} ${code}`).toHaveLength(1)
        expect(lines[0], `${name} ${code}`).toContain(code)
        for (const cb of [...p.exit]) cb({ exitCode: 0 })
        bundledThere()
      }
    }
  })

  it('a session that ends by itself after its input failed (the program had quit) is left to end: no kill, no line', () => {
    startCodex()
    const p = last()
    p.inSocket.emit('error', failure('EAGAIN'))
    for (const cb of [...p.exit]) cb({ exitCode: undefined as unknown as number })
    vi.advanceTimersByTime(10_000)
    expect(p.kill).not.toHaveBeenCalled()
    expect(sent.filter(([ch, d]) => ch === `pty:data:${CX}` && String(d).includes('stopped taking input'))).toEqual([])
  })

  it('a session that has not ended within the grace is ended, with a line in its terminal saying why; the app stays up', () => {
    for (const [name, start] of kinds) {
      sent.length = 0
      start()
      const p = last()
      p.inSocket.emit('error', failure('EAGAIN'))
      vi.advanceTimersByTime(2_999)
      expect(p.kill, name).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(p.kill, name).toHaveBeenCalledTimes(1)
      expect(sent.some(([ch, d]) => ch === `pty:data:${idOf(name)}` && String(d).includes('[This session stopped taking input, so it was ended.]')), name).toBe(true)
      for (const cb of [...p.exit]) cb({ exitCode: 1 })
      bundledThere()
    }
  })

  it('a session replaced in the meantime (a Restart) is not ended by its old PTY\'s input error', () => {
    startCodex()
    const old = last()
    old.inSocket.emit('error', failure('EAGAIN'))
    killPty(CX)
    startCodex()
    const next = last()
    vi.advanceTimersByTime(5_000)
    expect(old.kill).toHaveBeenCalledTimes(1) // by killPty only
    expect(next.kill).not.toHaveBeenCalled()
  })
})

// Round 4 (P4): node-pty's handler on a PTY's output socket throws any error
// but EIO unless the PTY has a listener of its own, which the app had not given
// it: the same app-quit class as the input side. Now every session's PTY gets
// one: the error is logged once, and a session that has not ended within the
// grace is ended, as for an input error.
describe('an error on a PTY\'s output (round 4, P4)', () => {
  beforeEach(() => { vi.useFakeTimers(); sent.length = 0 })
  afterEach(() => { vi.useRealTimers() })
  const failure = (code: string) => Object.assign(new Error(`read ${code}`), { code, syscall: 'read' })
  const kinds: Array<[string, string, () => void]> = [
    ['Codex, bundled ConPTY', CX, () => startCodex()],
    ['Codex, system ConPTY', CX, () => { dllMissing(); startCodex() }],
    ['Claude', CL, () => spawnPty(fakeWin, CL, { cwd: os.tmpdir() } as never)],
    ['plain terminal', SH, () => spawnPty(fakeWin, SH, { cwd: os.tmpdir(), shellOnly: true } as never)],
  ]

  it('every kind of session: an output error is caught (never thrown), logged once; EIO is node-pty\'s own and stays silent', () => {
    for (const [name, id, start] of kinds) {
      for (const code of ['ECONNRESET', 'EINVAL']) {
        h.warns = []
        start()
        const p = last()
        expect(() => p.outSocket.emit('error', failure(code)), `${name} ${code}`).not.toThrow()
        expect(() => p.outSocket.emit('error', failure(code)), `${name} ${code}`).not.toThrow()
        const lines = h.warns.filter((w) => w.includes(`output of session ${id} failed`))
        expect(lines, `${name} ${code}`).toHaveLength(1)
        expect(lines[0], `${name} ${code}`).toContain(code)
        for (const cb of [...p.exit]) cb({ exitCode: 0 })
        bundledThere()
      }
      // EIO: the program's end as node-pty reads it; not a failure, nothing logged.
      h.warns = []
      start()
      const q = last()
      expect(() => q.outSocket.emit('error', failure('EIO')), `${name} EIO`).not.toThrow()
      expect(h.warns.filter((w) => w.includes('output of session')), `${name} EIO`).toEqual([])
      vi.advanceTimersByTime(5_000)
      expect(q.kill, `${name} EIO`).not.toHaveBeenCalled()
      for (const cb of [...q.exit]) cb({ exitCode: 0 })
      bundledThere()
    }
  })

  it('a session that has not ended within the grace after an output error is ended, with the line in its terminal', () => {
    for (const [name, id, start] of kinds) {
      sent.length = 0
      start()
      const p = last()
      p.outSocket.emit('error', failure('ECONNRESET'))
      vi.advanceTimersByTime(2_999)
      expect(p.kill, name).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(p.kill, name).toHaveBeenCalledTimes(1)
      expect(sent.some(([ch, d]) => ch === `pty:data:${id}` && String(d).includes('stopped taking input')), name).toBe(true)
      for (const cb of [...p.exit]) cb({ exitCode: 1 })
      bundledThere()
    }
  })

  it('an input error and an output error on the same PTY end it once', () => {
    startCodex()
    const p = last()
    p.inSocket.emit('error', Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN' }))
    p.outSocket.emit('error', failure('ECONNRESET'))
    vi.advanceTimersByTime(5_000)
    expect(p.kill).toHaveBeenCalledTimes(1)
  })
})

// Round 5 (R1): node-pty's unix handler (unixTerminal.js, macOS and Linux)
// returns on an EAGAIN on the output socket, ignoring it; the round 4 guard
// logged it as a failure and ended the session after the grace. Off Windows an
// output EAGAIN is now ignored, as node-pty's unix handler ignores it. On
// Windows node-pty closes the PTY on one, so there it stays a failure (logged,
// the grace end).
describe('an EAGAIN on a PTY\'s output (round 5, R1)', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const onPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p, configurable: true })
  beforeEach(() => { vi.useFakeTimers(); sent.length = 0 })
  afterEach(() => { vi.useRealTimers(); Object.defineProperty(process, 'platform', realPlatform) })
  const failure = (code: string) => Object.assign(new Error(`read ${code}`), { code, syscall: 'read' })
  const kinds: Array<[string, string, () => void]> = [
    ['Codex', CX, () => startCodex()],
    ['Claude', CL, () => spawnPty(fakeWin, CL, { cwd: os.tmpdir() } as never)],
    ['plain terminal', SH, () => spawnPty(fakeWin, SH, { cwd: os.tmpdir(), shellOnly: true } as never)],
  ]

  it('off Windows (node-pty\'s unix handler) every kind of session ignores an output EAGAIN: nothing logged, nothing thrown, never ended', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      for (const [name, id, start] of kinds) {
        onPlatform(platform)
        notWindows()
        h.unixHandler = true
        h.warns = []
        sent.length = 0
        start()
        const p = last()
        expect(() => p.outSocket.emit('error', failure('EAGAIN')), `${platform} ${name}`).not.toThrow()
        expect(() => p.outSocket.emit('error', failure('EAGAIN')), `${platform} ${name}`).not.toThrow()
        vi.advanceTimersByTime(10_000)
        expect(p.kill, `${platform} ${name}`).not.toHaveBeenCalled()
        expect(h.warns.filter((w) => w.includes('output of session') || w.includes(`session ${id} did not end`)), `${platform} ${name}`).toEqual([])
        expect(sent.filter(([, d]) => String(d).includes('stopped taking input')), `${platform} ${name}`).toEqual([])
        for (const cb of [...p.exit]) cb({ exitCode: 0 })
      }
    }
  })

  it('off Windows any other output error is still a failure: logged once, and a session that does not end is ended', () => {
    onPlatform('linux')
    notWindows()
    h.unixHandler = true
    for (const [name, id, start] of kinds) {
      h.warns = []
      start()
      const p = last()
      p.outSocket.emit('error', failure('EAGAIN'))
      p.outSocket.emit('error', failure('ECONNRESET'))
      const lines = h.warns.filter((w) => w.includes(`output of session ${id} failed`))
      expect(lines, name).toHaveLength(1)
      expect(lines[0], name).toContain('ECONNRESET')
      vi.advanceTimersByTime(3_000)
      expect(p.kill, name).toHaveBeenCalledTimes(1)
      for (const cb of [...p.exit]) cb({ exitCode: 1 })
    }
  })

  it('on Windows (node-pty closes the PTY on an EAGAIN) it is still a failure: logged once, and a session that does not end is ended', () => {
    onPlatform('win32')
    for (const [name, id, start] of kinds) {
      h.warns = []
      sent.length = 0
      start()
      const p = last()
      expect(() => p.outSocket.emit('error', failure('EAGAIN')), name).not.toThrow()
      const lines = h.warns.filter((w) => w.includes(`output of session ${id} failed`))
      expect(lines, name).toHaveLength(1)
      expect(lines[0], name).toContain('EAGAIN')
      vi.advanceTimersByTime(3_000)
      expect(p.kill, name).toHaveBeenCalledTimes(1)
      expect(sent.some(([ch, d]) => ch === `pty:data:${id}` && String(d).includes('stopped taking input')), name).toBe(true)
      for (const cb of [...p.exit]) cb({ exitCode: 1 })
      bundledThere()
    }
  })
})

describe("the test's own log folder", () => {
  it("[host] the real logger keeps its log inside the test's own folder", async () => {
    const { getLogDir } = await import('../../../src/main/debug-logger')
    expect(getLogDir()).toBe(path.join(TEST_DATA, 'debug'))
  })
})
