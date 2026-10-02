// P3.12 (rows 31, 32, 65): what pty-manager does with a local Codex session's
// logs and GitHub Session Context. A local Codex launch records a run, as a
// local Claude launch does (same gates: per-config and global logging, not a
// shell, not the Ask pane); Claude's own transcript discovery (its heuristic
// scan of ~/.claude/projects, its resume-bind) is never armed for it. The run's
// transcript is the rollout the session's own watcher claims (onRollout),
// handed to the Codex log binder: held until the run is recorded, bound with the
// Codex format, let go when the claim is. The run ends at exit. The GitHub
// Session Context reads the rollout the session's watcher holds.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as os from 'os'
import * as fs from 'fs'
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
  // Run inside ingestSessionTelemetry, before that claim: time passing during a launch.
  duringStart: null as null | (() => void),
  settings: {} as { loggingEnabled?: boolean; loggingConsentSeen?: boolean; loggingConsentVersion?: number },
  configs: [] as unknown[],
  // What reached the log supervisor and Claude's binder, in order.
  sup: [] as unknown[][],
  claudeBinder: [] as unknown[][],
  // P3.16 round 1 (N3): no log service this run.
  supNull: false,
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
  getLogSupervisor: () => (h.supNull ? null : {
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
      h.duringStart?.()
      if (h.claimAtStart) opts.onRollout?.(h.claimAtStart)
      return src
    },
  }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
// P3.16 (M1): an exact Claude resume the launch applies, when a test sets one;
// otherwise the real resolution.
const resumeAs = vi.hoisted(() => ({ next: null as null | { resumeUuid: string; claudeCwd: string } }))
vi.mock('../../../src/main/spawn-claude-command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/spawn-claude-command')>()
  return { ...actual, resolveResumeLaunch: (...a: Parameters<typeof actual.resolveResumeLaunch>) => resumeAs.next ?? actual.resolveResumeLaunch(...a) }
})
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

const { spawnPty, killPty, codexRolloutForSessionContext, CODEX_CONTEXT_ROLLOUTS_MAX, CODEX_LEASE_EXIT_GRACE_MS, applyLoggingSwitches, routeHookTranscriptPath, CLAUDE_TRANSCRIPTS_MAX } = await import('../../../src/main/pty-manager')
const { getCodexLogBinder } = await import('../../../src/main/logging/codex-log-binder')
const { claudeFolderKey, claudeProjectsRootKey } = await import('../../../src/main/logging/claude-folder-key')
const { mangleCwdToProjectDir } = await import('../../../src/shared/project-key')
const { notIndexedSnapshot, conversationKey, resetIndexingGapsForTests, flushIndexingGaps, initIndexingGaps, indexingGapsWritesForTests, HELD_WINDOWS_PER_SESSION_MAX, keepNotIndexedWindow, setNotIndexedConversationsMaxForTests } = await import('../../../src/main/logging/indexing-gaps')
const { codexFolderKey, codexRolloutSessionsDir } = await import('../../../src/main/logging/codex-folder-key')
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
  h.ptys = []; h.built = []; h.sources = []; h.claimAtStart = null; h.duringStart = null; h.settings = { ...CONSENT }; h.configs = []; h.sup = []; h.claudeBinder = []
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

  // P3.15 round 2 (J1): under node-pty's bundled ConPTY a Codex that quits by
  // itself can end before its exit code is known; that is a normal end.
  it('an exit with no known code ends the run as exited; a known non-zero code as crashed', () => {
    start(SID)
    for (const p of h.ptys) for (const cb of [...p.exit]) cb({ exitCode: undefined as unknown as number })
    expect(h.sup.at(-1)).toEqual(['runEnd', SID, expect.any(Number), 'exited'])
    start(SID)
    const second = h.ptys[h.ptys.length - 1]
    for (const cb of [...second.exit]) cb({ exitCode: 1 })
    expect(h.sup.at(-1)).toEqual(['runEnd', SID, expect.any(Number), 'crashed'])
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

  it('Y1: a launch indexed after one that was not closes the earlier window once the old process has ended; its claim at the start opens none', () => {
    const FRESH = 'cx0000000000000000000013'
    h.settings = { ...CONSENT, loggingEnabled: false }
    h.claimAtStart = { ...report(ID_A, true), identity: '7:1' }
    start(FRESH)
    const old = h.ptys.at(-1)!
    ;(source(FRESH).opts.onRollout as (r: unknown) => void)({ ...report(ID_A, true), identity: '7:1' })
    expect(windowsOf(ID_A)).toEqual([[expect.any(Number), null]])
    h.settings = { ...CONSENT }
    h.claimAtStart = { ...report(ID_B, true), identity: '7:2' }
    start(FRESH)
    // Round 7 (K1): the old process is still winding down: the window stays open until its exit is reported.
    expect(windowsOf(ID_A)).toEqual([[expect.any(Number), null]])
    for (const cb of [...old.exit]) cb({ exitCode: 0 })
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

  it('X3: a Claude session not indexed marks only its own projects folder (P3.16 round 1, N1); a shell marks nothing', () => {
    h.settings = { ...CONSENT, loggingEnabled: false }
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir(), provider: 'claude' } as never)
    spawnPty(fakeWin, 'shell-only-1', { cwd: os.tmpdir(), shellOnly: true } as never)
    expect(Object.keys(notIndexedSnapshot().conversations)).toEqual([claudeFolderKey(path.join(os.homedir(), '.claude', 'projects', mangleCwdToProjectDir(process.platform === 'win32' ? os.tmpdir() : fs.realpathSync(os.tmpdir()))))])
  })

  it('W9: a Codex session is indexed only once the notice naming Codex\'s indexing was seen; a Claude session keeps its rule', () => {
    h.settings = { loggingConsentSeen: true }
    start(SID)
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir(), provider: 'claude' } as never)
    expect(kindsOf(SID).filter((k) => k === 'runStart')).toEqual([])
    expect(kindsOf(CLAUDE_SID).filter((k) => k === 'runStart')).toEqual(['runStart'])
  })
})

