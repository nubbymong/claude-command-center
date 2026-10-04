// [host] WP2 PR 4 (dependency boundaries, WP1.55 R3/R4): the PTY manager
// reaches the Codex package only through the registered provider, never by
// importing it. Through the REAL spawnPty (the rest of main mocked, as
// canvas-codex-roots-spawn.test.ts does), a fake registered Codex provider
// shows what the Codex branch takes from it:
//  - no launch route for the canvas launch: the skills are in the account's
//    own skills folder, which every route lists (section 10 question 5,
//    answered C), so the route is neither asked for nor handed on;
//  - a managed account's skills folder (stagedSkillsDir), handed to the
//    canvas launch, and none when the provider gives none;
//  - the builder's log line (logLine), and no argument logged without one;
//  - the run's pane (runScreen): opened with the Watchdog's CSI clamp, fed
//    the run's output, resized with the PTY, closed with the session, and the
//    door a canvas marker goes through.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

type Opened = { sessionId: string; cols: number; rows: number; clamp: unknown; write: (d: string) => void; current: () => boolean }
const h = vi.hoisted(() => ({
  onData: [] as Array<(d: string) => void>,
  infos: [] as string[],
  canvasInputs: [] as Array<Record<string, unknown>>,
  calls: [] as string[],
  opened: [] as Opened[],
  provider: {} as Record<string, unknown>,
}))

vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 7100, process: 'codex',
    onData: (cb: (d: string) => void) => { h.onData.push(cb); return { dispose: () => {} } },
    onExit: () => ({ dispose: () => {} }), write: () => {}, resize: () => {}, kill: () => {},
  }),
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res', getDataDirectory: () => '/res', registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: (m: string) => { h.infos.push(m) }, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 0, registerCodexReviewSession: () => {}, registerClaudeReviewSession: () => {}, unregisterCodexReviewSession: () => {} }))
vi.mock('../../../src/main/providers', () => ({ getProvider: () => h.provider }))
vi.mock('../../../src/main/canvas/codex-canvas-launch', () => ({
  prepareCodexCanvasLaunch: (input: Record<string, unknown>) => { h.canvasInputs.push(input); return { designatedWorktree: null, guidance: null } },
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/main/canvas/canvas-plugin')>()), ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null, removeLocalSessionSettings: () => {}, writeLocalSessionMcpConfig: () => null, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {}, isPtySessionLive: () => true }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
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
  setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
}))

const { spawnPty, killPty, resizePty, writeCanvasMarkerLine } = await import('../../../src/main/pty-manager')
const { clampAnsiChunk } = await import('../../../src/main/watchdog/watchdog-manager')
type SpawnOpts = NonNullable<Parameters<typeof spawnPty>[2]>

const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const HOME = path.resolve(os.tmpdir(), 'ccc-port-home')
const launch = () => ({ lease: { release: vi.fn() }, executable: '/proven/codex', env: { CODEX_HOME: HOME }, sessionsDir: path.join(HOME, 'sessions'), home: HOME }) as unknown as SpawnOpts['codexLaunch']
let seq = 0
let SID = ''
const start = (): void => {
  spawnPty(fakeWin, SID, { cwd: os.tmpdir(), cols: 100, rows: 30, provider: 'codex', codexOptions: { permissionsPreset: 'standard' }, codexLaunch: launch() })
}
const launchLine = (): string | undefined => [...h.infos].reverse().find((l) => l.includes('Launching Codex PTY'))

/** A registered Codex provider with every member the Codex branch reads. */
function fullProvider(): Record<string, unknown> {
  return {
    buildSpawnCommand: () => ({ cmd: '/proven/codex', args: ['--sandbox', 'workspace-write', 'SECRETARG'], env: {}, logLine: '--sandbox workspace-write <redacted>' }),
    ingestSessionTelemetry: () => ({ stop: () => {} }),
    stagedSkillsDir: (home: string, res: string) => { h.calls.push(`skills ${home} ${res}`); return path.join(home, 'skills') },
    runScreen: {
      open: (sessionId: string, opts: Omit<Opened, 'sessionId'>) => { h.opened.push({ sessionId, ...opts }); h.calls.push(`open ${sessionId}`) },
      feed: (sessionId: string, data: string) => { h.calls.push(`feed ${sessionId} ${data}`) },
      resize: (sessionId: string, cols: number, rows: number) => { h.calls.push(`resize ${sessionId} ${cols}x${rows}`) },
      close: (sessionId: string) => { h.calls.push(`close ${sessionId}`) },
      has: (sessionId: string) => h.opened.some((o) => o.sessionId === sessionId),
      submit: async (sessionId: string, text: string) => { h.calls.push(`submit ${sessionId} ${text}`); return { delivered: true } },
    },
  }
}

