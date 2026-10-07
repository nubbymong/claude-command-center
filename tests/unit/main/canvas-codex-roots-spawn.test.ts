// [host] WP2 PR 4, P4.1 (row 51): a Codex session's Agent Canvas serving
// roots, end to end through the REAL spawnPty and the REAL canvas store (the
// rest of main mocked, as canvas-worktree-spawn.test.ts and
// codex-resume-launch.test.ts do). The rule is the Claude branch's: the
// CONFIGURED project directory, `resolveCwd(options.cwd)`, refused at home or
// above; the worktree CCC designates from that directory and its own session
// id, told to the guard through CCC_SESSION_WORKTREE; never the folder a
// resumed conversation's rollout records, though Codex starts there (P3.5).
// And the canvas is linked to the conversation the session is on.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  spawns: [] as Array<{ cwd: string; env: Record<string, string> }>,
  built: [] as Array<Record<string, unknown>>,
  telemetry: [] as Array<Record<string, unknown>>,
  /** The folder a resumed conversation's rollout records (transcript content). */
  rolloutCwd: null as string | null,
}))

vi.mock('node-pty', () => ({
  spawn: (_cmd: string, _args: string[] | string, opts: { cwd?: string; env?: Record<string, string> }) => {
    h.spawns.push({ cwd: opts?.cwd ?? '', env: opts?.env ?? {} })
    return { pid: 7000 + h.spawns.length, process: 'codex', onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }), write: () => {}, resize: () => {}, kill: () => {} }
  },
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-codex-roots-res-'))
  return { getResourcesDirectory: () => dir, getDataDirectory: () => dir, registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }
})
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
  registerCodexReviewSession: () => {},
  registerClaudeReviewSession: () => {},
  unregisterCodexReviewSession: () => {},
  releaseMcpSessionProvider: () => {},
}))
const STALE_WT = path.join('F:', 'stale-outer', 'ccc-wt', 'deadbeefdead')
// The registered Codex provider's pane is the real one (session-screen.ts):
// the PTY manager reaches it only through the registry.
vi.mock('../../../src/main/providers', async () => {
  const screen = await import('../../../src/main/providers/codex/session-screen')
  const runScreen = { open: screen.openCodexScreen, feed: screen.feedCodexScreen, resize: screen.resizeCodexScreen, close: screen.closeCodexScreen, has: screen.hasCodexScreen, submit: screen.submitCodexText }
  return { getProvider: () => ({
    runScreen,
    buildSpawnCommand: (opts: Record<string, unknown>) => {
      h.built.push(opts)
      const launch = opts.realmLaunch as { executable: string; env: Record<string, string> }
      const resume = opts.resume as { uuid: string; cwd: string } | undefined
      // Stand in for the real builder's environment, which spreads the realm's
      // (and so CCC's own): a STALE inherited hint, which must be replaced.
      const env = { ...launch.env, ccc_session_worktree: STALE_WT }
      if (resume) return { cmd: launch.executable, args: ['resume', resume.uuid], env, resumeId: resume.uuid, cwd: h.rolloutCwd ?? undefined }
      return { cmd: launch.executable, args: [], env }
    },
    ingestSessionTelemetry: (_sid: string, opts: Record<string, unknown>) => { h.telemetry.push(opts); return { stop: () => {} } },
  }) }
})
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

const store = await import('../../../src/main/canvas/canvas-store')
const link = await import('../../../src/main/canvas/canvas-session-link')
const { spawnPty, killPty, writeCanvasMarkerLine } = await import('../../../src/main/pty-manager')
type SpawnOpts = NonNullable<Parameters<typeof spawnPty>[2]>

let seq = 0
let SID = ''
const ID = '019dd000-0001-7000-8000-0000000000e1'
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const launch = () => ({ lease: { release: vi.fn() }, executable: '/proven/codex', env: { CODEX_HOME: '/home/u/.codex' }, sessionsDir: '/home/u/.codex/sessions' }) as unknown as SpawnOpts['codexLaunch']
const start = (cwd: string, extra: Partial<SpawnOpts> = {}): string => {
  try {
    spawnPty(fakeWin, SID, { cwd, provider: 'codex', codexOptions: { permissionsPreset: 'standard' }, codexLaunch: launch(), ...extra })
    return ''
  } catch (err) {
    return ` (spawnPty threw: ${(err as Error)?.message ?? err})`
  }
}

const temps: string[] = []
function primaryProject(prefix: string): { parent: string; project: string; wtBase: string } {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  temps.push(parent)
  const project = path.join(parent, 'project')
  fs.mkdirSync(path.join(project, '.git'), { recursive: true })
  fs.mkdirSync(path.join(project, 'dist'))
  fs.writeFileSync(path.join(project, 'dist', 'index.html'), '<html><body>app</body></html>')
  return { parent, project, wtBase: path.join(parent, 'ccc-wt') }
}
function plainFolder(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  temps.push(dir)
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'PRIVATE')
  return dir
}
const served = (file: string): boolean => { try { store.resolveInsideCanvasRoot(file, SID); return true } catch { return false } }
const worktreeEnv = (env: Record<string, string>): string[] => Object.keys(env).filter((k) => k.toUpperCase() === 'CCC_SESSION_WORKTREE').map((k) => env[k])

