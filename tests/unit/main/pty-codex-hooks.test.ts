// P3.10 (rows 43, 46, 47, 63; P3.5 and P3.6's limits): what pty-manager does
// with a Codex session's hooks. A launch gets the app's hooks when the Hooks
// gateway is on and listening, as a Claude launch gets its http hooks (a token
// minted for the session, handed to the hook through a file, never a command
// line); the file goes with the session's resources. A hook's transcript path
// is the exact claim of the session's conversation (as Claude's #480 bind):
// handed to that session's watch only, never to a Claude sink, and proving any
// other session's inferred claim of it wrong. It clears P3.6's doubt about a
// conversation the session's own Codex named (never one the launch resumed by
// id from a record already in doubt), and once a realm's hooks are heard from,
// a conversation that is still only inferred there is not carried by a Switch.
// A local Codex session arms the Watchdog (off by default). And the C item: a
// local Claude spawn that throws after its process started ends that process.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

interface FakePty { cmd: string; exit: Array<(e: { exitCode: number }) => void>; kill: ReturnType<typeof vi.fn> }
interface FakeSource { sid: string; opts: Record<string, any>; stop: ReturnType<typeof vi.fn>; noteExactRollout: ReturnType<typeof vi.fn>; refuteInferredClaim: ReturnType<typeof vi.fn> }
const TOKEN = '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60'
const h = vi.hoisted(() => ({
  ptys: [] as FakePty[],
  built: [] as Array<Record<string, unknown>>,
  sources: [] as FakeSource[],
  gatewayListening: true,
  registered: [] as string[],
  unregistered: [] as string[],
  prepared: [] as Array<{ sid: string; port: number; secret: string }>,
  disposed: [] as string[],
  hooksInstalled: true,
  exactResult: null as null | { id: string; cwd: string },
  wdStarts: [] as Array<{ sid: string; info: Record<string, unknown> }>,
  wdFeeds: [] as string[],
  failCapture: false,
}))

