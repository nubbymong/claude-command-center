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
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

interface Spawned { cmd: string; args: unknown; opts: Record<string, unknown>; exit: Array<(e: { exitCode: number }) => void> }
const h = vi.hoisted(() => ({
  spawned: [] as Spawned[],
  attempts: [] as Array<Record<string, unknown>>,
  infos: [] as string[],
  warns: [] as string[],
  choiceCalls: 0,
  failures: [] as string[],
  /** node-pty failing to start the bundled ConPTY (round 1, F1). */
  failDll: false,
  /** node-pty failing whatever the ConPTY (the executable missing). */
  failAll: false,
}))

vi.mock('node-pty', () => ({
  spawn: (cmd: string, args: unknown, opts: Record<string, unknown>) => {
    h.attempts.push(opts)
    // What node-pty's startProcess throws when conpty.dll cannot be loaded or
    // OpenConsole.exe cannot start, and when the executable is missing.
    if (h.failAll) throw new Error(`File not found: ${cmd} (attempt ${h.attempts.length})`)
    if (h.failDll && opts.useConptyDll) throw new Error('Cannot launch conpty')
    const p: Spawned = { cmd, args, opts, exit: [] }
    h.spawned.push(p)
    return {
      pid: 7000 + h.spawned.length,
      process: cmd,
      onData: () => ({ dispose: () => {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => { p.exit.push(cb); return { dispose: () => {} } },
      write: () => {},
      resize: () => {},
      kill: () => {},
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
  disposeCodexReviewUsage: () => {},
}))
vi.mock('../../../src/main/providers', () => ({
  getProvider: () => ({
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
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
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
    expect(h.attempts.map((o) => o.useConptyDll === true)).toEqual([true, false])
    expect(h.spawned.length).toBe(1)
    expect(Object.keys(last().opts).sort()).toEqual(SYSTEM_OPTION_KEYS)
    expect(h.failures).toEqual(['Cannot launch conpty'])
    expect(h.infos.some((l) => l.includes(`Codex PTY for ${CX}: the bundled ConPTY failed to start; started on the system ConPTY`))).toBe(true)
    expect(h.warns.filter((w) => w.includes('[conpty]'))).toHaveLength(1)
    killPty(CX)
    h.attempts = []
    startCodex()
    expect(h.attempts.map((o) => o.useConptyDll === true)).toEqual([false])
    expect(launchLine()).toContain('conpty=system (node-pty\'s bundled ConPTY failed to start: Cannot launch conpty)')
  })

  it('a start that fails on the system ConPTY too is not the bundled ConPTY\'s fault: the first error goes on, the choice stays, the lease is let go', () => {
    h.failAll = true
    // The first attempt's error (under the bundled ConPTY), not the retry's.
    expect(() => startCodex()).toThrow('File not found: /proven/a/codex (attempt 1)')
    expect(h.attempts.map((o) => o.useConptyDll === true)).toEqual([true, false])
    expect(h.failures).toEqual([])
    expect(h.warns.filter((w) => w.includes('[conpty]'))).toEqual([])
    expect(lastLaunch!.lease.release).toHaveBeenCalled()
    h.failAll = false
    h.attempts = []
    startCodex()
    expect(h.attempts.map((o) => o.useConptyDll === true)).toEqual([true])
  })

  it('the system choice is never retried: one attempt, its error goes on', () => {
    dllMissing()
    h.failAll = true
    expect(() => startCodex()).toThrow('File not found')
    expect(h.attempts).toHaveLength(1)
    expect(h.failures).toEqual([])
  })
})