beforeEach(() => {
  SID = `cxr${String(++seq).padStart(21, '0')}`
  h.spawns = []
  h.built = []
  h.telemetry = []
  h.rolloutCwd = null
  store._resetCanvasStoreForTest()
})
afterAll(() => {
  for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best-effort */ } }
})

describe('a Codex session\'s canvas roots come from its configured folder', () => {
  it('serves the configured project, and the worktree CCC designates once it exists', () => {
    const { project, wtBase } = primaryProject('ccc-cxr-plain-')
    const designated = path.join(wtBase, SID.slice(0, 12))
    const why = start(project)
    expect(why).toBe('')
    expect(served(path.join(project, 'dist', 'index.html')), why).toBe(true)
    // The guard is told where, in exactly one spelling: the stale hint is gone.
    expect(worktreeEnv(h.spawns[0].env)).toEqual([designated])
    expect(served(path.join(designated, 'mock.html'))).toBe(false)
    fs.mkdirSync(designated, { recursive: true })
    fs.writeFileSync(path.join(designated, 'mock.html'), '<html></html>')
    expect(served(path.join(designated, 'mock.html'))).toBe(true)
    killPty(SID)
    expect(served(path.join(project, 'dist', 'index.html'))).toBe(false)
  })

  it('never from a resumed conversation\'s folder, though Codex starts there', () => {
    const { project } = primaryProject('ccc-cxr-config-')
    const rolloutFolder = plainFolder('ccc-cxr-rollout-')
    h.rolloutCwd = rolloutFolder
    const why = start(project, { resume: { uuid: ID, cwd: rolloutFolder } })
    expect(h.spawns[0].cwd, why).toBe(rolloutFolder)
    expect(served(path.join(project, 'dist', 'index.html'))).toBe(true)
    expect(served(path.join(rolloutFolder, 'secret.txt'))).toBe(false)
    // Nor is the worktree derived from it.
    expect(worktreeEnv(h.spawns[0].env)[0]).toContain(path.dirname(project))
    killPty(SID)
  })

  it('refuses a home (or above) project and designates no worktree there', () => {
    const why = start('.')
    expect(why).toBe('')
    expect(served(path.join(os.homedir(), '.ssh', 'id_rsa'))).toBe(false)
    expect(worktreeEnv(h.spawns[0].env)).toEqual([])
    expect(store.canvasRootRefusalFor(SID)).toMatch(/home/i)
    killPty(SID)
  })

  it('a project that is not a primary checkout: served, no worktree, the stale hint scrubbed', () => {
    const dir = plainFolder('ccc-cxr-norepo-')
    start(dir)
    expect(served(path.join(dir, 'secret.txt'))).toBe(true)
    expect(worktreeEnv(h.spawns[0].env)).toEqual([])
    killPty(SID)
  })
})

describe('a Codex session\'s canvas markers go through the submit primitive', () => {
  it('answers later (the primitive waits for Codex\'s prompt), and a session that ends is told so', async () => {
    const { project } = primaryProject('ccc-cxr-marker-')
    start(project)
    const answer = writeCanvasMarkerLine(SID, `Approved v7 on the canvas ${String.fromCharCode(0xb7)} canvas_version_verdict recorded`)
    expect(answer && typeof (answer as Promise<unknown>).then).toBe('function')
    // Waiting on the run's pane for Codex's prompt, not answered at once.
    expect(await Promise.race([answer, new Promise((r) => setTimeout(() => r('pending'), 100))])).toBe('pending')
    killPty(SID)
    expect(await answer).toEqual({ delivered: false, reason: 'session-gone' })
  })

  it('any other session keeps the synchronous submit line', () => {
    expect(writeCanvasMarkerLine('nopty0000000nopty0000000', 'Approved v7 on the canvas')).toBeUndefined()
  })
})

describe('the canvas is linked to the conversation the Codex session is on', () => {
  it('the session info the canvas store reads names the claimed conversation', () => {
    let resolver: Parameters<typeof store.setCanvasSessionInfoResolver>[0] = null
    const spy = vi.spyOn(store, 'setCanvasSessionInfoResolver').mockImplementation((r) => { resolver = r })
    link.installCanvasSessionLink()
    spy.mockRestore()
    const { project } = primaryProject('ccc-cxr-link-')
    start(project)
    expect(resolver!(SID)?.conversationUuid).toBeUndefined()
    const claim = h.telemetry[h.telemetry.length - 1].onClaim as (c: { id: string; cwd: string; certain: boolean }) => void
    claim({ id: ID, cwd: project, certain: true })
    expect(resolver!(SID)?.conversationUuid).toBe(ID)
    killPty(SID)
  })
})
