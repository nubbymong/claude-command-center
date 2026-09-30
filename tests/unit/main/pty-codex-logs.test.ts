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
  claimAtStart: null as null | { path: string; sessionsDir: string; exact: boolean; shared: boolean; identity?: string },
  settings: {} as { loggingEnabled?: boolean; loggingConsentSeen?: boolean; loggingConsentVersion?: number },
  configs: [] as unknown[],
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
  readConfig: (name: string) => (name === 'settings' ? h.settings : name === 'configs' ? h.configs : {}),
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

const { spawnPty, killPty, codexRolloutForSessionContext, CODEX_CONTEXT_ROLLOUTS_MAX, applyLoggingSwitches } = await import('../../../src/main/pty-manager')
const { getCodexLogBinder } = await import('../../../src/main/logging/codex-log-binder')
const { notIndexedSnapshot, conversationKey, resetIndexingGapsForTests } = await import('../../../src/main/logging/indexing-gaps')
/** A conversation's not-indexed windows (as main keeps them). */
const windowsOf = (id: string) => notIndexedSnapshot().conversations[conversationKey(rolloutOfId(id))] ?? []
const rolloutOfId = (id: string) => `/res/codex-realms/a/sessions/2026/09/29/rollout-2026-09-29T10-00-00-${id}.jsonl`
// P3.12 round 2 (W9): a Codex run is recorded once the notice naming Codex's indexing was seen.
const CONSENT = { loggingConsentSeen: true, loggingConsentVersion: 2 }
const { makeCodexLogBinder, setCodexLogBinder } = await import('../../../src/main/logging/codex-log-binder')

