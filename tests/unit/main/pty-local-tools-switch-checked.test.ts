// A local launch reads the built-in tools switch through the checked read.
//
// A local Claude Code session's MCP config (the built-in tools entry), its
// pre-allowed canvas tools and the canvas workflow plugin, and a Codex
// session's canvas launch, are all decided by ONE checked read of the saved
// settings (conductor-tools-switch.ts): settings that are there but cannot be
// read leave the built-in tools off until they can be, whatever an unchecked
// read says; settings read and on give them, as before. The real spawnPty;
// node-pty records; the per-session writers and the canvas launch are
// recorders.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  outcome: 'ok' as 'ok' | 'absent' | 'failed' | 'unparseable',
  mcpConductor: [] as boolean[],
  allowCanvasTools: [] as unknown[],
  pluginAsked: 0,
  codexToolsOn: [] as boolean[],
}))

vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 7500, process: 'x',
    onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }),
    write: () => {}, resize: () => {}, kill: () => {},
  }),
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => os.tmpdir(), getDataDirectory: () => os.tmpdir(), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 4100, issueMcpSessionToken: () => 'tok', registerCodexReviewSession: () => {}, registerClaudeReviewSession: () => {}, unregisterCodexReviewSession: () => {}, releaseMcpSessionProvider: () => {} }))
vi.mock('../../../src/main/providers', () => ({
  getProvider: (id: string) => (id === 'codex'
    ? { buildSpawnCommand: () => ({ cmd: '/proven/codex', args: [], env: {}, logLine: '' }), ingestSessionTelemetry: () => ({ stop: () => {} }) }
    : { resolveBinary: () => ({ cmd: 'claude', source: 'system' }), buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }), ingestSessionTelemetry: () => ({ stop: () => {} }) }),
}))
vi.mock('../../../src/main/canvas/codex-canvas-launch', () => ({
  prepareCodexCanvasLaunch: (o: { toolsOn: boolean }) => { h.codexToolsOn.push(o.toolsOn); return { designatedWorktree: null, guidance: null } },
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => { h.pluginAsked++; return null } }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: (_sid: string, o: { allowCanvasTools?: boolean }) => { h.allowCanvasTools.push(o.allowCanvasTools); return path.join(os.tmpdir(), 'ccc-no-such-settings.json') },
  removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: (_sid: string, conductorOn: boolean) => { h.mcpConductor.push(conductorOn); return path.join(os.tmpdir(), 'ccc-no-such-mcp.json') },
  removeLocalSessionMcpConfig: () => {},
  removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {}, isPtySessionLive: () => true }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
// An unchecked read says the tools are on; the checked read decides.
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: (key: string) => (key === 'settings' ? { conductorToolsEnabled: true } : {}),
  readConfigChecked: (key: string) => (key === 'settings'
    ? (h.outcome === 'ok' ? { value: { conductorToolsEnabled: true }, outcome: 'ok' } : { value: null, outcome: h.outcome })
    : { value: {}, outcome: 'ok' }),
  getConfigDir: () => os.tmpdir(),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  isValidProfileId: () => false,
  getPrimaryProfileId: () => null,
  getProfileConfigDir: () => path.join(os.tmpdir(), 'ccc-no-such-profile'),
  setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
}))

const { spawnPty, killPty } = await import('../../../src/main/pty-manager')
type SpawnOpts = NonNullable<Parameters<typeof spawnPty>[2]>

const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
let tmp = ''
let seq = 0
let SID = ''

beforeEach(() => {
  SID = `ltools${String(++seq).padStart(18, '0')}`
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-local-tools-')))
  h.outcome = 'ok'; h.mcpConductor = []; h.allowCanvasTools = []; h.pluginAsked = 0; h.codexToolsOn = []
})
afterEach(() => {
  try { killPty(SID) } catch { /* not started */ }
  fs.rmSync(tmp, { recursive: true, force: true })
})

const claude = (): void => { spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp }) }
const codex = (): void => {
  const launch = { lease: { release: vi.fn() }, executable: '/proven/codex', env: { CODEX_HOME: path.join(tmp, 'codex-home') }, sessionsDir: path.join(tmp, 'codex-home', 'sessions'), home: path.join(tmp, 'codex-home') } as unknown as SpawnOpts['codexLaunch']
  spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: launch })
}

describe('a local Claude Code launch', () => {
  // Mutation to prove this can fail: read the local launch's switch from readConfig again.
  it('settings that cannot be read: no built-in tools entry, no pre-allowed canvas tools, no canvas plugin', () => {
    h.outcome = 'unparseable'
    claude()
    expect(h.mcpConductor).toEqual([false])
    expect(h.allowCanvasTools).toEqual([false])
    expect(h.pluginAsked).toBe(0)
  })

  it('settings read and on: the built-in tools, as before', () => {
    claude()
    expect(h.mcpConductor).toEqual([true])
    expect(h.allowCanvasTools).toEqual([true])
    expect(h.pluginAsked).toBe(1)
  })
})

describe('a Codex launch\'s canvas', () => {
  // Mutation to prove this can fail: read the Codex launch's switch from readConfig again.
  it('settings that cannot be read: the canvas launch is told the tools are off', () => {
    h.outcome = 'failed'
    codex()
    expect(h.codexToolsOn).toEqual([false])
  })

  it('settings read and on: the tools are on, as before', () => {
    codex()
    expect(h.codexToolsOn).toEqual([true])
  })
})
