/**
 * P3.13, PR-level ADR-009 round 1 (B1): a spawn of a session id that was
 * cancelled or superseded while it prepared (a pty:kill, a newer Restart) no
 * longer counts toward the pending spawns one id may hold. Restart pressed
 * again and again while a Codex account preparation is slow ends with the
 * session live, never with a refusal ("already running") or Not started.
 *
 * Driven through the REAL pty:spawn and pty:kill handlers and the REAL
 * one-at-a-time rule (src/main/launch-one-at-a-time.ts); only pty-manager is
 * faked, and its preparations as pty-manager makes them: one current per
 * session id, superseded by a newer one and cancelled by a kill. Nothing
 * spawns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  BrowserWindow: class {},
}))
const live = new Set<string>()
/** The current preparation of each session id (a newer one supersedes it, a kill cancels it). */
const current = new Map<string, symbol>()
const spawned: string[] = []
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: (_w: unknown, sid: string) => { live.add(sid); spawned.push(sid) },
  writePty: vi.fn(), resizePty: vi.fn(),
  killPty: (id: string) => { live.delete(id); current.delete(id) },
  getSshFlow: () => undefined, endSshRemote: vi.fn(),
  beginSpawnPreparation: (_w: unknown, sid: string) => {
    const me = Symbol('preparation')
    current.set(sid, me)
    return {
      get current() { return current.get(sid) === me },
      spawn: () => {
        if (current.get(sid) !== me) throw new Error('this spawn was cancelled or superseded while it was prepared')
        current.delete(sid)
        live.add(sid)
        spawned.push(sid)
      },
      abandon: () => { if (current.get(sid) === me) current.delete(sid) },
    }
  },
  holdsCodexLaunchLease: () => false, codexLaunchLeaseTaken: () => false,
  isSessionWritable: (id: string) => live.has(id),
  isSessionLiveOrStarting: (id: string) => live.has(id) || current.has(id),
  getKeptCodexConversationSource: () => undefined,
  getKeptCodexConversation: () => undefined,
  codexRunEnded: async () => true,
  codexConversationHeldElsewhere: () => false,
  uncertainCodexConversationIds: () => [],
  rememberUncertainCodexConversationsFrom: () => {},
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
let configsOnDisk: unknown = null
vi.mock('../../../src/main/config-manager', () => ({ readConfig: (key: string) => (key === 'configs' ? configsOnDisk : null) }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
vi.mock('../../../src/main/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/hooks')>()),
  getGateway: () => null,
  isExactBindSourceActive: () => true,
}))
const prep = vi.hoisted(() => ({ gate: null as null | Promise<void> }))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: () => null,
    remoteLaunchRefusal: () => null,
    prepareLaunch: async () => {
      if (prep.gate) await prep.gate
      return { ok: true, lease: { accountId: 'acct-1', release: vi.fn() }, binding: {}, realmOnly: false, home: 'C:/res/r1', executable: 'C:/proven/codex.exe', env: {}, sessionsDir: 'C:/res/r1/sessions' }
    },
    carryConversation: async () => null,
  }),
}))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
const { _resetConfigLaunchClaimsForTest, _claimedSessionCountForTest } = await import('../../../src/main/launch-one-at-a-time')
registerPtyHandlers(() => ({} as never))
const spawn = handlers.get('pty:spawn')!
const kill = handlers.get('pty:kill')!

const S = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const OTHER = 'b1b2c3d4e5f6a1b2c3d4e5f6'
const codexReq = { cwd: 'C:/w', provider: 'codex', codexOptions: { permissionsPreset: 'standard' }, configId: 'cfgcodex' }
const outcome = async (p: unknown): Promise<string> => {
  try {
    const r = await p as { refused?: { code?: string }; started?: boolean } | undefined
    return r?.refused?.code ?? (r?.started === false ? 'not-started' : 'started')
  } catch (e) {
    return `threw: ${(e as Error).message}`
  }
}

beforeEach(() => {
  live.clear(); current.clear(); spawned.length = 0; prep.gate = null
  configsOnDisk = [{ id: 'cfgcodex', label: 'Codex Dev', provider: 'codex', sessionType: 'local', workingDirectory: 'C:/w' }]
  _resetConfigLaunchClaimsForTest()
})

describe('a Restart pressed again and again while a Codex preparation is slow (PR-level ADR-009 round 1, B1)', () => {
  it('ten Restarts: the last starts the session, none is refused as already running; the ones it superseded start nothing', async () => {
    let release!: () => void
    prep.gate = new Promise<void>((r) => { release = r })
    const calls: Array<Promise<string>> = []
    for (let i = 0; i < 10; i++) {
      if (i > 0) kill({}, S, 'restart')
      calls.push(outcome(spawn({}, S, codexReq)))
    }
    await new Promise((r) => setTimeout(r, 10))
    // Only the current spawn is pending: the nine it superseded count for nothing.
    expect(_claimedSessionCountForTest()).toBe(1)
    release()
    const results = await Promise.all(calls)
    expect(results.filter((r) => r === 'already-running')).toEqual([])
    expect(results.at(-1)).toBe('started')
    expect(results.slice(0, -1).every((r) => r === 'not-started')).toBe(true)
    expect(live.has(S)).toBe(true)
    expect(spawned).toEqual([S])
    // The rule still holds afterwards: a new tab of the config is refused, the session's own Restart is not.
    expect(await outcome(spawn({}, OTHER, codexReq))).toBe('already-running')
    kill({}, S, 'restart')
    expect(await outcome(spawn({}, S, codexReq))).toBe('started')
  })

  it('a spawn cancelled by a close while it prepared counts for nothing at once, before its preparation ends', async () => {
    let release!: () => void
    prep.gate = new Promise<void>((r) => { release = r })
    const first = outcome(spawn({}, S, codexReq))
    await Promise.resolve()
    expect(_claimedSessionCountForTest()).toBe(1)
    kill({}, S)
    // A new tab of the config while the closed one's preparation still runs is not a second copy.
    const second = outcome(spawn({}, OTHER, codexReq))
    await new Promise((r) => setTimeout(r, 10))
    release()
    expect(await first).toBe('not-started')
    expect(await second).toBe('started')
    expect(live.has(OTHER)).toBe(true)
    expect(live.has(S)).toBe(false)
  })
})
