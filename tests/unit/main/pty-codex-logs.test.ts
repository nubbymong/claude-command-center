// P3.12 (rows 31, 32, 65): what pty-manager does with a local Codex session's
// logs and GitHub Session Context. A local Codex launch records a run, as a
// local Claude launch does (same gates: per-config and global logging, not a
// shell, not the Ask pane); Claude's own transcript discovery (its heuristic
// scan of ~/.claude/projects, its resume-bind) is never armed for it. The run's
// transcript is the rollout the session's own watcher claims (onRollout),
// handed to the Codex log binder: held until the run is recorded, bound with the
// Codex format, let go when the claim is. The run ends at exit. The GitHub
// Session Context reads the rollout the session's watcher holds.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

interface FakePty { cmd: string; exit: Array<(e: { exitCode: number }) => void>; kill: ReturnType<typeof vi.fn> }
interface FakeSource { sid: string; opts: Record<string, any>; stop: ReturnType<typeof vi.fn>; noteExactRollout: ReturnType<typeof vi.fn>; refuteInferredClaim: ReturnType<typeof vi.fn> }
const TOKEN = '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60'
const h = vi.hoisted(() => ({
  ptys: [] as Array<{ cmd: string; exit: Array<(e: { exitCode: number }) => void>; kill: (...a: unknown[]) => unknown }>,
  built: [] as Array<Record<string, unknown>>,
  sources: [] as Array<{ sid: string; opts: Record<string, any>; stop: (...a: unknown[]) => unknown; noteExactRollout: (...a: unknown[]) => unknown; refuteInferredClaim: (...a: unknown[]) => unknown }>,
  // The watcher's report made at once, inside ingestSessionTelemetry (a resume
  // claims synchronously), before pty-manager records the run.
  claimAtStart: null as null | { path: string; sessionsDir: string; exact: boolean; shared: boolean },
  settings: {} as { loggingEnabled?: boolean },
  // What reached the log supervisor and Claude's binder, in order.
  sup: [] as unknown[][],
  claudeBinder: [] as unknown[][],
}))