beforeEach(() => {
  SID = `port${String(++seq).padStart(20, '0')}`
  h.onData = []
  h.infos = []
  h.canvasInputs = []
  h.calls = []
  h.opened = []
  h.provider = fullProvider()
})

describe('the canvas launch needs no launch route (question 5, answered C)', () => {
  it('the route is neither asked of the provider nor handed to the canvas launch, nor anything option A read', () => {
    // The port is gone from the provider contract; a provider that still
    // offered one is never asked.
    h.provider.launchRoute = (exe: string) => { h.calls.push(`route ${exe}`); return 'direct' }
    start()
    expect(h.calls.some((c) => c.startsWith('route '))).toBe(false)
    for (const key of ['route', 'cliVersion', 'startFolders', 'env']) expect(h.canvasInputs[0]).not.toHaveProperty(key)
    killPty(SID)
  })
})

describe('a managed account\'s skills folder comes from the registered provider', () => {
  it('the canvas launch asks the provider for the home\'s skills folder', () => {
    start()
    const resolve = h.canvasInputs[0].managedSkillsDirFor as (home: string, res: string) => string | null
    expect(resolve(HOME, '/res')).toBe(path.join(HOME, 'skills'))
    expect(h.calls).toContain(`skills ${HOME} /res`)
    killPty(SID)
  })

  it('a provider that gives none: no folder, nothing staged', () => {
    delete h.provider.stagedSkillsDir
    start()
    const resolve = h.canvasInputs[0].managedSkillsDirFor as (home: string, res: string) => string | null
    expect(resolve(HOME, '/res')).toBeNull()
    killPty(SID)
  })
})

describe('the logged launch line is the builder\'s', () => {
  it('logs the builder\'s line, never the arguments themselves', () => {
    start()
    expect(launchLine()).toContain('--sandbox workspace-write <redacted>')
    expect(launchLine()).not.toContain('SECRETARG')
    killPty(SID)
  })

  it('a builder that gives no log line: no argument is logged', () => {
    h.provider.buildSpawnCommand = () => ({ cmd: '/proven/codex', args: ['SECRETARG'], env: {} })
    start()
    expect(launchLine()).toContain('(arguments not logged)')
    expect(launchLine()).not.toContain('SECRETARG')
    killPty(SID)
  })
})

describe('the run\'s pane is the registered provider\'s', () => {
  it('opened for the run with the Watchdog\'s CSI clamp, at the PTY\'s size, writing into that run', () => {
    start()
    expect(h.opened).toHaveLength(1)
    expect(h.opened[0]).toMatchObject({ sessionId: SID, cols: 100, rows: 30 })
    expect(h.opened[0].clamp).toBe(clampAnsiChunk)
    expect(h.opened[0].current()).toBe(true)
    killPty(SID)
  })

  it('fed the run\'s output, resized with the PTY, and closed with the session', () => {
    start()
    for (const cb of h.onData) cb('hello')
    expect(h.calls).toContain(`feed ${SID} hello`)
    resizePty(SID, 80, 24)
    expect(h.calls).toContain(`resize ${SID} 80x24`)
    killPty(SID)
    expect(h.calls).toContain(`close ${SID}`)
  })

  it('a canvas marker into a Codex session goes through the pane\'s submit', async () => {
    start()
    const answer = writeCanvasMarkerLine(SID, 'Approved v7 on the canvas')
    expect(await answer).toEqual({ delivered: true })
    expect(h.calls).toContain(`submit ${SID} Approved v7 on the canvas`)
    killPty(SID)
  })

  it('a provider with no pane: the launch still starts, and a marker is the session gone', async () => {
    delete h.provider.runScreen
    start()
    expect(h.opened).toHaveLength(0)
    expect(await writeCanvasMarkerLine(SID, 'Approved v7 on the canvas')).toEqual({ delivered: false, reason: 'session-gone' })
    killPty(SID)
  })
})
