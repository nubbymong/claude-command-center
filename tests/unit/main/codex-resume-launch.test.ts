// P3.5 (rows 34, 35): a Codex session keeps the conversation it is on, and its
// launch resumes it, as a Claude tab's does -- a restored tab its persisted
// conversation (options.resume), a Restart the conversation the tab is on (the
// kept one, self-captured by main across the kill, as Claude's lastResumeTarget
// is), and "Restart and pick a conversation" still opens the picker. The tab
// keeps the conversation the status line claims (onClaim), or the one an
// exact resume starts, for session:save to persist (session-resume-enrich).
//
// Drives the REAL spawnPty with node-pty, the provider and the rest of main
// mocked (the stack of tests/wp1/launch-handoff-pty.test.ts). No process starts.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  ptys: [] as Array<{ cmd: string; cwd: string }>,
  built: [] as Array<Record<string, unknown>>,
  telemetry: [] as Array<{ sessionId: string; opts: Record<string, unknown> }>,
  missing: new Set<string>(),
  mismatched: new Set<string>(),
  reviewRoots: [] as Array<{ sid: string; cwd: string }>,
  warnings: [] as string[],
}))

vi.mock('node-pty', () => ({
  spawn: (cmd: string, _args: string[] | string, opts: { cwd?: string }) => {
    h.ptys.push({ cmd, cwd: opts?.cwd ?? '' })
    return {
      pid: 5000 + h.ptys.length,
      process: 'codex',
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
    }
  },
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-codex-resume-res-'))
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
vi.mock('../../../src/main/debug-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/debug-logger')>()),
  logWarn: (msg: string) => { h.warnings.push(String(msg)) },
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  registerCodexReviewSession: () => {},
  registerClaudeReviewSession: (sid: string, cwd: string) => { h.reviewRoots.push({ sid, cwd }) },
  unregisterCodexReviewSession: () => {},
  disposeCodexReviewUsage: () => {},
}))
vi.mock('../../../src/main/providers', () => ({
  getProvider: () => ({
    buildSpawnCommand: (opts: Record<string, unknown>) => {
      if (opts.provider !== 'codex') return { cmd: 'pwsh', args: [], env: {} }
      h.built.push(opts)
      const launch = opts.realmLaunch as { executable: string; env: Record<string, string> }
      const resume = opts.resume as { uuid: string; cwd: string } | undefined
      // The real builder resumes only a conversation of the launch's realm
      // (spawn-resume.test.ts); here, any id not marked missing.
      if (resume && !h.missing.has(resume.uuid)) {
        return { cmd: launch.executable, args: ['resume', resume.uuid], env: launch.env, resumeId: resume.uuid, cwd: `/conversations/${resume.uuid}`, resumeCwdMismatch: h.mismatched.has(resume.uuid), resumePath: `/realm/sessions/${resume.uuid}.jsonl` }
      }
      if (opts.useResumePicker) return { cmd: 'node', args: ['picker.js'], env: launch.env, pickFile: '/tmp/ccc-codex-pick-x.json', pickFolder: { id: '7:9', real: '/tmp' } }
      return { cmd: launch.executable, args: [], env: launch.env }
    },
    ingestSessionTelemetry: (sessionId: string, opts: Record<string, unknown>) => {
      h.telemetry.push({ sessionId, opts })
      return { stop: () => {} }
    },
  }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({
  resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }),
  resolveHostColorScheme: () => 'dark',
}))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null,
  removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => null,
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
vi.mock('../../../src/main/session-registry', () => ({
  updateSessionMeta: () => {},
  clearSessionMeta: () => {},
  markPtySessionAlive: () => {},
  markPtySessionGone: () => {},
}))
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
  setupProfileLinks: () => {},
  syncPrimaryCredentialsWithGlobal: () => {},
  backupProfileHomeToCanonical: () => {},
}))

const { spawnPty, killPty, getKeptCodexConversation, getKeptCodexConversationSource, KEPT_CODEX_CONVERSATIONS_MAX } = await import('../../../src/main/pty-manager')
type SpawnOpts = NonNullable<Parameters<typeof spawnPty>[2]>

// A new session id per test: the kept conversation outlives a kill by design.
let seq = 0
let SID = ''
const ID = '019dd000-0001-7000-8000-0000000000d1'
const ID2 = '019dd000-0001-7000-8000-0000000000d2'
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const launch = () => ({ lease: { release: vi.fn() }, executable: '/proven/codex', env: { CODEX_HOME: '/res/codex-realms/a' }, sessionsDir: '/res/codex-realms/a/sessions' }) as unknown as SpawnOpts['codexLaunch']
const start = (extra: Partial<SpawnOpts> = {}, sid = SID) =>
  spawnPty(fakeWin, sid, { cwd: os.tmpdir(), provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: launch(), ...extra })
