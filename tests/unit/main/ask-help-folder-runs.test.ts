// [host] ADR-009 round 1 (PR 4, finding L1-2): before the help folder is
// rebuilt for an Ask launch, every local agent run working in it -- either
// assistant, the tab's own previous run included -- is ended with the
// session's own kill and its end waited for, bounded
// (src/main/pty-manager.ts endAgentRunsInFolder): nothing still running
// writes into the folder after it is rebuilt. A run a Restart already killed
// is waited for too; a spawn the session is preparing is left in place (the
// old run's end is that spawn's to supersede); a run still going at the bound
// answers false, and pty:spawn then starts nothing
// (ask-conductor-handoff-ipc.test.ts). Real spawnPty, a fake node-pty whose
// processes end when the test says; nothing is started.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type FakeProc = { cwd: string; killed: number; pid: number; exit: () => void }
const h = vi.hoisted(() => ({
  procs: [] as Array<{ cwd: string; killed: number; pid: number; exit: () => void }>,
  pid: 0,
  sent: [] as string[],
}))

vi.mock('node-pty', () => ({
  spawn: (_cmd: string, _args: unknown, opts: { cwd: string }) => {
    const exits: Array<(e: { exitCode: number }) => void> = []
    let ended = false
    const rec = {
      cwd: opts.cwd,
      killed: 0,
      pid: h.pid || process.pid,
      exit: () => { if (ended) return; ended = true; for (const cb of [...exits]) cb({ exitCode: 0 }) },
    }
    h.procs.push(rec)
    return {
      pid: rec.pid, process: 'x',
      onData: () => ({ dispose: () => {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb); return { dispose: () => {} } },
      write: () => {}, resize: () => {}, kill: () => { rec.killed++ },
    }
  },
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
vi.mock('../../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 0, registerCodexReviewSession: () => {}, registerClaudeReviewSession: () => {}, unregisterCodexReviewSession: () => {} }))
vi.mock('../../../src/main/providers', () => ({
  getProvider: (id: string) => (id === 'codex'
    ? { buildSpawnCommand: () => ({ cmd: '/proven/codex', args: [], env: {}, logLine: '' }), ingestSessionTelemetry: () => ({ stop: () => {} }), launchRoute: () => 'direct' }
    : { resolveBinary: () => ({ cmd: 'claude', source: 'system' }), buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }), ingestSessionTelemetry: () => ({ stop: () => {} }) }),
}))
vi.mock('../../../src/main/canvas/codex-canvas-launch', () => ({ prepareCodexCanvasLaunch: () => ({ designatedWorktree: null, guidance: null }) }))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
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

const { spawnPty, killPty, endAgentRunsInFolder, beginSpawnPreparation, isSessionWritable } = await import('../../../src/main/pty-manager')
type SpawnOpts = NonNullable<Parameters<typeof spawnPty>[2]>

const fakeWin = { isDestroyed: () => false, webContents: { send: (channel: string) => { h.sent.push(channel) } } } as unknown as Parameters<typeof spawnPty>[0]
let tmp = ''
let help = ''
let elsewhere = ''
let seq = 0
const ids: string[] = []
const newId = (): string => { const id = `askr${String(++seq).padStart(20, '0')}`; ids.push(id); return id }
const codexLaunch = () => ({ lease: { release: vi.fn() }, executable: '/proven/codex', env: { CODEX_HOME: path.join(tmp, 'codex-home') }, sessionsDir: path.join(tmp, 'codex-home', 'sessions'), home: path.join(tmp, 'codex-home') }) as unknown as SpawnOpts['codexLaunch']
/** Start a session in `cwd`; its fake process. */
function codex(id: string, cwd: string, extra: Partial<SpawnOpts> = {}): FakeProc {
  spawnPty(fakeWin, id, { cwd, cols: 100, rows: 30, provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: codexLaunch(), ...extra })
  return h.procs[h.procs.length - 1]
}
function claude(id: string, cwd: string, extra: Partial<SpawnOpts> = {}): FakeProc {
  spawnPty(fakeWin, id, { cwd, cols: 100, rows: 30, ...extra })
  return h.procs[h.procs.length - 1]
}
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-ask-runs-')))
  help = path.join(tmp, 'res', 'help')
  elsewhere = path.join(tmp, 'project')
  fs.mkdirSync(help, { recursive: true })
  fs.mkdirSync(elsewhere, { recursive: true })
  h.procs = []
  h.pid = 0
  h.sent = []
})
afterEach(() => {
  for (const p of h.procs) p.exit()
  for (const id of ids.splice(0)) { try { killPty(id) } catch { /* not started */ } }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the runs in the help folder end before it is rebuilt', () => {
  it('[host] a Codex run and a Claude run in it are ended and waited for; a run elsewhere is untouched', async () => {
    const a = codex(newId(), help, { isAsk: true })
    const b = claude(newId(), help, { isAsk: true })
    const otherId = newId()
    const c = codex(otherId, elsewhere)
    let answer: boolean | undefined
    const ending = endAgentRunsInFolder(help, 5_000).then((r) => { answer = r })
    expect(a.killed).toBe(1)
    expect(b.killed).toBe(1)
    expect(c.killed).toBe(0)
    await tick(10)
    expect(answer).toBeUndefined()
    a.exit()
    await tick(10)
    expect(answer).toBeUndefined()
    b.exit()
    await ending
    expect(answer).toBe(true)
    expect(isSessionWritable(otherId)).toBe(true)
  })

  it('[host] a run a Restart already killed (its kill does not wait) is waited for, not killed again', async () => {
    const id = newId()
    const a = codex(id, help, { isAsk: true })
    killPty(id, { reason: 'restart' })
    expect(a.killed).toBe(1)
    let answer: boolean | undefined
    const ending = endAgentRunsInFolder(help, 5_000).then((r) => { answer = r })
    await tick(10)
    expect(answer).toBeUndefined()
    expect(a.killed).toBe(1)
    a.exit()
    await ending
    expect(answer).toBe(true)
  })

  it('[host] a run still going at the bound: false (the launch then starts nothing)', async () => {
    h.pid = process.pid // a process that is certainly still running
    codex(newId(), help, { isAsk: true })
    expect(await endAgentRunsInFolder(help, 50)).toBe(false)
  })

  it('[host] a run whose end was never reported but whose process is gone counts as ended', async () => {
    h.pid = 2_147_483_640 // no such process
    codex(newId(), help, { isAsk: true })
    expect(await endAgentRunsInFolder(help, 50)).toBe(true)
    // And it is not waited for again.
    expect(await endAgentRunsInFolder(help, 50)).toBe(true)
  })

  it('[host] nothing in the help folder: true at once', async () => {
    codex(newId(), elsewhere)
    expect(await endAgentRunsInFolder(help, 5_000)).toBe(true)
    expect(h.procs[0].killed).toBe(0)
  })

  it('[host] the tab\'s own respawn being prepared is left in place, and its old run\'s end is that spawn\'s to supersede', async () => {
    const id = newId()
    const a = claude(id, help, { isAsk: true })
    const preparation = beginSpawnPreparation(fakeWin, id, 'claude')
    const ending = endAgentRunsInFolder(help, 5_000)
    expect(a.killed).toBe(1)
    expect(preparation.current).toBe(true)
    a.exit()
    expect(await ending).toBe(true)
    expect(preparation.current).toBe(true)
    // The renderer is not told the session ended: its respawn follows.
    expect(h.sent).not.toContain(`pty:exit:${id}`)
    // Abandoned, the spawn ends the session after all.
    preparation.abandon()
    expect(h.sent).toContain(`pty:exit:${id}`)
  })

  it('[host] the help folder however it is spelled where names ignore case, and a folder inside it', async () => {
    const inside = path.join(help, 'sub')
    fs.mkdirSync(inside)
    const sibling = path.join(tmp, 'res', 'help2')
    fs.mkdirSync(sibling)
    const runs = [codex(newId(), inside, { isAsk: true }), codex(newId(), sibling)]
    const caseless = process.platform === 'win32' || process.platform === 'darwin'
    if (caseless) runs.push(codex(newId(), path.join(tmp, 'res', 'HELP'), { isAsk: true }))
    const ending = endAgentRunsInFolder(help, 5_000)
    expect(runs[0].killed).toBe(1)
    expect(runs[1].killed).toBe(0)
    if (caseless) expect(runs[2].killed).toBe(1)
    for (const r of runs) if (r !== runs[1]) r.exit()
    expect(await ending).toBe(true)
  })
})
