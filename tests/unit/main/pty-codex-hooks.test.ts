// P3.10 (rows 43, 46, 47, 63; P3.5 and P3.6's limits): what pty-manager does
// with a Codex session's hooks. A launch gets the app's hooks when the Hooks
// gateway is on and listening, as a Claude launch gets its http hooks (a token
// minted for the session, handed to the hook through a file, never a command
// line); the file goes with the session's resources. A hook's transcript path
// is the exact claim of the session's conversation (as Claude's #480 bind):
// handed to that session's watch only, never to a Claude sink. It clears P3.6's
// doubt about a conversation the session's own Codex named (never one a live
// launch resumed by id from a record already in doubt), and once the session's
// own hooks are heard, a conversation still only inferred is not carried by a
// Switch. A local Codex session arms the Watchdog (off by default). And the C
// item: a local Claude spawn that throws after its process started ends that
// process.
// P3.10 round 1: the record that a hook's path is a Codex one lives as long as
// the gateway token (B1); a token nothing will use goes (B2); only a
// conversation a session's Codex STARTED proves another's inferred claim wrong
// (B4); a live Claude session's path still reaches Claude's sinks (B5); the
// idle mark ends with its run (Q1); a released claim's path is taken again
// (Q3); "unconfirmed" and the doubt are keyed to the session (S4); a refused
// path is logged once a launch (N1); the picker is told which conversations
// other tabs are on (V2).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

interface FakePty { cmd: string; exit: Array<(e: { exitCode: number }) => void>; kill: ReturnType<typeof vi.fn> }
interface FakeSource { sid: string; opts: Record<string, any>; stop: ReturnType<typeof vi.fn>; noteExactRollout: ReturnType<typeof vi.fn>; refuteInferredClaim: ReturnType<typeof vi.fn>; recheckShared: ReturnType<typeof vi.fn> }
const TOKEN = '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60'
const h = vi.hoisted(() => ({
  ptys: [] as FakePty[],
  built: [] as Array<Record<string, unknown>>,
  sources: [] as FakeSource[],
  gatewayListening: true,
  registered: [] as string[],
  unregistered: [] as string[],
  prepared: [] as Array<{ sid: string; port: number; secret: string; extra: number }>,
  prepareNull: false,
  disposed: [] as string[],
  hooksInstalled: true,
  exactResult: null as null | { id: string; cwd: string },
  refuted: false,
  wdStarts: [] as Array<{ sid: string; info: Record<string, unknown> }>,
  wdFeeds: [] as string[],
  failCapture: false,
  failBuild: false,
  failTelemetry: false,
  failSpawn: false,
  warns: [] as string[],
  removedFiles: [] as string[],
  clearedAccounts: [] as string[],
}))