const SID = 'cx0000000000000000000011'
const CLAUDE_SID = 'cl0000000000000000000011'
// A session only the GitHub context test uses: the rollout it holds is kept after its process ends.
const CTX = 'cx0000000000000000000012'
const ID_A = '019dd000-0001-7000-8000-00000000000a'
const ID_B = '019dd000-0001-7000-8000-00000000000b'
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const SESSIONS = '/res/codex-realms/a/sessions'
function launch(realm = 'a') {
  return {
    lease: { release: vi.fn(), accountId: `acct-${realm}` },
    executable: `/proven/${realm}/codex`,
    env: { PATH: '/usr/bin', CODEX_HOME: `/res/codex-realms/${realm}` },
    sessionsDir: `/res/codex-realms/${realm}/sessions`,
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
  h.ptys = []; h.built = []; h.sources = []; h.claimAtStart = null; h.settings = { ...CONSENT }; h.configs = []; h.sup = []; h.claudeBinder = []
  names.clear(); written.length = 0
  resetIndexingGapsForTests()
  setCodexLogBinder(makeCodexLogBinder({
    supervisor: {
      bindTranscript: (...a: unknown[]) => { h.sup.push(['bind', ...a]) },
      unbindTranscript: (...a: unknown[]) => { h.sup.push(['unbind', ...a]) },
    },
    writeName: (p, d, n) => { written.push([p, d, n]) },
    rememberedName: (sid) => names.get(sid) ?? null,
    forgetName: (sid) => { names.delete(sid) },
    // As main's logging service wires it (logging-switch-wiring.test.ts).
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

  it('logging off for the config, or in Settings: no run, nothing bound (round 1: only the end of any run the session id had)', () => {
    h.claimAtStart = report(ID_A, true)
    start(SID, { loggingEnabled: false })
    expect(kinds()).toEqual(['runEnd'])
    h.settings = { loggingEnabled: false }
    start(SID)
    expect(kinds()).toEqual(['runEnd', 'runEnd'])
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

describe('P3.12 round 1: the logging switches stop indexing running sessions (V1), both assistants', () => {
  const ends = () => h.sup.filter((c) => c[0] === 'runEnd').map((c) => [c[1], c[3]])

  it('the Settings switch turned off: every indexed running session\'s run ends (Codex and Claude); a later Codex claim binds nothing', () => {
    start(SID)
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir(), provider: 'claude' } as never)
    h.settings = { loggingEnabled: false }
    applyLoggingSwitches()
    expect(ends()).toEqual([[SID, 'stopped'], [CLAUDE_SID, 'stopped']])
    ;(source(SID).opts.onRollout as (r: unknown) => void)(report(ID_A, true))
    expect(kinds().filter((k) => k === 'bind')).toEqual([])
    // Nothing more to stop.
    applyLoggingSwitches()
    expect(ends()).toHaveLength(2)
  })

  it('a config\'s own switch turned off: only that config\'s running session stops, by its provider\'s field', () => {
    start(SID)
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir(), provider: 'claude', configId: 'cfg-cl' } as never)
    // The Claude field on the Codex config is not the Codex switch; the Claude config is untouched.
    h.configs = [{ id: 'cfg-cx', provider: 'codex', claudeOptions: { loggingEnabled: true }, codexOptions: { permissionsPreset: 'read-only', loggingEnabled: false } }, { id: 'cfg-cl', provider: 'claude', codexOptions: { loggingEnabled: false } }]
    applyLoggingSwitches()
    expect(ends()).toEqual([[SID, 'stopped']])
  })

  it('a session relaunched while logging is off records nothing, and its earlier run is ended (no longer added to)', () => {
    start(SID)
    h.settings = { loggingEnabled: false }
    start(SID)
    expect(kinds()).toEqual(['runStart', 'runEnd'])
    expect(h.sup.at(-1)).toEqual(['runEnd', SID, expect.any(Number), 'exited'])
  })
})

describe('P3.12 round 1: Switch Account and the Session Context (B2); a tab moved to Claude (Q1)', () => {
  it('a launch on another account drops the rollout recorded for the Session Context; one on the same account keeps it until its claim', () => {
    start(CTX)
    ;(source(CTX).opts.onRollout as (r: unknown) => void)(report(ID_A, true))
    start(CTX, { codexLaunch: launch('a') })
    expect(codexRolloutForSessionContext(CTX)).toEqual({ path: rolloutOf(ID_A), sessionsDir: SESSIONS })
    start(CTX, { codexLaunch: launch('b') })
    expect(codexRolloutForSessionContext(CTX)).toBeNull()
  })

  it('a Codex tab respawned as a Claude one leaves nothing of its Codex claim behind (a rename cannot reach the old rollout)', () => {
    start(SID)
    ;(source(SID).opts.onRollout as (r: unknown) => void)(report(ID_A, true))
    expect(getCodexLogBinder()!.exactRollout(SID)).not.toBeNull()
    spawnPty(fakeWin, SID, { cwd: os.tmpdir(), provider: 'claude' } as never)
    expect(getCodexLogBinder()!.knows(SID)).toBe(false)
    expect(getCodexLogBinder()!.exactRollout(SID)).toBeNull()
  })
})

describe('P3.12 round 2: the switches at every launch (W3), the stretches not indexed (W4), the notice (W9)', () => {
  const kindsOf = (sid: string) => h.sup
    .filter((c) => c[1] === sid || (c[0] === 'runStart' && (c[1] as { sessionId?: string })?.sessionId === sid))
    .map((c) => c[0] === 'runEnd' ? `runEnd:${c[3]}` : c[0])

  it('W3 (Codex): a config switched off stays off when its tab is launched again with the value it was launched with; switched on again, the next launch is indexed', () => {
    start(SID)
    h.configs = [{ id: 'cfg-cx', provider: 'codex', codexOptions: { permissionsPreset: 'read-only', loggingEnabled: false } }]
    applyLoggingSwitches()
    h.claimAtStart = report(ID_A, true)
    start(SID)
    expect(kindsOf(SID)).toEqual(['runStart', 'runEnd:stopped', 'runEnd:exited'])
    h.configs = [{ id: 'cfg-cx', provider: 'codex', codexOptions: { permissionsPreset: 'read-only', loggingEnabled: true } }]
    start(SID, { loggingEnabled: false })
    expect(kindsOf(SID).slice(3)).toEqual(['runStart', 'bind'])
  })

  it('W3 (Claude): the same', () => {
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir(), provider: 'claude', configId: 'cfg-cl' } as never)
    h.configs = [{ id: 'cfg-cl', provider: 'claude', claudeOptions: { loggingEnabled: false } }]
    applyLoggingSwitches()
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir(), provider: 'claude', configId: 'cfg-cl' } as never)
    expect(kindsOf(CLAUDE_SID)).toEqual(['runStart', 'runEnd:stopped', 'runEnd:exited'])
  })

  it('Y1: a Codex session not indexed opens a window on the conversation it holds (at a switch-off, and at each claim), closing the one before; an indexed one opens none', () => {
    const before = Date.now()
    start(SID)
    ;(source(SID).opts.onRollout as (r: unknown) => void)({ ...report(ID_A, true), identity: '7:1' })
    expect(windowsOf(ID_A)).toEqual([])
    h.settings = { ...CONSENT, loggingEnabled: false }
    applyLoggingSwitches()
    expect(windowsOf(ID_A)).toEqual([[expect.any(Number), null]])
    expect(windowsOf(ID_A)[0][0]).toBeGreaterThanOrEqual(before)
    ;(source(SID).opts.onRollout as (r: unknown) => void)({ ...report(ID_B, true), identity: '7:2' })
    expect(windowsOf(ID_A)[0][1]).toEqual(expect.any(Number))
    expect(windowsOf(ID_B)).toEqual([[expect.any(Number), null]])
    ;(source(SID).opts.onRollout as (r: unknown) => void)(null)
    expect(windowsOf(ID_B)[0][1]).toEqual(expect.any(Number))
  })

  it('Y1: a launch not indexed opens a window on what it holds; its end (exit, or a Restart) closes it; windows stay (nothing clears them)', () => {
    h.settings = { ...CONSENT, loggingEnabled: false }
    start(CTX)
    ;(source(CTX).opts.onRollout as (r: unknown) => void)({ ...report(ID_A, true), identity: '7:1' })
    expect(windowsOf(ID_A)).toEqual([[expect.any(Number), null]])
    exitAll()
    expect(windowsOf(ID_A)).toEqual([[expect.any(Number), expect.any(Number)]])
    h.settings = { ...CONSENT }
    start(SID)
    ;(source(SID).opts.onRollout as (r: unknown) => void)({ ...report(ID_A, true), identity: '7:1' })
    expect(h.sup.filter((c) => c[0] === 'bind').at(-1)).toEqual(['bind', SID, rolloutOf(ID_A), 'exact', undefined, 'codex-rollout', '7:1'])
    expect(windowsOf(ID_A)).toHaveLength(1)
  })

  it('Y1: a launch indexed after one that was not closes the earlier window; its claim at the start opens none', () => {
    const FRESH = 'cx0000000000000000000013'
    h.settings = { ...CONSENT, loggingEnabled: false }
    h.claimAtStart = { ...report(ID_A, true), identity: '7:1' }
    start(FRESH)
    ;(source(FRESH).opts.onRollout as (r: unknown) => void)({ ...report(ID_A, true), identity: '7:1' })
    expect(windowsOf(ID_A)).toEqual([[expect.any(Number), null]])
    h.settings = { ...CONSENT }
    h.claimAtStart = { ...report(ID_B, true), identity: '7:2' }
    start(FRESH)
    expect(windowsOf(ID_A)).toEqual([[expect.any(Number), expect.any(Number)]])
    expect(windowsOf(ID_B)).toEqual([])
    try { killPty(FRESH) } catch { /* gone */ }
  })

  it('X3: a Codex tab relaunched as a Claude one with logging off opens no window on the Codex conversation it was on', () => {
    start(SID)
    ;(source(SID).opts.onRollout as (r: unknown) => void)({ ...report(ID_A, true), identity: '7:1' })
    h.settings = { ...CONSENT, loggingEnabled: false }
    spawnPty(fakeWin, SID, { cwd: os.tmpdir(), provider: 'claude' } as never)
    expect(windowsOf(ID_A)).toEqual([])
  })

  it('X3: a Claude session not indexed, and a shell, open no window', () => {
    h.settings = { ...CONSENT, loggingEnabled: false }
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir(), provider: 'claude' } as never)
    spawnPty(fakeWin, 'shell-only-1', { cwd: os.tmpdir(), shellOnly: true } as never)
    expect(Object.keys(notIndexedSnapshot().conversations)).toEqual([])
  })

  it('W9: a Codex session is indexed only once the notice naming Codex\'s indexing was seen; a Claude session keeps its rule', () => {
    h.settings = { loggingConsentSeen: true }
    start(SID)
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir(), provider: 'claude' } as never)
    expect(kindsOf(SID).filter((k) => k === 'runStart')).toEqual([])
    expect(kindsOf(CLAUDE_SID).filter((k) => k === 'runStart')).toEqual(['runStart'])
  })
})