vi.mock('node-pty', () => ({
  spawn: (cmd: string) => {
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
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: () => 'tok',
  registerCodexReviewSession: () => {},
  registerClaudeReviewSession: () => {},
  unregisterCodexReviewSession: () => {},
  disposeCodexReviewUsage: () => {},
}))
vi.mock('../../../src/main/providers', () => ({
  getProvider: (id: string) => ({
    buildSpawnCommand: (opts: Record<string, any>) => {
      if (opts.provider !== 'codex') return { cmd: 'pwsh', args: [], env: {} }
      h.built.push(opts)
      const env = { ...opts.realmLaunch.env, CLAUDE_MULTI_SESSION_ID: String(opts.sessionId) }
      return { cmd: opts.realmLaunch.executable, args: [], env, hooksInstalled: !!opts.codexHooks && h.hooksInstalled, ...(opts.resume ? { resumeId: opts.resume.uuid } : {}) }
    },
    ...(id === 'codex' ? {
      prepareSessionHooks: (sid: string, port: number, secret: string) => {
        h.prepared.push({ sid, port, secret })
        return { hookFile: `/tmp/ccc-codex-hook-x/${sid}/hook.json`, dispose: () => { h.disposed.push(sid) } }
      },
    } : {}),
    ingestSessionTelemetry: (sid: string, opts: Record<string, any>) => {
      const src: FakeSource = { sid, opts, stop: vi.fn(), noteExactRollout: vi.fn(() => h.exactResult), refuteInferredClaim: vi.fn(() => false) }
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
  removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => '/nonexistent/mcp.json',
  removeLocalSessionMcpConfig: () => {},
  removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => { if (h.failCapture) throw new Error('capture failed') },
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
const { spawnPty, killPty, noteCodexHookTranscript, getKeptCodexConversationSource, rememberUncertainCodexConversationsFrom, isCodexPtySession } = pm

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

beforeEach(() => {
  for (const sid of [SID, SID2, CLAUDE_SID]) { try { killPty(sid) } catch { /* none */ } }
  exitAll()
  h.ptys = []; h.built = []; h.sources = []; h.registered = []; h.unregistered = []; h.prepared = []; h.disposed = []
  h.gatewayListening = true; h.hooksInstalled = true; h.exactResult = null; h.wdStarts = []; h.wdFeeds = []; h.failCapture = false
})

describe('a Codex launch and its hooks (rows 43, 46, 47, 63)', () => {
  it('with the Hooks gateway listening: a token minted for the session, its hook file handed to the builder, kept with the session and gone with its resources', () => {
    start(SID)
    expect(h.registered).toEqual([SID])
    expect(h.prepared).toEqual([{ sid: SID, port: 51234, secret: TOKEN }])
    expect(h.built[0].codexHooks).toEqual({ hookFile: `/tmp/ccc-codex-hook-x/${SID}/hook.json` })
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

  it('a hook file the launch could not use (its command not safe on the route) goes at once', () => {
    h.hooksInstalled = false
    start(SID)
    expect(h.disposed).toEqual([SID])
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
})

describe('a hook\'s transcript path: the exact claim (P3.5, P3.6 limits)', () => {
  it('is Codex\'s only: false for a session that is not a Codex one (so the Claude sinks keep it)', () => {
    expect(noteCodexHookTranscript('no-such-session', '/x')).toBe(false)
  })

  it('a Codex session given no hooks: true (no Claude sink), and nothing it says is taken', () => {
    h.gatewayListening = false
    start(SID)
    expect(isCodexPtySession(SID)).toBe(true)
    expect(noteCodexHookTranscript(SID, '/res/codex-realms/a/sessions/2026/09/29/rollout-x.jsonl')).toBe(true)
    expect(source(SID).noteExactRollout).not.toHaveBeenCalled()
  })

  it('handed to the session\'s own watch; the same path again costs a comparison only; other sessions\' inferred claims of it are proved wrong', () => {
    start(SID, 'a')
    start(SID2, 'a')
    const p = '/res/codex-realms/a/sessions/2026/09/29/rollout-2026-09-29T10-00-00-' + ID_A + '.jsonl'
    h.exactResult = { id: ID_A, cwd: '/p' }
    expect(noteCodexHookTranscript(SID, p)).toBe(true)
    expect(source(SID).noteExactRollout).toHaveBeenCalledWith(p)
    expect(source(SID2).refuteInferredClaim).toHaveBeenCalledWith(p)
    expect(source(SID).refuteInferredClaim).not.toHaveBeenCalled()
    noteCodexHookTranscript(SID, p)
    expect(source(SID).noteExactRollout).toHaveBeenCalledTimes(1)
  })

  it('a path the watch refuses changes nothing and proves nothing', () => {
    start(SID, 'a')
    start(SID2, 'a')
    h.exactResult = null
    expect(noteCodexHookTranscript(SID, '/elsewhere/rollout.jsonl')).toBe(true)
    expect(source(SID2).refuteInferredClaim).not.toHaveBeenCalled()
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

  it('an inferred claim in a realm whose hooks are heard from is unconfirmed (never carried); exact, it is', () => {
    start(SID, 'c')
    const onClaim = source(SID).opts.onClaim
    onClaim({ id: ID_A, cwd: '/p', certain: true, exact: false, fromHook: false })
    // No hook heard from the realm yet: P3.6's rules (a certain inferred claim carries).
    expect(getKeptCodexConversationSource(SID)).toMatchObject({ uuid: ID_A, uncertain: false, unconfirmed: false })
    // Another session of the same realm is heard from: the realm's hooks run.
    start(SID2, 'c')
    h.exactResult = { id: ID_B, cwd: '/p' }
    noteCodexHookTranscript(SID2, '/res/codex-realms/c/sessions/2026/09/29/rollout-2026-09-29T10-00-00-' + ID_B + '.jsonl')
    expect(getKeptCodexConversationSource(SID)?.unconfirmed).toBe(true)
    // Its own hook names it: exact.
    onClaim({ id: ID_A, cwd: '/p', certain: true, exact: true, fromHook: true })
    expect(getKeptCodexConversationSource(SID)?.unconfirmed).toBe(false)
  })

  it('a launch without hooks keeps P3.6\'s rules even in a realm whose hooks are heard from', () => {
    start(SID2, 'd')
    h.exactResult = { id: ID_B, cwd: '/p' }
    noteCodexHookTranscript(SID2, '/res/codex-realms/d/sessions/2026/09/29/rollout-2026-09-29T10-00-00-' + ID_B + '.jsonl')
    h.gatewayListening = false
    start(SID, 'd')
    source(SID).opts.onClaim({ id: ID_A, cwd: '/p', certain: true, exact: false, fromHook: false })
    expect(getKeptCodexConversationSource(SID)?.unconfirmed).toBe(false)
  })
})

describe('the C item: a local spawn that throws after its process started', () => {
  it('ends that process, and the throw reaches the caller as before', () => {
    h.failCapture = true
    expect(() => spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)).toThrow(/capture failed/)
    expect(h.ptys.length).toBe(1)
    expect(h.ptys[0].kill).toHaveBeenCalled()
    expect(h.unregistered).toContain(CLAUDE_SID)
  })

  it('a spawn that throws before any process started kills nothing', () => {
    h.failCapture = false
    spawnPty(fakeWin, CLAUDE_SID, { cwd: os.tmpdir() } as never)
    expect(h.ptys[0].kill).not.toHaveBeenCalled()
  })
})