describe('P3.12 round 6 (Z1): a window opens when the session became not indexed, not at its claim', () => {
  // Codex writes a conversation's session_meta and first prompt before the
  // session's watcher claims it, so a window opened at the claim would leave
  // those records outside it for a later reader from the start.
  const T0 = Date.parse('2026-09-30T10:00:00.000Z')
  // One session id per test: the rollout a session held is kept after it ends.
  const used: string[] = []
  let next = 20
  const fresh = () => { const sid = `cx${'0'.repeat(20)}${next++}`; used.push(sid); return sid }
  const clock = (ms: number) => vi.setSystemTime(T0 + ms)
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); clock(0) })
  afterEach(() => { for (const sid of used.splice(0)) { try { killPty(sid) } catch { /* gone */ } } vi.useRealTimers() })

  it('a launch not indexed: the window opens at the launch, though the launch takes time and the claim comes seconds later', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    h.duringStart = () => clock(1500)
    start(S)
    clock(4000)
    ;(source(S).opts.onRollout as (r: unknown) => void)({ ...report(ID_A, true), identity: '7:1' })
    expect(windowsOf(ID_A)).toEqual([[T0, null]])
  })

  it('a resume claimed during the launch: the window opens at the launch, not when the launch finished', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    h.duringStart = () => clock(2500)
    h.claimAtStart = { ...report(ID_A, true), identity: '7:1' }
    start(S)
    expect(windowsOf(ID_A)).toEqual([[T0, null]])
  })

  it('switched off before any claim: the window opens at the switch-off, though the claim comes later', () => {
    const S = fresh()
    start(S)
    clock(3000)
    h.settings = { ...CONSENT, loggingEnabled: false }
    applyLoggingSwitches()
    clock(9000)
    ;(source(S).opts.onRollout as (r: unknown) => void)({ ...report(ID_A, true), identity: '7:1' })
    expect(windowsOf(ID_A)).toEqual([[T0 + 3000, null]])
  })

  it('a later claim of another conversation closes the first at that claim and opens the next at the same moment the session became not indexed', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    start(S)
    clock(1000)
    ;(source(S).opts.onRollout as (r: unknown) => void)({ ...report(ID_A, true), identity: '7:1' })
    clock(7000)
    ;(source(S).opts.onRollout as (r: unknown) => void)({ ...report(ID_B, true), identity: '7:2' })
    expect(windowsOf(ID_A)).toEqual([[T0, T0 + 7000]])
    expect(windowsOf(ID_B)).toEqual([[T0, null]])
  })
})