const lastTelemetry = () => h.telemetry[h.telemetry.length - 1].opts
const claim = (id: string, cwd: string, certain = true) => (lastTelemetry().onClaim as (c: { id: string; cwd: string; certain: boolean }) => void)({ id, cwd, certain })

beforeEach(() => {
  SID = `cr${String(++seq).padStart(22, '0')}`
  h.ptys = []
  h.built = []
  h.telemetry = []
  h.missing = new Set()
  h.mismatched = new Set()
  h.reviewRoots = []
  h.warnings = []
})

describe('a restored Codex session resumes its conversation (row 34)', () => {
  it('hands the builder the persisted conversation, starts where the builder says, watches for that conversation and keeps it', () => {
    start({ resume: { uuid: ID, cwd: '/p/demo' } })
    expect(h.built[0].resume).toEqual({ uuid: ID, cwd: '/p/demo' })
    expect(h.ptys[0].cwd).toBe(`/conversations/${ID}`)
    expect(lastTelemetry().resumeId).toBe(ID)
    expect(lastTelemetry().cwd).toBe(`/conversations/${ID}`)
    // Fix round 2: the rollout the builder chose, so the watcher does not walk again.
    expect(lastTelemetry().resumePath).toBe(`/realm/sessions/${ID}.jsonl`)
    expect(getKeptCodexConversation(SID)).toEqual({ uuid: ID, cwd: `/conversations/${ID}` })
  })

  it('the persisted conversation wins over the one the tab kept', () => {
    start()
    claim(ID2, '/p/two')
    killPty(SID)
    start({ resume: { uuid: ID, cwd: '/p/demo' } })
    expect(h.built[1].resume).toEqual({ uuid: ID, cwd: '/p/demo' })
  })

  it('the builder is handed the configured directory to fall back on', () => {
    start({ resume: { uuid: ID, cwd: '/p/demo' } })
    expect(h.built[0].cwd).toBe(path.resolve(os.tmpdir()))
  })
})

describe('Restart resumes the conversation the tab is on (row 35)', () => {
  it('the conversation the status line claimed is kept across the Restart\'s kill and resumed', () => {
    start()
    expect(h.built[0].resume).toBeUndefined()
    claim(ID, '/p/demo')
    expect(getKeptCodexConversation(SID)).toEqual({ uuid: ID, cwd: '/p/demo' })
    killPty(SID)
    start()
    expect(h.built[1].resume).toEqual({ uuid: ID, cwd: '/p/demo' })
    expect(lastTelemetry().resumeId).toBe(ID)
  })

  it('"Restart and pick a conversation" still opens the picker: the kept one is not forced on it, and is let go', () => {
    start()
    claim(ID, '/p/demo')
    killPty(SID)
    start({ useResumePicker: true })
    expect(h.built[1].resume).toBeUndefined()
    expect(h.built[1].useResumePicker).toBe(true)
    expect(lastTelemetry().pickFile).toBe('/tmp/ccc-codex-pick-x.json')
    // Fix round 3: with the identity of the folder the builder made.
    expect(lastTelemetry().pickFolder).toEqual({ id: '7:9', real: '/tmp' })
    expect(getKeptCodexConversation(SID)).toBeUndefined()
  })

  it('a start that resumes nothing lets the kept conversation go; the next claim is kept instead', () => {
    start()
    claim(ID, '/p/demo')
    h.missing.add(ID)
    killPty(SID)
    start()
    expect(h.built[1].resume).toEqual({ uuid: ID, cwd: '/p/demo' })
    expect(getKeptCodexConversation(SID)).toBeUndefined()
    claim(ID2, '/p/two')
    expect(getKeptCodexConversation(SID)).toEqual({ uuid: ID2, cwd: '/p/two' })
  })

  it('only a conversation id is kept', () => {
    start()
    claim('--resume', '/p/demo')
    expect(getKeptCodexConversation(SID)).toBeUndefined()
  })

  it('the kept conversations are bounded: the oldest tab\'s goes first', () => {
    const ids = Array.from({ length: KEPT_CODEX_CONVERSATIONS_MAX + 1 }, (_, i) => `cb${String(i).padStart(22, '0')}`)
    for (const sid of ids) {
      start({}, sid)
      claim(ID, '/p/demo')
      killPty(sid)
    }
    expect(getKeptCodexConversation(ids[0])).toBeUndefined()
    expect(getKeptCodexConversation(ids[1])).toEqual({ uuid: ID, cwd: '/p/demo' })
    expect(getKeptCodexConversation(ids[ids.length - 1])).toEqual({ uuid: ID, cwd: '/p/demo' })
  })
})