vi.mock('node-pty', () => ({
  spawn: (cmd: string) => {
    if (h.failSpawn) throw new Error('File not found: ' + cmd)
    const p: FakePty = { cmd, exit: [], kill: vi.fn() }
    h.ptys.push(p)
    const dataCbs: Array<(d: string) => void> = []
    ;(p as any).emitData = (d: string) => { for (const cb of dataCbs) cb(d) }
    return {
      pid: 5000 + h.ptys.length,
      process: cmd,
      onData: (cb: (d: string) => void) => { dataCbs.push(cb); return { dispose: () => {} } },
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
vi.mock('../../../src/main/debug-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/debug-logger')>()),
  logWarn: (...a: unknown[]) => { h.warns.push(a.map(String).join(' ')) },
}))
// [host] The real logger kept above keeps its log inside the test's own folder, never
// the installed app's (tests/helpers/test-data-dir.ts).
const TEST_DATA = await vi.hoisted(async () => (await import('../../helpers/test-data-dir')).useTestDataDirectory())
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: () => 'tok',
  registerCodexReviewSession: () => {},
  registerClaudeReviewSession: () => {},
  unregisterCodexReviewSession: () => {},
  releaseMcpSessionProvider: () => {},
  disposeCodexReviewUsage: () => {},
}))
vi.mock('../../../src/main/providers', () => ({
  getProvider: (id: string) => ({
    resolveBinary: () => ({ cmd: 'claude', source: 'system' }), // WP2 PR 4: the local launch resolves Claude through the provider
    buildSpawnCommand: (opts: Record<string, any>) => {
      if (opts.provider !== 'codex') return { cmd: 'pwsh', args: [], env: {} }
      h.built.push(opts)
      if (h.failBuild) throw new Error('build failed')
      const env = { ...opts.realmLaunch.env, CLAUDE_MULTI_SESSION_ID: String(opts.sessionId) }
      return { cmd: opts.realmLaunch.executable, args: [], env, hooksInstalled: !!opts.codexHooks && h.hooksInstalled, ...(opts.resume ? { resumeId: opts.resume.uuid } : {}) }
    },
    ...(id === 'codex' ? {
      prepareSessionHooks: (sid: string, port: number, secret: string, ...extra: unknown[]) => {
        h.prepared.push({ sid, port, secret, extra: extra.length })
        if (h.prepareNull) return null
        return { hookFile: `/tmp/codex-hooks/ccc-codex-hook-x/${sid}/hook.json`, dispose: () => { h.disposed.push(sid) } }
      },
    } : {}),
    ingestSessionTelemetry: (sid: string, opts: Record<string, any>) => {
      if (h.failTelemetry) throw new Error('telemetry failed')
      const src: FakeSource = { sid, opts, stop: vi.fn(), noteExactRollout: vi.fn(() => h.exactResult), refuteInferredClaim: vi.fn(() => h.refuted), recheckShared: vi.fn(() => true) }
      h.sources.push(src)
      return src
    },
  }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({
  getGateway: () => ({
    status: () => (h.gatewayListening ? { enabled: true, listening: true, port: 51234 } : { enabled: false, listening: false, port: null }),
    registerSession: (sid: string) => { h.registered.push(sid); return TOKEN },
    unregisterSession: (sid: string) => { h.unregistered.push(sid) },
  }),
  isExactBindSourceActive: () => true,
}))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => '/nonexistent/settings.json',
  removeLocalSessionSettings: (sid: string) => { h.removedFiles.push(`settings:${sid}`) },
  writeLocalSessionMcpConfig: () => '/nonexistent/mcp.json',
  removeLocalSessionMcpConfig: (sid: string) => { h.removedFiles.push(`mcp:${sid}`) },
  removeLocalSessionStatusUrl: (sid: string) => { h.removedFiles.push(`status-url:${sid}`) },
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => { if (h.failCapture) throw new Error('capture failed') },
  clearClaudeAccount: (sid: string) => { h.clearedAccounts.push(sid) },
  getAccountIdentity: () => null,
  pushAccountIdentity: () => {},
  startWatchingAccountIdentity: () => {},
  stopWatchingAccountIdentity: () => {},
  getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {} }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({
  getWatchdogManager: () => ({
    startWatchdog: (sid: string, info: Record<string, unknown>) => { h.wdStarts.push({ sid, info }) },
    stopWatchdog: () => {},
    feedData: (sid: string) => { h.wdFeeds.push(sid) },
    noteRedrawTrigger: () => {},
    noteResize: () => {},
  }),
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

const pm = await import('../../../src/main/pty-manager')
const { spawnPty, killPty, noteCodexHookTranscript, noteCodexHookEvent, routeHookTranscriptPath, getKeptCodexConversationSource, rememberUncertainCodexConversationsFrom, isCodexPtySession } = pm
const { codexIdleMarks } = await import('../../../src/main/codex-idle-attention')

const SID = 'cx0000000000000000000001'
const SID2 = 'cx0000000000000000000002'
const CLAUDE_SID = 'cl0000000000000000000001'
const ID_A = '019dd000-0001-7000-8000-00000000000a'
const ID_B = '019dd000-0001-7000-8000-00000000000b'
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
function launch(tag: string) {
  return {
    lease: { release: vi.fn(), accountId: `acct-${tag}` },
    executable: `/proven/${tag}/codex`,
    env: { PATH: '/usr/bin', CODEX_HOME: `/res/codex-realms/${tag}` },
    sessionsDir: `/res/codex-realms/${tag}/sessions`,
  } as never
}
const start = (sid: string, tag = 'a', extra: Record<string, unknown> = {}) =>
  spawnPty(fakeWin, sid, { cwd: os.tmpdir(), provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, codexLaunch: launch(tag), ...extra } as never)
const source = (sid: string): FakeSource => [...h.sources].reverse().find((s) => s.sid === sid)!
const exitAll = () => { for (const p of h.ptys) for (const cb of [...p.exit]) cb({ exitCode: 0 }) }
const rollout = (tag: string, id: string) => `/res/codex-realms/${tag}/sessions/2026/09/29/rollout-2026-09-29T10-00-00-${id}.jsonl`
const sessionStart = (sid: string, source: string, transcriptPath: string) => ({ sessionId: sid, event: 'SessionStart', payload: { hook_event_name: 'SessionStart', source, transcript_path: transcriptPath }, ts: 0 })

beforeEach(() => {
  for (const sid of [SID, SID2, CLAUDE_SID]) { try { killPty(sid) } catch { /* none */ } }
  exitAll()
  h.ptys = []; h.built = []; h.sources = []; h.registered = []; h.unregistered = []; h.prepared = []; h.disposed = []
  h.gatewayListening = true; h.hooksInstalled = true; h.exactResult = null; h.refuted = false; h.wdStarts = []; h.wdFeeds = []; h.failCapture = false
  h.failBuild = false; h.failTelemetry = false; h.failSpawn = false; h.prepareNull = false; h.warns = []; h.removedFiles = []; h.clearedAccounts = []
})

describe('a Codex launch and its hooks (rows 43, 46, 47, 63)', () => {
  it('with the Hooks gateway listening: a token minted for the session, its hook file handed to the builder, kept with the session and gone with its resources', () => {
    start(SID)
    expect(h.registered).toEqual([SID])
    // Round 4 (P1): no folder rule at the launch; the hook folders were prepared beforehand, off the main thread.
    expect(h.prepared).toEqual([{ sid: SID, port: 51234, secret: TOKEN, extra: 0 }])
    expect(h.built[0].codexHooks).toEqual({ hookFile: `/tmp/codex-hooks/ccc-codex-hook-x/${SID}/hook.json` })
    // The token itself never reaches the builder.
    expect(JSON.stringify(h.built[0])).not.toContain(TOKEN)
    expect(h.disposed).toEqual([])
    killPty(SID)
    expect(h.disposed).toEqual([SID])
  })

  it('with the gateway off or not listening: no token, no hook file, no hooks', () => {
    h.gatewayListening = false
    start(SID)
    expect(h.registered).toEqual([])
    expect(h.prepared).toEqual([])
    expect(h.built[0].codexHooks).toBeUndefined()
  })

  it('a hook file the launch could not use (its command not safe on the route) goes at once, and so does its token (round 1, B2)', () => {
    h.hooksInstalled = false
    start(SID)
    expect(h.disposed).toEqual([SID])
    expect(h.unregistered).toEqual([SID])
  })

  it('round 1 (B2): no hook file could be written: the token minted for it goes at once', () => {
    h.prepareNull = true
    start(SID)
    expect(h.registered).toEqual([SID])
    expect(h.built[0].codexHooks).toBeUndefined()
    expect(h.unregistered).toEqual([SID])
  })

  it('round 1 (B2): a Codex spawn that throws gives back the token it minted (before its process started, and after)', () => {
    h.failBuild = true
    expect(() => start(SID)).toThrow(/build failed/)
    expect(h.unregistered).toEqual([SID])
    expect(h.disposed).toEqual([SID])
    h.failBuild = false
    h.failTelemetry = true
    expect(() => start(SID2)).toThrow(/telemetry failed/)
    expect(h.ptys.at(-1)!.kill).toHaveBeenCalled()
    expect(h.unregistered).toEqual([SID, SID2])
  })

  it('a respawn of the session gets a new hook file; the old one went with the old run\'s resources', () => {
    start(SID)
    start(SID)
    expect(h.prepared.length).toBe(2)
    expect(h.disposed).toEqual([SID])
  })

  it('a local Codex session arms the Watchdog with its provider, and feeds it its output', () => {
    start(SID)
    expect(h.wdStarts).toEqual([expect.objectContaining({ sid: SID, info: expect.objectContaining({ provider: 'codex', ssh: false, shellOnly: false }) })])
    ;(h.ptys[0] as any).emitData('hello')
    expect(h.wdFeeds).toContain(SID)
  })

  it('round 1 (V2): a picker launch is told which conversations the other open Codex tabs are on (ids only), and nothing of its own', () => {
    start(SID, 'a', { resume: { uuid: ID_A, cwd: os.tmpdir() } })
    start(SID2, 'a', { useResumePicker: true })
    expect(h.built[1].codexOpenElsewhere).toEqual([ID_A])
    // A launch that is not the picker is told nothing.
    expect(h.built[0].codexOpenElsewhere).toBeUndefined()
    // A tab that has closed (its process ended, its account let go) is not open anywhere.
    killPty(SID)
    exitAll()
    start(SID2, 'a', { useResumePicker: true })
    expect(h.built.at(-1)!.codexOpenElsewhere).toEqual([])
  })

  it('round 2 (R10): only tabs on the same account count: the same conversation open on another account holds no lock here', () => {
    start(SID, 'b', { resume: { uuid: ID_A, cwd: os.tmpdir() } })
    start(SID2, 'a', { useResumePicker: true })
    expect(h.built.at(-1)!.codexOpenElsewhere).toEqual([])
    start(CLAUDE_SID, 'a', { resume: { uuid: ID_B, cwd: os.tmpdir() } })
    start(SID2, 'a', { useResumePicker: true })
    expect(h.built.at(-1)!.codexOpenElsewhere).toEqual([ID_B])
  })

  it('round 1 (Q1): a turn\'s pending idle mark goes with the run it was for (a kill, a Restart)', () => {
    start(SID)
    const clear = vi.fn()
    codexIdleMarks.set(SID, { handle: 1 as unknown as ReturnType<typeof setTimeout>, clear })
    start(SID)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(codexIdleMarks.has(SID)).toBe(false)
    codexIdleMarks.set(SID, { handle: 2 as unknown as ReturnType<typeof setTimeout>, clear })
    killPty(SID)
    expect(clear).toHaveBeenCalledTimes(2)
    expect(codexIdleMarks.has(SID)).toBe(false)
  })
})

describe('a hook\'s transcript path: the exact claim (P3.5, P3.6 limits)', () => {
  it('is Codex\'s only: false for a session that is not a Codex one (so the Claude sinks keep it)', () => {
    expect(noteCodexHookTranscript('no-such-session', '/x')).toBe(false)
  })

  it('round 1 (B5): a live Claude session\'s path reaches Claude\'s sinks, the account attribution and the binder; a Codex session\'s reaches neither', () => {
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)
    start(SID)
    const attribute = vi.fn()
    const bind = vi.fn()
    routeHookTranscriptPath(CLAUDE_SID, '/claude/projects/x/abc.jsonl', { attribute, bind })
    expect(attribute).toHaveBeenCalledWith(CLAUDE_SID, '/claude/projects/x/abc.jsonl')
    expect(bind).toHaveBeenCalledWith(CLAUDE_SID, '/claude/projects/x/abc.jsonl')
    routeHookTranscriptPath(SID, rollout('a', ID_A), { attribute, bind })
    expect(attribute).toHaveBeenCalledTimes(1)
    expect(bind).toHaveBeenCalledTimes(1)
  })

  it('round 1 (B1) and round 2 (R8): a killed Codex session\'s token goes at the kill (the gateway refuses its late hooks); a hook already on its way is still Codex\'s, never a Claude sink; after its exit, the session is no longer Codex\'s', () => {
    start(SID)
    killPty(SID)
    expect(h.unregistered).toEqual([SID])
    expect(noteCodexHookTranscript(SID, rollout('a', ID_A))).toBe(true)
    expect(source(SID).noteExactRollout).not.toHaveBeenCalled()
    exitAll()
    expect(h.unregistered).toContain(SID)
    expect(noteCodexHookTranscript(SID, rollout('a', ID_A))).toBe(false)
  })

  it('round 2 (R8): a Claude session\'s token is not dropped at its kill (it goes with its exit, as before)', () => {
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)
    killPty(CLAUDE_SID)
    expect(h.unregistered).toEqual([])
  })

  it('round 1 (B1): a session respawned as Claude with a token of its own is Claude\'s again', () => {
    start(CLAUDE_SID)
    killPty(CLAUDE_SID)
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)
    expect(noteCodexHookTranscript(CLAUDE_SID, '/claude/projects/x/abc.jsonl')).toBe(false)
  })

  it('a Codex session given no hooks: true (no Claude sink), and nothing it says is taken', () => {
    h.gatewayListening = false
    start(SID)
    expect(isCodexPtySession(SID)).toBe(true)
    expect(noteCodexHookTranscript(SID, '/res/codex-realms/a/sessions/2026/09/29/rollout-x.jsonl')).toBe(true)
    expect(source(SID).noteExactRollout).not.toHaveBeenCalled()
  })

  it('handed to the session\'s own watch; the same path again costs a comparison only; it proves nothing about the others by itself', () => {
    start(SID, 'a')
    start(SID2, 'a')
    const p = rollout('a', ID_A)
    h.exactResult = { id: ID_A, cwd: '/p' }
    expect(noteCodexHookTranscript(SID, p)).toBe(true)
    expect(source(SID).noteExactRollout).toHaveBeenCalledWith(p)
    expect(source(SID2).refuteInferredClaim).not.toHaveBeenCalled()
    noteCodexHookTranscript(SID, p)
    expect(source(SID).noteExactRollout).toHaveBeenCalledTimes(1)
  })

  it('P3.12 round 1 (B1): once another session\'s inferred claim is refuted, the session whose Codex started the conversation is re-checked (it may now hold it); not when nothing was refuted', () => {
    start(SID, 'a')
    start(SID2, 'a')
    const p = rollout('a', ID_A)
    h.exactResult = { id: ID_A, cwd: '/p' }
    noteCodexHookTranscript(SID, p)
    noteCodexHookEvent(sessionStart(SID, 'startup', p))
    expect(source(SID).recheckShared).not.toHaveBeenCalled()
    h.refuted = true
    noteCodexHookEvent(sessionStart(SID, 'startup', p))
    expect(source(SID).recheckShared).toHaveBeenCalledTimes(1)
    expect(source(SID2).recheckShared).not.toHaveBeenCalled()
  })

  it('round 1 (B4): a conversation the session\'s own Codex STARTED proves another session\'s inferred claim of it wrong', () => {
    start(SID, 'a')
    start(SID2, 'a')
    const p = rollout('a', ID_A)
    h.exactResult = { id: ID_A, cwd: '/p' }
    noteCodexHookTranscript(SID, p)
    noteCodexHookEvent(sessionStart(SID, 'startup', p))
    expect(source(SID2).refuteInferredClaim).toHaveBeenCalledWith(p)
    expect(source(SID).refuteInferredClaim).not.toHaveBeenCalled()
  })

  it('round 1 (B4): one it RESUMED proves nothing (another tab may have made it and still be writing it); nor a path its watch did not take, nor a session without hooks', () => {
    start(SID2, 'a')
    start(SID, 'a', { resume: { uuid: ID_A, cwd: os.tmpdir() } })
    const p = rollout('a', ID_A)
    h.exactResult = { id: ID_A, cwd: '/p' }
    noteCodexHookTranscript(SID, p)
    noteCodexHookEvent(sessionStart(SID, 'resume', p))
    expect(source(SID2).refuteInferredClaim).not.toHaveBeenCalled()
    // A startup naming a path this session's watch did not take.
    noteCodexHookEvent(sessionStart(SID, 'startup', rollout('a', ID_B)))
    expect(source(SID2).refuteInferredClaim).not.toHaveBeenCalled()
    // Not a SessionStart, or no payload.
    noteCodexHookEvent({ sessionId: SID, event: 'UserPromptSubmit', payload: { source: 'startup', transcript_path: p } })
    noteCodexHookEvent({ sessionId: SID, event: 'SessionStart' })
    expect(source(SID2).refuteInferredClaim).not.toHaveBeenCalled()
    // A session this launch gave no hooks.
    h.gatewayListening = false
    start(SID, 'a')
    noteCodexHookEvent(sessionStart(SID, 'startup', p))
    expect(source(SID2).refuteInferredClaim).not.toHaveBeenCalled()
  })

  it('a path the watch refuses changes nothing and proves nothing, and is logged once a launch (round 1, N1)', () => {
    start(SID, 'a')
    start(SID2, 'a')
    h.exactResult = null
    expect(noteCodexHookTranscript(SID, '/elsewhere/rollout.jsonl')).toBe(true)
    noteCodexHookEvent(sessionStart(SID, 'startup', '/elsewhere/rollout.jsonl'))
    expect(source(SID2).refuteInferredClaim).not.toHaveBeenCalled()
    noteCodexHookTranscript(SID, '/elsewhere/other.jsonl')
    noteCodexHookTranscript(SID, '/elsewhere/third.jsonl')
    expect(h.warns.filter((w) => w.includes(`Codex session ${SID}: a hook named a transcript`)).length).toBe(1)
    // A new launch of the session says it again, once.
    start(SID, 'a')
    noteCodexHookTranscript(SID, '/elsewhere/rollout.jsonl')
    expect(h.warns.filter((w) => w.includes(`Codex session ${SID}: a hook named a transcript`)).length).toBe(2)
  })

  it('round 1 (Q3): a released claim\'s path is handed to the watch again when a hook names it again', () => {
    start(SID, 'a')
    const p = rollout('a', ID_A)
    h.exactResult = { id: ID_A, cwd: '/p' }
    noteCodexHookTranscript(SID, p)
    source(SID).opts.onRelease()
    noteCodexHookTranscript(SID, p)
    expect(source(SID).noteExactRollout).toHaveBeenCalledTimes(2)
  })

  it('clears P3.6\'s doubt about a conversation the session\'s own Codex named', () => {
    rememberUncertainCodexConversationsFrom({ codexUncertainConversations: [ID_A] })
    start(SID)
    source(SID).opts.onClaim({ id: ID_A, cwd: '/p', certain: true, exact: true, fromHook: true })
    expect(getKeptCodexConversationSource(SID)).toMatchObject({ uuid: ID_A, uncertain: false, unconfirmed: false })
  })

  it('keeps the doubt about the conversation the launch resumed by id (the app\'s own choice, from a record in doubt)', () => {
    rememberUncertainCodexConversationsFrom({ codexUncertainConversations: [ID_B] })
    start(SID, 'a', { resume: { uuid: ID_B, cwd: os.tmpdir() } })
    source(SID).opts.onClaim({ id: ID_B, cwd: '/p', certain: true, exact: true, fromHook: true })
    expect(getKeptCodexConversationSource(SID)?.uncertain).toBe(true)
  })

  it('round 1 (S4, lens B N8): keeps it too when the launch resumed it by id while another tab holds it (its hook reports it shared)', () => {
    rememberUncertainCodexConversationsFrom({ codexUncertainConversations: [ID_B] })
    start(SID, 'a', { resume: { uuid: ID_B, cwd: os.tmpdir() } })
    source(SID).opts.onShared({ id: ID_B, cwd: '/p', exact: true, fromHook: true })
    expect(getKeptCodexConversationSource(SID)?.uncertain).toBe(true)
  })

  it('round 1 (S4, lens B B2b): another tab\'s hook naming it does not clear the doubt a live resume by id keeps; once that tab is gone, it does', () => {
    rememberUncertainCodexConversationsFrom({ codexUncertainConversations: [ID_B] })
    start(SID, 'a', { resume: { uuid: ID_B, cwd: os.tmpdir() } })
    start(SID2, 'a')
    source(SID2).opts.onShared({ id: ID_B, cwd: '/p', exact: true, fromHook: true })
    expect(getKeptCodexConversationSource(SID)?.uncertain).toBe(true)
    killPty(SID)
    source(SID2).opts.onClaim({ id: ID_B, cwd: '/p', certain: true, exact: true, fromHook: true })
    expect(getKeptCodexConversationSource(SID2)?.uncertain).toBe(false)
  })

  it('round 1 (S4): "unconfirmed" is keyed to the session\'s own hooks: another tab of the account heard from changes nothing; this one\'s heard, an inferred claim is unconfirmed; exact, it is not', () => {
    start(SID, 'c')
    const onClaim = source(SID).opts.onClaim
    onClaim({ id: ID_A, cwd: '/p', certain: true, exact: false, fromHook: false })
    expect(getKeptCodexConversationSource(SID)).toMatchObject({ uuid: ID_A, uncertain: false, unconfirmed: false })
    // Another session of the same account is heard from (it trusted the hooks): this tab keeps P3.6's rules.
    start(SID2, 'c')
    h.exactResult = { id: ID_B, cwd: '/p' }
    noteCodexHookTranscript(SID2, rollout('c', ID_B))
    expect(getKeptCodexConversationSource(SID)?.unconfirmed).toBe(false)
    // This session's own hook is heard, yet names no rollout its watch takes: its inferred claim is unconfirmed.
    h.exactResult = null
    noteCodexHookTranscript(SID, '/elsewhere/rollout.jsonl')
    expect(getKeptCodexConversationSource(SID)?.unconfirmed).toBe(true)
    // Its own hook names it: exact.
    onClaim({ id: ID_A, cwd: '/p', certain: true, exact: true, fromHook: true })
    expect(getKeptCodexConversationSource(SID)?.unconfirmed).toBe(false)
    // A claim taken by inference later in the same launch (its hooks already heard) is unconfirmed from the start.
    onClaim({ id: ID_B, cwd: '/p', certain: true, exact: false, fromHook: false })
    expect(getKeptCodexConversationSource(SID)).toMatchObject({ uuid: ID_B, unconfirmed: true })
  })

  it('a launch without hooks keeps P3.6\'s rules even where another session\'s hooks are heard from', () => {
    start(SID2, 'd')
    h.exactResult = { id: ID_B, cwd: '/p' }
    noteCodexHookTranscript(SID2, rollout('d', ID_B))
    h.gatewayListening = false
    start(SID, 'd')
    source(SID).opts.onClaim({ id: ID_A, cwd: '/p', certain: true, exact: false, fromHook: false })
    expect(getKeptCodexConversationSource(SID)?.unconfirmed).toBe(false)
  })
})

describe('the C item: a local spawn that throws after its process started', () => {
  it('ends that process, gives back its token, removes its session files and clears its account capture; the throw reaches the caller as before', () => {
    h.failCapture = true
    expect(() => spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)).toThrow(/capture failed/)
    expect(h.ptys.length).toBe(1)
    expect(h.ptys[0].kill).toHaveBeenCalled()
    expect(h.unregistered).toContain(CLAUDE_SID)
    expect(h.removedFiles).toEqual(expect.arrayContaining([`settings:${CLAUDE_SID}`, `mcp:${CLAUDE_SID}`, `status-url:${CLAUDE_SID}`]))
    expect(h.clearedAccounts).toContain(CLAUDE_SID)
  })

  it('a spawn that throws before any process started (the terminal itself failed to start) kills nothing, and the throw reaches the caller', () => {
    h.failSpawn = true
    expect(() => spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)).toThrow(/File not found/)
    expect(h.ptys.length).toBe(0)
  })
})

describe('P3.12 round 2 (Q3): a holder stops', () => {
  it('the other Codex sessions are re-checked (a reader beside it holds the conversation now); not before', () => {
    start(SID, 'a')
    start(SID2, 'a')
    expect(source(SID2).recheckShared).not.toHaveBeenCalled()
    killPty(SID)
    expect(source(SID2).recheckShared).toHaveBeenCalledTimes(1)
    expect(source(SID).recheckShared).not.toHaveBeenCalled()
  })
})

describe("the test's own log folder", () => {
  it("[host] the real logger keeps its log inside the test's own folder", async () => {
    const { getLogDir } = await import('../../../src/main/debug-logger')
    expect(getLogDir()).toBe(path.join(TEST_DATA, 'debug'))
  })
})