describe('P3.12 round 7 (K1): a killed session\'s window closes when its process has ended', () => {
  // A killed Codex winds down for seconds and goes on writing (a Switch's copy
  // waits for it), so the window it held is closed when its exit is reported,
  // or after the grace its account lease uses when none is.
  const T0 = Date.parse('2026-09-30T10:00:00.000Z')
  const used: string[] = []
  let next = 40
  const fresh = () => { const sid = `cx${'0'.repeat(20)}${next++}`; used.push(sid); return sid }
  const clock = (ms: number) => vi.setSystemTime(T0 + ms)
  const claimA = (sid: string) => (source(sid).opts.onRollout as (r: unknown) => void)({ ...report(ID_A, true), identity: '7:1' })
  const exitOf = (proc: { exit: Array<(e: { exitCode: number }) => void> }) => { for (const cb of [...proc.exit]) cb({ exitCode: 0 }) }
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); clock(0) })
  afterEach(() => { for (const sid of used.splice(0)) { try { killPty(sid) } catch { /* gone */ } } vi.useRealTimers() })

  it('a tab closed while not indexed: the window stays open through the wind-down and closes when the process\'s exit is reported', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    start(S)
    const proc = h.ptys.at(-1)!
    clock(1000)
    claimA(S)
    clock(2000)
    killPty(S)
    expect(windowsOf(ID_A)).toEqual([[T0, null]])
    clock(5000)
    exitOf(proc)
    expect(windowsOf(ID_A)).toEqual([[T0, T0 + 5000]])
  })

  it('no exit reported: the window closes after the grace the account lease uses, not before', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    start(S)
    claimA(S)
    clock(2000)
    killPty(S)
    vi.advanceTimersByTime(CODEX_LEASE_EXIT_GRACE_MS - 1)
    expect(windowsOf(ID_A)).toEqual([[T0, null]])
    vi.advanceTimersByTime(1)
    expect(windowsOf(ID_A)).toEqual([[T0, T0 + 2000 + CODEX_LEASE_EXIT_GRACE_MS]])
  })

  it('a Restart: the new launch\'s window is its own, and the old process\'s late exit closes only the old one', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    start(S)
    const old = h.ptys.at(-1)!
    clock(1000)
    claimA(S)
    clock(2000)
    start(S)
    expect(windowsOf(ID_A)).toEqual([[T0, null], [T0 + 2000, null]])
    clock(4000)
    exitOf(old)
    expect(windowsOf(ID_A)).toEqual([[T0, T0 + 4000], [T0 + 2000, null]])
  })

  it('a quit during the wind-down leaves the window open (the next start closes it), whatever the process does after', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    start(S)
    const proc = h.ptys.at(-1)!
    claimA(S)
    clock(2000)
    killPty(S)
    flushIndexingGaps()
    clock(5000)
    exitOf(proc)
    vi.advanceTimersByTime(CODEX_LEASE_EXIT_GRACE_MS)
    expect(windowsOf(ID_A)).toEqual([[T0, null]])
  })

  it('a session that was indexed holds no window to close: its kill and exit open and close none', () => {
    const S = fresh()
    start(S)
    const proc = h.ptys.at(-1)!
    claimA(S)
    killPty(S)
    exitOf(proc)
    expect(windowsOf(ID_A)).toEqual([])
  })
})