vi.mock('node-pty', () => ({
  spawn: (cmd: string) => {
    const p = { cmd, exit: [] as Array<(e: { exitCode: number }) => void>, kill: vi.fn() }
    h.ptys.push(p)
    return {
      pid: 5000 + h.ptys.length,
      process: cmd,
      onData: () => ({ dispose: () => {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => { p.exit.push(cb); return { dispose: () => {} } },
      write: () => {},
      resize: () => {},
      kill: p.kill,
    }
  },
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
vi.mock('../../../src/main/logging/logging-service', () => ({
  getLogSupervisor: () => ({
    runStart: (meta: unknown) => { h.sup.push(['runStart', meta]) },
    runEnd: (...a: unknown[]) => { h.sup.push(['runEnd', ...a]) },
  }),
  getTranscriptBinder: () => ({
    registerRun: (...a: unknown[]) => { h.claudeBinder.push(['registerRun', ...a]) },
    notifyTranscriptPath: (...a: unknown[]) => { h.claudeBinder.push(['notify', ...a]) },
    endRun: (...a: unknown[]) => { h.claudeBinder.push(['endRun', ...a]) },
    getExactResumeTarget: () => null,
    getLatestTranscriptPath: () => null,
  }),
}))
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
      if (opts.provider !== 'codex') return { cmd: 'pwsh', args: [], env: {} }
      h.built.push(opts)
      return { cmd: opts.realmLaunch.executable, args: [], env: { ...opts.realmLaunch.env }, hooksInstalled: false, ...(opts.resume ? { resumeId: opts.resume.uuid } : {}) }
    },
    ingestSessionTelemetry: (sid: string, opts: Record<string, any>) => {
      const src = { sid, opts, stop: vi.fn(), noteExactRollout: vi.fn(() => null), refuteInferredClaim: vi.fn(() => false) }
      h.sources.push(src)
      if (h.claimAtStart) opts.onRollout?.(h.claimAtStart)
      return src
    },
  }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({
  getGateway: () => ({
    status: () => ({ enabled: false, listening: false, port: null }),
    registerSession: () => TOKEN,
    unregisterSession: () => {},
  }),
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
  readConfig: (name: string) => (name === 'settings' ? h.settings : {}),
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

const { spawnPty, killPty, codexRolloutForSessionContext, CODEX_CONTEXT_ROLLOUTS_MAX } = await import('../../../src/main/pty-manager')
const { makeCodexLogBinder, setCodexLogBinder } = await import('../../../src/main/logging/codex-log-binder')

const SID = 'cx0000000000000000000011'
const CLAUDE_SID = 'cl0000000000000000000011'
// A session only the GitHub context test uses: the rollout it holds is kept after its process ends.
const CTX = 'cx0000000000000000000012'
const ID_A = '019dd000-0001-7000-8000-00000000000a'
const ID_B = '019dd000-0001-7000-8000-00000000000b'
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const SESSIONS = '/res/codex-realms/a/sessions'
function launch() {
  return {
    lease: { release: vi.fn(), accountId: 'acct-a' },
    executable: '/proven/a/codex',
    env: { PATH: '/usr/bin', CODEX_HOME: '/res/codex-realms/a' },
    sessionsDir: SESSIONS,
  } as never
}
const start = (sid: string, extra: Record<string, unknown> = {}) =>
  spawnPty(fakeWin, sid, { cwd: os.tmpdir(), provider: 'codex', configId: 'cfg-cx', configLabel: 'Codex cfg', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: launch(), ...extra } as never)
const source = (sid: string) => [...h.sources].reverse().find((s) => s.sid === sid)!
const exitAll = () => { for (const p of h.ptys) for (const cb of [...p.exit]) cb({ exitCode: 0 }) }
const rolloutOf = (id: string) => `${SESSIONS}/2026/09/29/rollout-2026-09-29T10-00-00-${id}.jsonl`
const report = (id: string, exact: boolean, shared = false) => ({ path: rolloutOf(id), sessionsDir: SESSIONS, exact, shared })
const names = new Map<string, string>()
const written: string[][] = []

beforeEach(() => {
  for (const sid of [SID, CLAUDE_SID, CTX]) { try { killPty(sid) } catch { /* none */ } }
  exitAll()
  h.ptys = []; h.built = []; h.sources = []; h.claimAtStart = null; h.settings = {}; h.sup = []; h.claudeBinder = []
  names.clear(); written.length = 0
  setCodexLogBinder(makeCodexLogBinder({
    supervisor: {
      bindTranscript: (...a: unknown[]) => { h.sup.push(['bind', ...a]) },
      unbindTranscript: (...a: unknown[]) => { h.sup.push(['unbind', ...a]) },
    },
    writeName: (p, d, n) => { written.push([p, d, n]) },
    rememberedName: (sid) => names.get(sid) ?? null,
    forgetName: (sid) => { names.delete(sid) },
  }))
})

const kinds = () => h.sup.map((c) => c[0])

describe('a local Codex session\'s logs (P3.12, row 31)', () => {
  it('records a run with its provider and folder; Claude\'s transcript discovery is never armed for it', () => {
    start(SID)
    expect(h.sup[0]).toEqual(['runStart', expect.objectContaining({ sessionId: SID, provider: 'codex', configId: 'cfg-cx', configLabel: 'Codex cfg', projectCwd: os.tmpdir() })])
    expect(h.claudeBinder.filter((c) => c[0] !== 'endRun')).toEqual([])
  })

  it('a claim the watcher reports at once (a resume) is bound after the run is recorded, with the Codex format', () => {
    h.claimAtStart = report(ID_A, true)
    start(SID)
    expect(h.sup).toEqual([
      ['runStart', expect.objectContaining({ sessionId: SID, provider: 'codex' })],
      ['bind', SID, rolloutOf(ID_A), 'exact', undefined, 'codex-rollout'],
    ])
  })

  it('a later claim binds (heuristic when inferred); the hook confirming it re-binds exact; a claim let go is unbound; a claim another tab holds is not indexed', () => {
    start(SID)
    const onRollout = source(SID).opts.onRollout as (r: unknown) => void
    onRollout(report(ID_A, false))
    onRollout(report(ID_A, true))
    onRollout(null)
    onRollout(report(ID_B, true, true))
    expect(h.sup.slice(1)).toEqual([
      ['bind', SID, rolloutOf(ID_A), 'heuristic', undefined, 'codex-rollout'],
      ['bind', SID, rolloutOf(ID_A), 'exact', undefined, 'codex-rollout'],
      ['unbind', SID, rolloutOf(ID_A)],
    ])
  })

  it('the run ends when the process does; a late report from its watcher binds nothing', () => {
    start(SID)
    const onRollout = source(SID).opts.onRollout as (r: unknown) => void
    exitAll()
    expect(h.sup.at(-1)).toEqual(['runEnd', SID, expect.any(Number), 'exited'])
    onRollout(report(ID_A, true))
    expect(kinds().filter((k) => k === 'bind')).toEqual([])
  })

  it('a Restart records the new run before binding the claim the new launch makes (never into the old run)', () => {
    start(SID)
    ;(source(SID).opts.onRollout as (r: unknown) => void)(report(ID_A, true))
    h.claimAtStart = report(ID_A, true)
    start(SID)
    expect(kinds()).toEqual(['runStart', 'bind', 'runStart', 'bind'])
  })

  it('logging off for the config, or in Settings: no run, nothing bound', () => {
    h.claimAtStart = report(ID_A, true)
    start(SID, { loggingEnabled: false })
    expect(h.sup).toEqual([])
    h.settings = { loggingEnabled: false }
    start(SID)
    expect(h.sup).toEqual([])
  })

  it('the name file (row 32): a name remembered for the session is written at its exact claim, even with logging off for it', () => {
    names.set(SID, 'Auth work')
    start(SID, { loggingEnabled: false })
    ;(source(SID).opts.onRollout as (r: unknown) => void)(report(ID_A, true))
    expect(written).toEqual([[rolloutOf(ID_A), SESSIONS, 'Auth work']])
  })

  it('a local Claude session is unchanged: its run, and Claude\'s own transcript discovery', () => {
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir(), provider: 'claude' } as never)
    expect(h.sup[0]).toEqual(['runStart', expect.objectContaining({ sessionId: CLAUDE_SID, provider: 'claude' })])
    expect(h.claudeBinder[0]).toEqual(['registerRun', CLAUDE_SID, os.tmpdir(), expect.any(Number)])
  })
})

describe('a Codex session\'s GitHub Session Context reads its own rollout (P3.12, row 65)', () => {
  it('the rollout the watcher holds (claimed or shared), nothing once let go, kept after the process ends; null for any other session', () => {
    start(CTX)
    const onRollout = source(CTX).opts.onRollout as (r: unknown) => void
    expect(codexRolloutForSessionContext(CTX)).toBeNull()
    onRollout(report(ID_A, false))
    expect(codexRolloutForSessionContext(CTX)).toEqual({ path: rolloutOf(ID_A), sessionsDir: SESSIONS })
    onRollout(report(ID_B, true, true))
    expect(codexRolloutForSessionContext(CTX)).toEqual({ path: rolloutOf(ID_B), sessionsDir: SESSIONS })
    exitAll()
    expect(codexRolloutForSessionContext(CTX)).toEqual({ path: rolloutOf(ID_B), sessionsDir: SESSIONS })
    start(CTX)
    ;(source(CTX).opts.onRollout as (r: unknown) => void)(null)
    expect(codexRolloutForSessionContext(CTX)).toBeNull()
    expect(codexRolloutForSessionContext(CLAUDE_SID)).toBeNull()
  })
})

describe('the GitHub Session Context record stays bounded (P3.12)', () => {
  it('keeps the rollouts of at most CODEX_CONTEXT_ROLLOUTS_MAX sessions, the oldest let go first', () => {
    const ids = Array.from({ length: CODEX_CONTEXT_ROLLOUTS_MAX + 1 }, (_, i) => `cxcap${String(i).padStart(19, '0')}`)
    for (const sid of ids) {
      start(sid)
      ;(source(sid).opts.onRollout as (r: unknown) => void)(report(ID_A, true))
    }
    expect(codexRolloutForSessionContext(ids[0])).toBeNull()
    expect(codexRolloutForSessionContext(ids.at(-1)!)).toEqual({ path: rolloutOf(ID_A), sessionsDir: SESSIONS })
    for (const sid of ids) { try { killPty(sid) } catch { /* gone */ } }
  })
})