// P3.5 fix round 1: what a resumed Codex session may reach (thesis 8) and
// what it says (thesis 6).
describe('a resumed Codex session', () => {
  it('registers its configured folder as its review root, never the folder the resumed conversation names (thesis 8)', () => {
    start({ resume: { uuid: ID, cwd: '/p/demo' } })
    expect(h.ptys[0].cwd).toBe(`/conversations/${ID}`)
    expect(h.reviewRoots).toEqual([{ sid: SID, cwd: path.resolve(os.tmpdir()) }])
  })

  it('says in the app log when it resumes in the configured folder because no rollout records the kept one (thesis 6)', () => {
    h.mismatched.add(ID)
    start({ resume: { uuid: ID, cwd: '/p/demo' } })
    expect(h.warnings.some((w) => w.includes('no rollout of') && w.includes(ID))).toBe(true)
    h.warnings = []
    h.mismatched.clear()
    start({ resume: { uuid: ID2, cwd: '/p/two' } }, `${SID}x`)
    expect(h.warnings.some((w) => w.includes('no rollout of'))).toBe(false)
  })
})

// P3.5 fix round 2 (quality minor 2): when the picker decides again after a
// claim, the watcher lets the claim go, and the session no longer keeps it.
describe('a claim let go', () => {
  it('drops the kept conversation, so a Restart does not resume it; the next claim is kept', () => {
    start({ useResumePicker: true })
    claim(ID, '/p/demo')
    expect(getKeptCodexConversation(SID)).toEqual({ uuid: ID, cwd: '/p/demo' })
    ;(lastTelemetry().onRelease as () => void)()
    expect(getKeptCodexConversation(SID)).toBeUndefined()
    claim(ID2, '/p/two')
    expect(getKeptCodexConversation(SID)).toEqual({ uuid: ID2, cwd: '/p/two' })
  })
})

// P3.6 (row 22): a Switch account carries the conversation from the account
// the session ran under. Main records that account with the conversation it
// keeps -- the account of the launch that resumed it or whose status line
// claimed it -- so the carry's source is main's own record, never a name the
// renderer sends. session:save still persists only the conversation.
describe('the kept conversation records the account it ran under (P3.6)', () => {
  const on = (accountId: string | undefined) => ({ ...(launch() as object), lease: { release: vi.fn(), ...(accountId ? { accountId } : {}) } }) as unknown as SpawnOpts['codexLaunch']

  it('a resumed conversation is kept with the account its launch holds; what is saved stays the conversation alone', () => {
    start({ resume: { uuid: ID, cwd: '/p/demo' }, codexLaunch: on('acct-a') })
    expect(getKeptCodexConversationSource(SID)).toEqual({ uuid: ID, cwd: `/conversations/${ID}`, accountId: 'acct-a', uncertain: false })
    expect(getKeptCodexConversation(SID)).toEqual({ uuid: ID, cwd: `/conversations/${ID}` })
  })

  it('a claimed conversation takes the launch\'s account, and a later launch that resumes it on another account records that one', () => {
    start({ codexLaunch: on('acct-a') })
    claim(ID, '/p/demo')
    expect(getKeptCodexConversationSource(SID)).toEqual({ uuid: ID, cwd: '/p/demo', accountId: 'acct-a', uncertain: false })
    killPty(SID)
    start({ codexLaunch: on('acct-b') })
    expect(getKeptCodexConversationSource(SID)).toEqual({ uuid: ID, cwd: `/conversations/${ID}`, accountId: 'acct-b', uncertain: false })
  })

  it('nothing to carry without both: no conversation, or a launch that names no account', () => {
    start({ codexLaunch: on('acct-a') })
    expect(getKeptCodexConversationSource(SID)).toBeUndefined()
    start({ codexLaunch: on(undefined) }, `${SID}y`)
    claim(ID, '/p/demo')
    expect(getKeptCodexConversation(`${SID}y`)).toEqual({ uuid: ID, cwd: '/p/demo' })
    expect(getKeptCodexConversationSource(`${SID}y`)).toBeUndefined()
  })
})