describe('PR-level ADR-009 round 1 (C1): a Codex session not indexed marks its realm\'s launch folder until it ends', () => {
  // The parity of a Claude session's projects-folder window: the rollouts its
  // own watcher never claims (another tab took one by folder and time, Codex
  // began one inside it with no hook to say so) are left out by the folder of
  // its realm their session_meta records (transcripts worker).
  const T0 = Date.parse('2026-09-30T10:00:00.000Z')
  const used: string[] = []
  let next = 60
  const fresh = () => { const sid = `cx${'0'.repeat(20)}${next++}`; used.push(sid); return sid }
  const clock = (ms: number) => vi.setSystemTime(T0 + ms)
  /** The folder window the session's launch holds: its realm and the folder its watcher matches rollouts by. */
  const folderOf = (sid: string) => {
    const o = source(sid).opts
    return notIndexedSnapshot().conversations[codexFolderKey(o.sessionsDir, o.cwd)] ?? []
  }
  const folderKeys = () => Object.keys(notIndexedSnapshot().conversations).filter((k) => k.startsWith('codex-folder:'))
  const exitOf = (proc: { exit: Array<(e: { exitCode: number }) => void> }) => { for (const cb of [...proc.exit]) cb({ exitCode: 0 }) }
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); clock(0) })
  afterEach(() => { for (const sid of used.splice(0)) { try { killPty(sid) } catch { /* gone */ } } vi.useRealTimers() })

  it('a launch not indexed: the folder is marked from the launch; a claim, another claim and a claim let go leave it open; its own exit closes it', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    h.duringStart = () => clock(1500)
    start(S)
    const proc = h.ptys.at(-1)!
    expect(source(S).opts.sessionsDir).toBe(SESSIONS)
    expect(folderOf(S)).toEqual([[T0, null]])
    clock(3000)
    ;(source(S).opts.onRollout as (r: unknown) => void)({ ...report(ID_A, false), identity: '7:1' })
    clock(4000)
    ;(source(S).opts.onRollout as (r: unknown) => void)({ ...report(ID_B, true), identity: '7:2' })
    clock(5000)
    ;(source(S).opts.onRollout as (r: unknown) => void)(null)
    expect(windowsOf(ID_B)).toEqual([[T0, T0 + 5000]])
    expect(folderOf(S)).toEqual([[T0, null]])
    clock(9000)
    exitOf(proc)
    expect(folderOf(S)).toEqual([[T0, T0 + 9000]])
  })

  it('switched off while running: the folder is marked from the switch-off; an indexed launch marks none', () => {
    const S = fresh()
    start(S)
    expect(folderKeys()).toEqual([])
    clock(3000)
    h.settings = { ...CONSENT, loggingEnabled: false }
    applyLoggingSwitches()
    expect(folderOf(S)).toEqual([[T0 + 3000, null]])
  })

  it('a tab closed: the folder window stays open through the wind-down and closes when the exit is reported; a Restart\'s new launch marks its own', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    start(S)
    const old = h.ptys.at(-1)!
    clock(2000)
    start(S)
    expect(folderOf(S)).toEqual([[T0, null], [T0 + 2000, null]])
    clock(4000)
    exitOf(old)
    expect(folderOf(S)).toEqual([[T0, T0 + 4000], [T0 + 2000, null]])
    const now = h.ptys.at(-1)!
    clock(5000)
    killPty(S)
    expect(folderOf(S)).toEqual([[T0, T0 + 4000], [T0 + 2000, null]])
    clock(6000)
    exitOf(now)
    expect(folderOf(S)).toEqual([[T0, T0 + 4000], [T0 + 2000, T0 + 6000]])
  })

  it('round 2 (K1, lens C G1): a launch folder reached through a link is marked by its real path too (what a session_meta records off Windows), from the launch until the session ends', (ctx) => {
    const PREFIX = 'ccc-test-k1-link-'
    const base = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
    const link = path.join(base, 'via-link')
    try {
      const real = path.join(base, 'real')
      fs.mkdirSync(real)
      // A junction on Windows (no privilege needed), a folder link elsewhere.
      try { fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir') } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err
        ctx.skip()
        return
      }
      const S = fresh()
      h.settings = { ...CONSENT, loggingEnabled: false }
      start(S, { cwd: link })
      expect(source(S).opts.cwd).toBe(link)
      const realPath = fs.realpathSync(link)
      expect(realPath).not.toBe(link)
      // The key the transcripts worker works out for a rollout of this realm whose session_meta records the real path.
      const realKey = codexFolderKey(codexRolloutSessionsDir(rolloutOf(ID_A)), realPath)
      expect(folderOf(S)).toEqual([[T0, null]])
      expect(notIndexedSnapshot().conversations[realKey]).toEqual([[T0, null]])
      clock(9000)
      exitOf(h.ptys.at(-1)!)
      expect(folderOf(S)).toEqual([[T0, T0 + 9000]])
      expect(notIndexedSnapshot().conversations[realKey]).toEqual([[T0, T0 + 9000]])
    } finally {
      // TEST CLEANUP GUARD: the link first (never followed), then only the folder this test made.
      try { if (fs.lstatSync(link).isSymbolicLink()) { try { fs.unlinkSync(link) } catch { fs.rmdirSync(link) } } } catch { /* never made */ }
      if (path.basename(base).startsWith(PREFIX) && path.dirname(base) === os.tmpdir()) fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('PR-level ADR-009 round 1 (C2): past the conversations kept, a Claude session not indexed is covered by its folder', () => {
  it('every conversation open at the cap: a launch not indexed still marks its projects folder (a cover, open until it ends)', () => {
    setNotIndexedConversationsMaxForTests(1)
    keepNotIndexedWindow('someone-else', 'held-open', 1)
    h.settings = { ...CONSENT, loggingEnabled: false }
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir(), provider: 'claude' } as never)
    const folder = claudeFolderKey(path.join(os.homedir(), '.claude', 'projects', mangleCwdToProjectDir(process.platform === 'win32' ? os.tmpdir() : fs.realpathSync(os.tmpdir()))))
    expect(notIndexedSnapshot().conversations[folder]).toEqual([[expect.any(Number), null]])
    expect(notIndexedSnapshot().conversations['held-open']).toEqual([[1, null]])
    try { killPty(CLAUDE_SID) } catch { /* gone */ }
  })
})

describe('P3.16 (M1, round 1): a Claude session not indexed marks what it writes, as a Codex one', () => {
  // A Claude session's conversation is its transcript, named by its hooks and
  // status line (routeHookTranscriptPath), or known at launch from an exact
  // resume, kept by the conversation's id (the transcript's file name). Round 1:
  // only a <uuid>.jsonl directly in the session's own projects folder (N4);
  // every one it names stays marked until the session ends (N2); while it has
  // named none, its whole projects folder is marked (N1); only a run the
  // switches and rules leave out is marked (N3).
  const T0 = Date.parse('2026-09-30T10:00:00.000Z')
  const CL_A = '7f3e0c1a-0000-4000-8000-0000000003a1'
  const CL_B = '7f3e0c1a-0000-4000-8000-0000000003b2'
  // Claude Code names the real path of its launch folder (round 2, Q1): on
  // Linux and macOS the temp folder may be reached through a link.
  const FOLDER = path.join(os.homedir(), '.claude', 'projects', mangleCwdToProjectDir(process.platform === 'win32' ? os.tmpdir() : fs.realpathSync(os.tmpdir())))
  const FOLDER_KEY = claudeFolderKey(FOLDER)
  const transcript = (id: string) => path.join(FOLDER, `${id}.jsonl`)
  const claudeWindows = (key: string) => notIndexedSnapshot().conversations[key] ?? []
  const used: string[] = []
  let next = 60
  const fresh = () => { const sid = `cl${'0'.repeat(20)}${next++}`; used.push(sid); return sid }
  const clock = (ms: number) => vi.setSystemTime(T0 + ms)
  const startClaude = (sid: string, extra: Record<string, unknown> = {}) => spawnPty(fakeWin, sid, { cwd: os.tmpdir(), provider: 'claude', configId: 'cfg-cl', ...extra } as never)
  const route = (sid: string, p: string) => routeHookTranscriptPath(sid, p, { attribute: () => {}, bind: () => {} })
  const hook = (sid: string, id: string) => route(sid, transcript(id))
  const exitOf = (proc: { exit: Array<(e: { exitCode: number }) => void> }) => { for (const cb of [...proc.exit]) cb({ exitCode: 0 }) }
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); clock(0); resumeAs.next = null; h.supNull = false })
  afterEach(() => { for (const sid of used.splice(0)) { try { killPty(sid) } catch { /* gone */ } } resumeAs.next = null; h.supNull = false; vi.useRealTimers() })

  it('N1: a launch not indexed marks its projects folder from the launch until it names a transcript; then that transcript from the launch, and the folder no more', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    startClaude(S)
    expect(Object.keys(notIndexedSnapshot().conversations)).toEqual([FOLDER_KEY])
    expect(claudeWindows(FOLDER_KEY)).toEqual([[T0, null]])
    clock(3000)
    hook(S, CL_A)
    expect(claudeWindows(CL_A)).toEqual([[T0, null]])
    expect(claudeWindows(FOLDER_KEY)).toEqual([[T0, T0 + 3000]])
  })

  it('N1 (lens A case 1, lens B B-M1-1): a session whose transcript is never named keeps its folder marked until its process has ended', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    startClaude(S)
    const proc = h.ptys.at(-1)!
    clock(60_000)
    killPty(S)
    expect(claudeWindows(FOLDER_KEY)).toEqual([[T0, null]])
    clock(61_000)
    exitOf(proc)
    expect(claudeWindows(FOLDER_KEY)).toEqual([[T0, T0 + 61_000]])
  })

  it('N2 (lens B B-M1-2): every transcript a session names stays marked until it ends; a subagent\'s transcript is not its conversation', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    startClaude(S)
    const proc = h.ptys.at(-1)!
    clock(1000); hook(S, CL_A)
    clock(5000); route(S, path.join(FOLDER, CL_A, 'subagents', 'agent-a1b2c3d4.jsonl'))
    clock(6000); hook(S, CL_B)
    // The same transcript again (the status line, each tick) changes nothing.
    clock(6500); hook(S, CL_B)
    expect(claudeWindows(CL_A)).toEqual([[T0, null]])
    expect(claudeWindows(CL_B)).toEqual([[T0, null]])
    clock(8000); killPty(S)
    clock(9000); exitOf(proc)
    expect(claudeWindows(CL_A)).toEqual([[T0, T0 + 9000]])
    expect(claudeWindows(CL_B)).toEqual([[T0, T0 + 9000]])
    expect(Object.keys(notIndexedSnapshot().conversations).sort()).toEqual([CL_A, CL_B, FOLDER_KEY].sort())
  })

  it('N2: a session ending by itself (its own exit) closes every window it holds', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    startClaude(S)
    const proc = h.ptys.at(-1)!
    clock(1000); hook(S, CL_A)
    clock(2000); hook(S, CL_B)
    clock(7000); exitOf(proc)
    expect(claudeWindows(CL_A)).toEqual([[T0, T0 + 7000]])
    expect(claudeWindows(CL_B)).toEqual([[T0, T0 + 7000]])
  })

  it('N3 (lens B B-M1-3): logging on but no log service this run marks nothing; logging off for the config does', () => {
    const S = fresh()
    h.supNull = true
    startClaude(S)
    hook(S, CL_A)
    expect(notIndexedSnapshot().conversations).toEqual({})
    h.supNull = false
    const R = fresh()
    h.configs = [{ id: 'cfg-off', provider: 'claude', claudeOptions: { loggingEnabled: false } }]
    startClaude(R, { configId: 'cfg-off', loggingEnabled: false })
    hook(R, CL_B)
    expect(claudeWindows(CL_B)).toEqual([[T0, null]])
  })

  it('N4: only a <uuid>.jsonl directly in a folder of the Claude projects root is taken (round 2, Q3: another project\'s folder too); any other name or place marks nothing', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    startClaude(S)
    route(S, path.join(FOLDER, 'not-a-uuid.jsonl'))
    route(S, path.join(os.tmpdir(), `${CL_A}.jsonl`))
    route(S, path.join(FOLDER, `${CL_A}.json`))
    route(S, path.join(FOLDER, CL_A, 'subagents', `${CL_B}.jsonl`))
    route(S, path.join(os.homedir(), '.claude', 'projects', `${CL_A}.jsonl`))
    route(S, path.join(os.homedir(), '.claude', `${CL_A}.jsonl`))
    expect(Object.keys(notIndexedSnapshot().conversations)).toEqual([FOLDER_KEY])
    // The same folder in another spelling (another config dir's projects folder) is the same folder.
    route(S, path.join(os.tmpdir(), 'profile-x', '.claude', 'projects', path.basename(FOLDER), `${CL_A.toUpperCase()}.jsonl`))
    expect(claudeWindows(CL_A)).toEqual([[T0, null]])
  })

  it('N4 (lens B B-M1-4), round 2 (Q2, lens A CAP, lens B B2-2): past HELD_WINDOWS_PER_SESSION_MAX names the folder window opens again from the start of the stretch, until the session ends; still bounded, and the before-time never moves', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    startClaude(S)
    const proc = h.ptys.at(-1)!
    clock(5000)
    for (let i = 0; i < 200; i++) hook(S, `7f3e0c1a-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const snap = notIndexedSnapshot()
    expect(snap.before).toBeNull()
    expect(Object.keys(snap.conversations).length).toBe(HELD_WINDOWS_PER_SESSION_MAX + 1)
    // Closed at the first name; open again, from the launch, at the first name past the cap.
    expect(claudeWindows(FOLDER_KEY)).toEqual([[T0, T0 + 5000], [T0, null]])
    clock(9000); killPty(S); exitOf(proc)
    expect(claudeWindows(FOLDER_KEY)).toEqual([[T0, T0 + 5000], [T0, T0 + 9000]])
  })

  it('N4 (lens B B-M1-5): the first window is written at once; the names after it go in one coalesced write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-test-p316-gaps-'))
    try {
      initIndexingGaps(path.join(dir, 'logging-gaps.json'), T0)
      const S = fresh()
      h.settings = { ...CONSENT, loggingEnabled: false }
      startClaude(S)
      const afterLaunch = indexingGapsWritesForTests()
      expect(afterLaunch).toBe(1)
      for (let i = 0; i < 20; i++) hook(S, `7f3e0c1a-0000-4000-8000-${String(i).padStart(12, '0')}`)
      expect(indexingGapsWritesForTests()).toBe(afterLaunch)
      vi.advanceTimersByTime(500)
      expect(indexingGapsWritesForTests()).toBe(afterLaunch + 1)
    } finally {
      resetIndexingGapsForTests()
      if (path.basename(dir).startsWith('ccc-test-p316-gaps-') && path.dirname(dir) === os.tmpdir()) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an indexed launch marks nothing, whatever its hooks name', () => {
    const S = fresh()
    startClaude(S)
    hook(S, CL_A)
    expect(notIndexedSnapshot().conversations).toEqual({})
  })

  it('an exact resume not indexed marks its transcript at the launch, before any hook, and not the folder', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    resumeAs.next = { resumeUuid: CL_A, claudeCwd: os.tmpdir() }
    clock(1000)
    startClaude(S, { resume: { uuid: CL_A, cwd: os.tmpdir() } })
    expect(claudeWindows(CL_A)).toEqual([[T0 + 1000, null]])
    expect(claudeWindows(FOLDER_KEY)).toEqual([])
  })

  it('switched off while running: the transcript the session is on is marked from the switch-off; one named after joins it', () => {
    const S = fresh()
    startClaude(S)
    hook(S, CL_A)
    clock(4000)
    h.settings = { ...CONSENT, loggingEnabled: false }
    applyLoggingSwitches()
    expect(claudeWindows(CL_A)).toEqual([[T0 + 4000, null]])
    clock(6000)
    hook(S, CL_B)
    expect(claudeWindows(CL_A)).toEqual([[T0 + 4000, null]])
    expect(claudeWindows(CL_B)).toEqual([[T0 + 4000, null]])
  })

  it('switched off before naming any: the folder is marked from the switch-off', () => {
    const S = fresh()
    startClaude(S)
    clock(4000)
    h.settings = { ...CONSENT, loggingEnabled: false }
    applyLoggingSwitches()
    expect(claudeWindows(FOLDER_KEY)).toEqual([[T0 + 4000, null]])
  })

  it('a tab closed while not indexed: its windows stay open through the wind-down and close when the exit is reported; with none reported, after the grace', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    startClaude(S)
    const proc = h.ptys.at(-1)!
    hook(S, CL_A)
    clock(2000)
    killPty(S)
    expect(claudeWindows(CL_A)).toEqual([[T0, null]])
    clock(3000)
    exitOf(proc)
    expect(claudeWindows(CL_A)).toEqual([[T0, T0 + 3000]])
    const R = fresh()
    clock(10_000)
    startClaude(R)
    hook(R, CL_B)
    clock(11_000)
    killPty(R)
    vi.advanceTimersByTime(CODEX_LEASE_EXIT_GRACE_MS - 1)
    expect(claudeWindows(CL_B)).toEqual([[T0 + 10_000, null]])
    vi.advanceTimersByTime(1)
    expect(claudeWindows(CL_B)).toEqual([[T0 + 10_000, T0 + 11_000 + CODEX_LEASE_EXIT_GRACE_MS]])
  })

  it('a Restart: the new launch marks its own folder and transcript, and the old process\'s late exit closes only the old windows', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    startClaude(S)
    const old = h.ptys.at(-1)!
    hook(S, CL_A)
    clock(2000)
    startClaude(S)
    // The Restart's launch has named no transcript yet: it marks its folder, nothing of the old one's.
    expect(claudeWindows(CL_A)).toEqual([[T0, null]])
    expect(claudeWindows(FOLDER_KEY)).toEqual([[T0, T0], [T0 + 2000, null]])
    clock(2500)
    hook(S, CL_A)
    expect(claudeWindows(CL_A)).toEqual([[T0, null], [T0 + 2000, null]])
    clock(4000)
    exitOf(old)
    expect(claudeWindows(CL_A)).toEqual([[T0, T0 + 4000], [T0 + 2000, null]])
  })

  it('a shell marks nothing, whatever reaches it; a Claude tab relaunched as a Codex one marks nothing of the Claude transcript', () => {
    h.settings = { ...CONSENT, loggingEnabled: false }
    const SH = fresh()
    spawnPty(fakeWin, SH, { cwd: os.tmpdir(), shellOnly: true } as never)
    hook(SH, CL_A)
    expect(notIndexedSnapshot().conversations).toEqual({})
    const S = fresh()
    h.settings = { ...CONSENT }
    startClaude(S)
    hook(S, CL_B)
    h.settings = { ...CONSENT, loggingEnabled: false }
    start(S)
    expect(claudeWindows(CL_B)).toEqual([])
  })

  // ---- P3.16a round 2 (Q1, Q2, Q3) ----
  /** Claude Code 2.1.285 to 2.1.287's projects folder name, copied from the
   *  pinned binaries (the oracle these cases check the app against): the name
   *  cut at 200 characters, then `-` and the base-36 hash of the whole folder. */
  const claudeCodeFolderName = (cwd: string): string => {
    const k = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    if (k.length <= 200) return k
    let hsh = 0
    for (let i = 0; i < cwd.length; i++) hsh = (hsh << 5) - hsh + cwd.charCodeAt(i) | 0
    return `${k.slice(0, 200)}-${Math.abs(hsh).toString(36)}`
  }
  /** The folder Claude Code launched in `cwd` writes to (it takes the real path of its launch folder). */
  const claudeCodeFolder = (cwd: string) => path.join(os.homedir(), '.claude', 'projects', claudeCodeFolderName(process.platform === 'win32' ? cwd : fs.realpathSync(cwd)))
  const PROJECTS = path.join(os.homedir(), '.claude', 'projects')
  /** A launch folder whose name is longer than 200 characters, made for the case and removed after it. */
  const withLongFolder = (fn: (cwd: string) => void) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-test-p316r2-'))
    try {
      let long = base
      while (long.length < 215) long = path.join(long, 'deeply-nested-package-folder')
      fs.mkdirSync(long, { recursive: true })
      fn(long)
    } finally {
      if (path.basename(base).startsWith('ccc-test-p316r2-') && path.dirname(base) === os.tmpdir()) fs.rmSync(base, { recursive: true, force: true })
    }
  }
  const id = (i: number) => `7f3e0c1a-0000-4000-8000-${String(i).padStart(12, '0')}`

  it('Q1 (lens A LONG, lens B B2-1): a launch folder whose name is longer than 200 characters: the folder marked and the names taken are the ones Claude Code writes to', () => {
    withLongFolder((cwd) => {
      expect(cwd.replace(/[^a-zA-Z0-9]/g, '-').length).toBeGreaterThan(200)
      const S = fresh()
      h.settings = { ...CONSENT, loggingEnabled: false }
      startClaude(S, { cwd })
      const real = claudeCodeFolder(cwd)
      expect(Object.keys(notIndexedSnapshot().conversations)).toEqual([claudeFolderKey(real)])
      clock(2000)
      route(S, path.join(real, `${CL_A}.jsonl`))
      expect(claudeWindows(CL_A)).toEqual([[T0, null]])
      expect(claudeWindows(claudeFolderKey(real))).toEqual([[T0, T0 + 2000]])
      killPty(S)
    })
  })

  it('Q1: an exact resume in such a folder binds the transcript Claude Code writes to at the launch; not indexed, it marks that transcript', () => {
    withLongFolder((cwd) => {
      const S = fresh()
      resumeAs.next = { resumeUuid: CL_B, claudeCwd: cwd }
      startClaude(S, { cwd, resume: { uuid: CL_B, cwd } })
      expect(h.claudeBinder.filter((c) => c[0] === 'notify' && c[1] === S)).toEqual([['notify', S, path.join(claudeCodeFolder(cwd), `${CL_B}.jsonl`)]])
      killPty(S)
      const R = fresh()
      h.settings = { ...CONSENT, loggingEnabled: false }
      resumeAs.next = { resumeUuid: CL_B, claudeCwd: cwd }
      clock(1000)
      startClaude(R, { cwd, resume: { uuid: CL_B, cwd } })
      expect(claudeWindows(CL_B)).toEqual([[T0 + 1000, null]])
      killPty(R)
    })
  })

  it('Q3: a transcript in another project\'s folder (a /resume across projects) is marked within the cap, and the session\'s folder window closes as at any name', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    startClaude(S)
    clock(3000)
    route(S, path.join(PROJECTS, 'C--elsewhere', `${CL_A}.jsonl`))
    expect(claudeWindows(CL_A)).toEqual([[T0, null]])
    expect(claudeWindows(FOLDER_KEY)).toEqual([[T0, T0 + 3000]])
  })

  it('Q2, Q3: past the cap, a name in another project\'s folder opens one window on the projects root, from the start of the stretch until the session ends', () => {
    const S = fresh()
    h.settings = { ...CONSENT, loggingEnabled: false }
    startClaude(S)
    const proc = h.ptys.at(-1)!
    clock(5000)
    for (let i = 0; i < HELD_WINDOWS_PER_SESSION_MAX; i++) hook(S, id(i))
    clock(6000)
    route(S, path.join(PROJECTS, 'C--elsewhere', `${id(500)}.jsonl`))
    route(S, path.join(PROJECTS, 'C--another', `${id(501)}.jsonl`))
    const ROOT_KEY = claudeProjectsRootKey(PROJECTS)
    expect(claudeWindows(ROOT_KEY)).toEqual([[T0, null]])
    expect(claudeWindows(id(500))).toEqual([])
    // Its own folder's names past the cap: the folder window, open again.
    clock(7000)
    hook(S, id(502))
    expect(claudeWindows(FOLDER_KEY)).toEqual([[T0, T0 + 5000], [T0, null]])
    // A name it holds already (the status line names it again) leaves the cover open.
    clock(7500)
    hook(S, id(0))
    expect(claudeWindows(FOLDER_KEY)).toEqual([[T0, T0 + 5000], [T0, null]])
    expect(Object.keys(notIndexedSnapshot().conversations).length).toBe(HELD_WINDOWS_PER_SESSION_MAX + 2)
    expect(notIndexedSnapshot().before).toBeNull()
    clock(9000); killPty(S); exitOf(proc)
    expect(claudeWindows(ROOT_KEY)).toEqual([[T0, T0 + 9000]])
    expect(claudeWindows(FOLDER_KEY)).toEqual([[T0, T0 + 5000], [T0, T0 + 9000]])
  })
})
