// [host] WP2 PR 4, P4.1 review (A-3, A-2, RA-1): the Codex branch of the REAL
// spawnPty wired to the REAL canvas launch (canvas/codex-canvas-launch.ts) and
// the real realm skills staging, with the built-in tools reaching the launch
// (the conductor server listening). The rest of main is mocked, as
// canvas-codex-roots-spawn.test.ts does.
//  - A-3: a managed account's skills are staged and its guidance recorded; on
//    this computer's own sign-in the decided developer instructions reach the
//    builder; with the tools off a managed realm's staged skills are removed.
//  - A-2: the account's realm ownership decides managed or not; the path rule
//    is only the second guard, against the resources folder's real path.
//  - RA-1: the realm skills follow the Built-in Tools master switch only, as
//    Claude's --plugin-dir carries all three while it is on; a tool group
//    switched off removes none of them.
// The decision for this computer's own sign-in is stubbed (its settings walk
// would read folders above the temporary tree; codex-guidance.test.ts covers
// it with a reader held to its own tree), so nothing outside the temporary
// tree is read or written.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  res: '',
  port: 19333,
  settings: {} as Record<string, unknown>,
  route: 'direct' as 'direct' | 'cmd',
  built: [] as Array<Record<string, unknown>>,
  decided: [] as Array<Record<string, unknown>>,
  // The resume picker's script is not in place (the builder starts Codex itself).
  pickerMissing: false,
}))

vi.mock('node-pty', () => ({
  spawn: () => ({ pid: 7300, process: 'codex', onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }), write: () => {}, resize: () => {}, kill: () => {} }),
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.res, getDataDirectory: () => h.res, registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => h.port, registerCodexReviewSession: () => {}, registerClaudeReviewSession: () => {}, unregisterCodexReviewSession: () => {} }))
vi.mock('../../../src/main/providers', async () => {
  const paths = await import('../../../src/main/providers/codex/realm-paths')
  return {
    getProvider: () => ({
      // Takes the route the real builder would: a named conversation is resumed
      // exactly, else the picker runs when it is in place, else Codex itself.
      buildSpawnCommand: (opts: Record<string, unknown>) => {
        h.built.push(opts)
        const resume = opts.resume as { uuid: string; cwd: string } | undefined
        if (resume) return { cmd: '/proven/codex', args: [], env: {}, logLine: '', resumeId: resume.uuid }
        if (opts.useResumePicker === true && !h.pickerMissing) return { cmd: '/node', args: ['picker.js'], env: {}, logLine: '', viaPicker: true }
        return { cmd: '/proven/codex', args: [], env: {}, logLine: '' }
      },
      ingestSessionTelemetry: () => ({ stop: () => {} }),
      launchRoute: () => h.route,
      stagedSkillsDir: (home: string, resourcesDir: string) => paths.codexManagedRealmSkillsDir(home, resourcesDir),
    }),
  }
})
vi.mock('../../../src/main/canvas/codex-guidance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/canvas/codex-guidance')>()
  return {
    ...actual,
    decideCodexGuidance: (input: Parameters<typeof actual.decideCodexGuidance>[0]) => {
      h.decided.push(input as unknown as Record<string, unknown>)
      return input.external ? { guidance: { guidance: 'full' as const }, developerInstructions: 'THE-DECIDED-GUIDANCE' } : actual.decideCodexGuidance(input)
    },
  }
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
  readConfig: (key: string) => (key === 'settings' ? h.settings : {}),
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
const { codexSessionGuidance, _resetCodexGuidanceForTest } = await import('../../../src/main/canvas/codex-guidance')
const { codexManagedSkillsFolder } = await import('../../../src/main/canvas/codex-canvas-launch')
const { codexManagedRealmSkillsDir } = await import('../../../src/main/providers/codex/realm-paths')
const { stageCodexRealmSkills } = await import('../../../src/main/canvas/codex-realm-skills')
type SpawnOpts = NonNullable<Parameters<typeof spawnPty>[2]>

const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const REALM = 'realm-0123456789abcdef0a1b'
let tmp: string
let managedHome: string
let externalHome: string
let project: string
let seq = 0
let SID = ''
const skill = (home: string, name: string): string => path.join(home, 'skills', name, 'SKILL.md')
const launch = (home: string, ownership?: 'conductor-managed' | 'external-default') => ({
  lease: { release: vi.fn() }, executable: '/proven/codex', env: { CODEX_HOME: home }, sessionsDir: path.join(home, 'sessions'), home, cliVersion: '0.155.1',
  ...(ownership ? { ownership } : {}),
}) as unknown as SpawnOpts['codexLaunch']
const start = (home: string, ownership?: 'conductor-managed' | 'external-default'): void => {
  spawnPty(fakeWin, SID, { cwd: project, cols: 100, rows: 30, provider: 'codex', codexOptions: { permissionsPreset: 'standard' }, codexLaunch: launch(home, ownership) })
}
const stageAll = (): void => { expect(stageCodexRealmSkills(managedHome, codexManagedRealmSkillsDir(managedHome, h.res))).toEqual({ staged: true }) }

