// [host] The real spawnPty with node-pty faked (the mocks are
// pty-codex-color-replies.test.ts's) and the real record of which assistant a
// session's MCP credential was issued to (conductor-mcp-server.ts). An Ask tab
// keeps its session id when it is revived, and the assistant it runs on can
// change (#628 review). The record is released when the session's process is
// torn down, so each launch's own issue stands: a tab revived from Codex onto
// Claude is recorded as Claude's, and the other way round. The issuers are the
// launch writers' stand-ins below (codex/spawn.ts and per-session-settings.ts
// issue the same way); nothing listens on a port.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

interface Spawned { cmd: string; exit: Array<(e: { exitCode: number }) => void> }
const h = vi.hoisted(() => ({
  spawned: [] as Spawned[],
  /** The real issueMcpSessionToken, set once the module is loaded. */
  issue: null as null | ((sessionId: string, provider: 'claude' | 'codex') => string),
}))

vi.mock('node-pty', () => ({
  spawn: (cmd: string) => {
    const { EventEmitter } = require('events') as typeof import('events')
    const out = new EventEmitter()
    out.on('error', () => {})
    const p: Spawned = { cmd, exit: [] }
    h.spawned.push(p)
    return {
      pid: 7300 + h.spawned.length,
      process: cmd,
      onData: () => ({ dispose: () => {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => { p.exit.push(cb); return { dispose: () => {} } },
      write: () => {},
      resize: () => {},
      kill: vi.fn(),
      _agent: { inSocket: new EventEmitter() },
      on: (ev: string, l: (...a: unknown[]) => void) => { out.on(ev, l) },
    }
  },
}))
vi.mock('../../../src/main/bundled-conpty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/bundled-conpty')>()),
  bundledConptyChoice: () => ({ kind: 'not-windows', options: { useConpty: true } }),
}))
const TEST_DATA = await vi.hoisted(async () => (await import('../../helpers/test-data-dir')).useTestDataDirectory())
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => os.tmpdir(), getDataDirectory: () => os.tmpdir(), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: true },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
// The real record; only the port is pinned (no server is started).
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()),
  getConductorMcpPort: () => 0,
}))
vi.mock('../../../src/main/providers', () => ({
  getProvider: () => ({
    resolveBinary: () => ({ cmd: 'claude', source: 'system' }),
    buildSpawnCommand: (opts: Record<string, any>) => {
      if (!opts.realmLaunch) return { cmd: 'pwsh', args: [], env: {} }
      // codex/spawn.ts issues the session's credential to Codex as it builds the launch.
      h.issue!(String(opts.sessionId), 'codex')
      return { cmd: opts.realmLaunch.executable, args: [], env: { ...opts.realmLaunch.env }, hooksInstalled: false }
    },
    ingestSessionTelemetry: () => ({ stop: () => {}, noteExactRollout: () => null, refuteInferredClaim: () => false, recheckShared: () => true }),
    runScreen: { open: () => {}, feed: () => {}, resize: () => {}, close: () => {} },
  }),
  tryGetProvider: () => null,
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
  // per-session-settings.ts issues the session's credential to Claude as it writes the MCP config.
  writeLocalSessionMcpConfig: (sessionId: string) => { h.issue!(sessionId, 'claude'); return '/nonexistent/mcp.json' },
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
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({
  getPtyIntegrityMonitor: () => ({ recordPtyData: () => {}, recordResizeApplied: () => {}, resetSession: () => {}, endSession: () => {} }),
}))
vi.mock('../../../src/main/watchdog/watchdog-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/watchdog/watchdog-manager')>()),
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
const mcp = await import('../../../src/main/conductor-mcp-server')
h.issue = mcp.issueMcpSessionToken
void TEST_DATA

/** A session id of its own for each test, so no test reads another's record. */
const ids: string[] = []
let next = 0
const fresh = (): string => { const id = `ask${String(++next).padStart(21, '0')}`; ids.push(id); return id }
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const launch = () => ({
  lease: { release: vi.fn(), accountId: 'acct-a' },
  executable: '/proven/a/codex',
  env: { PATH: '/usr/bin' },
  sessionsDir: '/res/codex-realms/a/sessions',
}) as never
const asCodex = (id: string) => spawnPty(fakeWin, id, { cwd: os.tmpdir(), provider: 'codex', codexLaunch: launch() } as never)
const asClaude = (id: string) => spawnPty(fakeWin, id, { cwd: os.tmpdir() } as never)
/** The session's process exits on its own (the Ask tab's assistant ended). */
const exitLast = () => { const p = h.spawned[h.spawned.length - 1]; for (const cb of [...p.exit]) cb({ exitCode: 0 }) }

beforeEach(() => {
  for (const id of ids) { try { killPty(id) } catch { /* none */ } }
  h.spawned = []
})

describe('the MCP record follows each launch of a session id', () => {
  it('a session launched on Codex and revived on Claude (the same id) is recorded as Claude\'s', () => {
    const ASK = fresh()
    asCodex(ASK)
    expect(mcp.mcpSessionProvider(ASK)).toBe('codex')
    asClaude(ASK)
    expect(mcp.mcpSessionProvider(ASK)).toBe('claude')
  })

  it('...after its Codex process has exited on its own, too', () => {
    const ASK = fresh()
    asCodex(ASK)
    exitLast()
    expect(mcp.mcpSessionProvider(ASK)).toBeNull()
    asClaude(ASK)
    expect(mcp.mcpSessionProvider(ASK)).toBe('claude')
  })

  it('a session launched on Claude and revived on Codex is recorded as Codex\'s', () => {
    const ASK = fresh()
    asClaude(ASK)
    expect(mcp.mcpSessionProvider(ASK)).toBe('claude')
    asCodex(ASK)
    expect(mcp.mcpSessionProvider(ASK)).toBe('codex')
  })

  it('a relaunch on the same assistant keeps its record', () => {
    const ASK = fresh()
    asCodex(ASK)
    asCodex(ASK)
    expect(mcp.mcpSessionProvider(ASK)).toBe('codex')
  })

  it('another session\'s record is untouched by this one\'s teardown and relaunch', () => {
    const ASK = fresh()
    const OTHER = fresh()
    asCodex(OTHER)
    asCodex(ASK)
    asClaude(ASK)
    killPty(ASK)
    expect(mcp.mcpSessionProvider(OTHER)).toBe('codex')
    expect(mcp.mcpSessionProvider(ASK)).toBeNull()
  })

  // The replaced process's exit arrives after the next launch issued its own record: only the
  // session's current process ends the session (the exit handler's weAreCurrent guard), so the
  // late exit leaves the new launch's record alone.
  it('Codex, then Claude: the replaced Codex process exits late, and the Claude record stands', () => {
    const ASK = fresh()
    asCodex(ASK)
    const replaced = h.spawned[h.spawned.length - 1]
    asClaude(ASK)
    expect(mcp.mcpSessionProvider(ASK)).toBe('claude')
    for (const cb of [...replaced.exit]) cb({ exitCode: 0 })
    expect(mcp.mcpSessionProvider(ASK)).toBe('claude')
  })

  it('Claude, then Codex: the replaced Claude process exits late, and the Codex record stands', () => {
    const ASK = fresh()
    asClaude(ASK)
    const replaced = h.spawned[h.spawned.length - 1]
    asCodex(ASK)
    expect(mcp.mcpSessionProvider(ASK)).toBe('codex')
    for (const cb of [...replaced.exit]) cb({ exitCode: 0 })
    expect(mcp.mcpSessionProvider(ASK)).toBe('codex')
  })
})