beforeEach(() => {
  SID = `wire${String(++seq).padStart(20, '0')}`
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-cx-wiring-')))
  h.res = path.join(tmp, 'res')
  managedHome = path.join(h.res, 'codex-realms', REALM)
  externalHome = path.join(tmp, 'own-codex')
  project = path.join(tmp, 'project')
  for (const d of [managedHome, externalHome, project]) fs.mkdirSync(d, { recursive: true })
  h.port = 19333
  h.settings = {}
  h.route = 'direct'
  h.built = []
  h.decided = []
  h.pickerMissing = false
  _resetCodexGuidanceForTest()
})
afterEach(() => {
  try { killPty(SID) } catch { /* not started */ }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the tools reach the launch (A-3)', () => {
  it('[host] a managed account: its skills are staged, its guidance recorded, and no developer instructions are passed', () => {
    start(managedHome, 'conductor-managed')
    for (const name of ['agent-canvas', 'canvas-plan', 'conductor-vision']) expect(fs.existsSync(skill(managedHome, name))).toBe(true)
    expect(codexSessionGuidance(SID)).toEqual({ guidance: 'full' })
    expect(h.built[0]).not.toHaveProperty('developerInstructions')
  })

  it('[host] this computer\'s own sign-in: the decided developer instructions reach the builder, and the guidance is recorded', () => {
    start(externalHome, 'external-default')
    expect(h.decided[0]).toMatchObject({ external: true, route: 'direct', cliVersion: '0.155.1', home: externalHome, cwds: [project] })
    expect(h.built[0].developerInstructions).toBe('THE-DECIDED-GUIDANCE')
    expect(codexSessionGuidance(SID)).toEqual({ guidance: 'full' })
    expect(fs.existsSync(path.join(externalHome, 'skills'))).toBe(false)
  })

  it('[host] the built-in tools off: a managed realm\'s staged skills are removed, nothing is passed, no guidance recorded', () => {
    stageAll()
    h.settings = { conductorToolsEnabled: false }
    start(managedHome, 'conductor-managed')
    for (const name of ['agent-canvas', 'canvas-plan', 'conductor-vision']) expect(fs.existsSync(path.dirname(skill(managedHome, name)))).toBe(false)
    expect(h.built[0]).not.toHaveProperty('developerInstructions')
    expect(codexSessionGuidance(SID)).toBeNull()
  })

  it('[host] the server not listening is the tools off too: removed', () => {
    stageAll()
    h.port = 0
    start(managedHome, 'conductor-managed')
    expect(fs.existsSync(path.join(managedHome, 'skills', 'agent-canvas'))).toBe(false)
  })
})

describe('managed or not follows the account\'s realm (A-2)', () => {
  it('[host] an app-managed account the path rule cannot find: managed, no skills, said as not staged (never the npm route\'s reason)', () => {
    h.route = 'cmd'
    const elsewhere = path.join(tmp, 'elsewhere', REALM)
    fs.mkdirSync(elsewhere, { recursive: true })
    start(elsewhere, 'conductor-managed')
    expect(codexSessionGuidance(SID)).toEqual({ guidance: 'tools-only', reason: 'skills-not-staged' })
    expect(h.decided.every((d) => d.external === false)).toBe(true)
    expect(fs.existsSync(path.join(elsewhere, 'skills'))).toBe(false)
  })

  it('[host] this computer\'s own sign-in is never staged into, even at a path the rule would take', () => {
    start(managedHome, 'external-default')
    expect(fs.existsSync(path.join(managedHome, 'skills'))).toBe(false)
    expect(h.decided[0]).toMatchObject({ external: true })
  })

  it('[host] the resources folder reached through another spelling: the rule is held against its real path', () => {
    const viaLink = path.join(tmp, 'res-link')
    const realpath = (p: string): string => (p === viaLink ? h.res : p)
    const found = codexManagedSkillsFolder({ ownership: 'conductor-managed', home: managedHome, resourcesDir: viaLink, managedSkillsDirFor: codexManagedRealmSkillsDir }, realpath)
    expect(found).toEqual({ managed: true, skillsDir: path.join(managedHome, 'skills') })
    const raw = codexManagedSkillsFolder({ ownership: 'conductor-managed', home: managedHome, resourcesDir: viaLink, managedSkillsDirFor: codexManagedRealmSkillsDir }, (p) => p)
    expect(raw).toEqual({ managed: true, skillsDir: null })
  })

  it('[host] no ownership known: the path rule alone, as before', () => {
    expect(codexManagedSkillsFolder({ home: managedHome, resourcesDir: h.res, managedSkillsDirFor: codexManagedRealmSkillsDir })).toEqual({ managed: true, skillsDir: path.join(managedHome, 'skills') })
    expect(codexManagedSkillsFolder({ home: externalHome, resourcesDir: h.res, managedSkillsDirFor: codexManagedRealmSkillsDir })).toEqual({ managed: false, skillsDir: null })
  })
})

describe('the realm skills follow the master switch only, as Claude\'s --plugin-dir (review RA-1)', () => {
  it.each([
    ['the Canvas switch off', { conductorTools: { canvas: false } }],
    ['the Vision switch off', { conductorTools: { vision: false } }],
    ['both tool groups off', { conductorTools: { canvas: false, vision: false } }],
  ])('[host] %s, the built-in tools on: all three skills are staged and kept', (_name, settings) => {
    stageAll()
    h.settings = settings
    start(managedHome, 'conductor-managed')
    for (const name of ['agent-canvas', 'canvas-plan', 'conductor-vision']) expect(fs.existsSync(skill(managedHome, name))).toBe(true)
    expect(codexSessionGuidance(SID)).toEqual({ guidance: 'full' })
  })
})

// [host] PR 4 VM checkpoint (F2): a launch from a saved config goes through
// the app's resume picker. The picker runs in the configured folder, so the
// guidance is decided for that folder's settings layers, as a direct launch
// is (question 5's default A), and reaches the builder; the picker passes it
// on only to a Codex it starts there (scripts/lib/codex-resume-picker-lib.js
// flagsForFolder).
describe('a launch through the resume picker (the VM checkpoint, F2)', () => {
  const startPicker = (home: string, ownership?: 'conductor-managed' | 'external-default'): void => {
    spawnPty(fakeWin, SID, { cwd: project, cols: 100, rows: 30, provider: 'codex', useResumePicker: true, codexOptions: { permissionsPreset: 'standard' }, codexLaunch: launch(home, ownership) })
  }

  it('[host] this computer\'s own sign-in: decided for the configured folder the picker runs in, and the instructions reach the builder', () => {
    startPicker(externalHome, 'external-default')
    expect(h.decided[0]).toMatchObject({ external: true, route: 'direct', cliVersion: '0.155.1', home: externalHome, cwds: [project] })
    expect(h.built[0].useResumePicker).toBe(true)
    expect(h.built[0].developerInstructions).toBe('THE-DECIDED-GUIDANCE')
    // Review RVMFIX-3: recorded as the picker delivers it, not as full: passed
    // when Codex starts in this folder, kept out of another worktree, and a
    // resumed conversation that already has instructions keeps its own.
    expect(codexSessionGuidance(SID)).toEqual({ guidance: 'picker' })
  })

  it('[host] a managed account through the picker: its staged skills reach any conversation, so full (review RVMFIX-3)', () => {
    startPicker(managedHome, 'conductor-managed')
    expect(h.built[0].developerInstructions).toBeUndefined()
    expect(codexSessionGuidance(SID)).toEqual({ guidance: 'full' })
  })

  it('[host] this computer\'s own sign-in started directly: still full (review RVMFIX-3)', () => {
    start(externalHome, 'external-default')
    expect(h.built[0].developerInstructions).toBe('THE-DECIDED-GUIDANCE')
    expect(codexSessionGuidance(SID)).toEqual({ guidance: 'full' })
  })

  it('[host] a restored conversation the picker launch also names: its folder is scanned too', () => {
    const other = path.join(tmp, 'other-worktree')
    fs.mkdirSync(other, { recursive: true })
    spawnPty(fakeWin, SID, { cwd: project, cols: 100, rows: 30, provider: 'codex', useResumePicker: true, resume: { uuid: '019dd000-0001-7000-8000-000000000101', cwd: other }, codexOptions: { permissionsPreset: 'standard' }, codexLaunch: launch(externalHome, 'external-default') })
    expect(h.decided[0]).toMatchObject({ cwds: [project, other] })
  })

  // Review (ADRFIX verification): the record follows the route the launch took, not the option asked for.
  it('[host] a picker launch that resumed its named conversation exactly: recorded as full, not as the picker', () => {
    const other = path.join(tmp, 'other-worktree')
    fs.mkdirSync(other, { recursive: true })
    spawnPty(fakeWin, SID, { cwd: project, cols: 100, rows: 30, provider: 'codex', useResumePicker: true, resume: { uuid: '019dd000-0001-7000-8000-000000000101', cwd: other }, codexOptions: { permissionsPreset: 'standard' }, codexLaunch: launch(externalHome, 'external-default') })
    expect(h.built[0].developerInstructions).toBe('THE-DECIDED-GUIDANCE')
    expect(codexSessionGuidance(SID)).toEqual({ guidance: 'full' })
  })

  it('[host] the picker not in place, so Codex was started directly: recorded as full, not as the picker', () => {
    h.pickerMissing = true
    startPicker(externalHome, 'external-default')
    expect(h.built[0].developerInstructions).toBe('THE-DECIDED-GUIDANCE')
    expect(codexSessionGuidance(SID)).toEqual({ guidance: 'full' })
  })
})
