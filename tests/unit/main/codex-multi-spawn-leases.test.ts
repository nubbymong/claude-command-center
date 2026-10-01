/**
 * P3.13 (row 72): N copies of a Multi Spawn Codex config, one lease each, and
 * one copy at a time for a config that is not Multi Spawn, on the REAL
 * pty:spawn handler, the REAL pty-manager and a REAL consumer-lease registry
 * (the one the accounts service takes a session's account lease from). Only
 * node-pty, the providers' command builders and the accounts service's
 * preparation are faked, so no process starts; the stack is
 * tests/wp1/launch-handoff-pty.test.ts's.
 *
 * What the faked preparation does is what the real one does at the registry:
 * one lease per (session, owner id) on the chosen account, released by the
 * session's own process ending. The rule under test is main's, at pty:spawn
 * (src/main/launch-one-at-a-time.ts); the renderer's half of the same rule is
 * tests/unit/renderer/multi-spawn-codex.test.tsx.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { ConsumerLeaseRegistry } from '../../../src/main/providers/core/consumer-leases'

interface FakePty { cmd: string; env: Record<string, string>; exit: Array<(e: { exitCode: number }) => void>; kill: ReturnType<typeof vi.fn> }
interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void }
const deferred = <T>(): Deferred<T> => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
const h = vi.hoisted(() => ({
  ptys: [] as FakePty[],
  handlers: new Map<string, (...a: any[]) => any>(),
  listeners: new Map<string, (...a: any[]) => any>(),
  configs: [] as unknown[],
  prepared: [] as Array<{ ownerId: string; sessionId: string; providerAccountId?: string }>,
  prepareGate: null as null | Promise<void>,
  /** The resources folder the setup-handlers mock made (this file's own mkdtemp). */
  resDir: '',
}))

vi.mock('node-pty', () => ({
  spawn: (cmd: string, _args: string[] | string, opts: { env?: Record<string, string> }) => {
    const p: FakePty = { cmd, env: opts?.env ?? {}, exit: [], kill: vi.fn() }
    h.ptys.push(p)
    return {
      pid: 4000 + h.ptys.length,
      process: 'codex',
      onData: () => ({ dispose: () => {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => { p.exit.push(cb); return { dispose: () => {} } },
      write: () => {},
      resize: () => {},
      kill: p.kill,
    }
  },
}))
/** Report a fake PTY's process as ended, as node-pty would. */
const exitPty = (p: FakePty, exitCode = 0) => { for (const cb of [...p.exit]) cb({ exitCode }) }

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-multi-spawn-res-'))
  h.resDir = dir
  return { getResourcesDirectory: () => dir, getDataDirectory: () => dir, registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }
})
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), on: () => {}, quit: () => {} },
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => { h.handlers.set(ch, fn) }, on: (ch: string, fn: (...a: any[]) => any) => { h.listeners.set(ch, fn) } },
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
  disposeCodexReviewUsage: () => {},
}))
vi.mock('../../../src/main/providers', () => ({
  getProvider: () => ({
    buildSpawnCommand: (opts: Record<string, unknown>) => {
      if (opts.provider !== 'codex') return { cmd: 'pwsh', args: [], env: {} }
      const launch = opts.realmLaunch as { executable: string; env: Record<string, string> } | undefined
      if (!launch) throw new Error('A session needs its account')
      return { cmd: launch.executable, args: ['--sandbox', 'read-only'], env: { ...launch.env, CLAUDE_MULTI_SESSION_ID: String(opts.sessionId) } }
    },
    prepareSessionHooks: () => null,
    ingestSessionTelemetry: () => ({ stop: () => {} }),
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
  readConfig: (key: string) => (key === 'configs' ? h.configs : {}),
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

// The accounts service's launch preparation, at the real lease registry: one
// lease per (session, owner id) on the account chosen, which the session's
// process holds until it ends.
const registry = new ConsumerLeaseRegistry()
const ACCOUNT = 'acct-work'
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: () => null,
    remoteLaunchRefusal: () => ({ ok: false, code: 'unsupported', message: 'Codex runs on this computer only in this release; it is not available in SSH sessions.' }),
    prepareLaunch: async (input: { ownerId: string; sessionId: string; providerAccountId?: string }) => {
      h.prepared.push({ ownerId: input.ownerId, sessionId: input.sessionId, providerAccountId: input.providerAccountId })
      if (h.prepareGate) await h.prepareGate
      const added = registry.add(input.providerAccountId ?? ACCOUNT, 'codex', { kind: 'session', ownerId: input.ownerId, sessionId: input.sessionId })
      if (!added.ok) return { ok: false, code: added.code, message: 'held' }
      return { ok: true, lease: added.lease, binding: {}, realmOnly: false, home: 'h', executable: '/proven/codex', env: { PATH: '/usr/bin', CODEX_HOME: '/res/realm' }, sessionsDir: '/res/realm/sessions' }
    },
    carryConversation: async () => ({ ok: true, carried: 'none' }),
  }),
}))

const { killPty, killAllPty, holdsCodexLaunchLease, isSessionLiveOrStarting } = await import('../../../src/main/pty-manager')
const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
const { _resetConfigLaunchClaimsForTest, seedRestoredSessions } = await import('../../../src/main/launch-one-at-a-time')

const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } }
registerPtyHandlers(() => fakeWin as never)
const spawnAs = (id: string, over: Record<string, unknown> = {}) =>
  h.handlers.get('pty:spawn')!({}, id, { cwd: os.tmpdir(), provider: 'codex', codexOptions: { permissionsPreset: 'read-only' }, configId: 'cfgcodex', ...over })
const closeTab = (id: string) => h.listeners.get('pty:kill')!({}, id)
const flush = () => new Promise((r) => setTimeout(r, 0))

const S1 = 'mc0000000000000000000001'
const S2 = 'mc0000000000000000000002'
const S3 = 'mc0000000000000000000003'
const ALL = [S1, S2, S3]
const savedConfig = (over: Record<string, unknown> = {}) => ({ id: 'cfgcodex', label: 'Codex Dev', provider: 'codex', sessionType: 'local', workingDirectory: os.tmpdir(), ...over })
const STARTED = { started: true, launched: { codexPreset: 'read-only' } }
const holders = () => registry.sessionsHolding(ACCOUNT).sort()

// The one folder this file made (its mkdtemp, in the setup-handlers mock) goes with it: only a
// path of that prefix, directly under the temp folder, is ever removed.
afterAll(() => {
  const dir = h.resDir
  if (!dir) return
  if (path.basename(dir).startsWith('ccc-multi-spawn-res-') && path.resolve(path.dirname(dir)) === path.resolve(os.tmpdir())) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

beforeEach(() => {
  for (const id of ALL) { try { killPty(id) } catch { /* nothing running */ } }
  // Every process of the last test has ended by the next.
  for (const p of h.ptys) exitPty(p, 0)
  h.ptys = []
  h.prepared = []
  h.prepareGate = null
  h.configs = [savedConfig()]
  _resetConfigLaunchClaimsForTest()
})

describe('N copies of a Multi Spawn Codex config, one lease each', () => {
  beforeEach(() => { h.configs = [savedConfig({ allowMultiSpawn: true })] })

  it('three copies are three processes, each on its own lease of the account', async () => {
    for (const id of ALL) expect(await spawnAs(id)).toEqual(STARTED)
    expect(h.ptys).toHaveLength(3)
    expect(registry.countKind(ACCOUNT, 'session')).toBe(3)
    expect(registry.runningSessions(ACCOUNT)).toBe(3)
    expect(holders()).toEqual([...ALL].sort())
    // Each asked for its own lease: no owner id is shared.
    expect(new Set(h.prepared.map((p) => p.ownerId)).size).toBe(3)
    expect(h.prepared.map((p) => p.sessionId)).toEqual(ALL)
  })

  it('each copy holds its own lease in the process manager, and no other copy\'s', async () => {
    const leases = new Map<string, unknown>()
    const real = registry.add.bind(registry)
    const spy = vi.spyOn(registry, 'add').mockImplementation((acct, prov, owner) => {
      const r = real(acct, prov, owner)
      if (r.ok && owner.sessionId) leases.set(owner.sessionId, r.lease)
      return r
    })
    try {
      for (const id of ALL) await spawnAs(id)
      for (const id of ALL) {
        for (const other of ALL) expect(holdsCodexLaunchLease(id, leases.get(other) as never), `${id} holds ${other}'s`).toBe(id === other)
      }
    } finally { spy.mockRestore() }
  })

  it('one copy ending lets go of its own lease only: the others keep theirs', async () => {
    for (const id of ALL) await spawnAs(id)
    exitPty(h.ptys[1])
    expect(registry.runningSessions(ACCOUNT)).toBe(2)
    expect(holders()).toEqual([S1, S3].sort())
    exitPty(h.ptys[0])
    exitPty(h.ptys[2])
    expect(registry.count(ACCOUNT)).toBe(0)
  })

  it('closing a copy lets go of its lease once its process has ended, and no sooner', async () => {
    for (const id of ALL) await spawnAs(id)
    closeTab(S2)
    expect(h.ptys[1].kill).toHaveBeenCalled()
    expect(registry.runningSessions(ACCOUNT)).toBe(3)
    exitPty(h.ptys[1])
    expect(registry.runningSessions(ACCOUNT)).toBe(2)
    expect(h.ptys[0].kill).not.toHaveBeenCalled()
    expect(h.ptys[2].kill).not.toHaveBeenCalled()
  })

  it('a Restart of one copy replaces that copy\'s process and lease, and adds none', async () => {
    for (const id of ALL) await spawnAs(id)
    expect(await spawnAs(S2)).toEqual(STARTED)
    // The old process is still winding down, holding its lease until it ends.
    expect(registry.runningSessions(ACCOUNT)).toBe(4)
    exitPty(h.ptys[1])
    expect(registry.runningSessions(ACCOUNT)).toBe(3)
    expect(holders()).toEqual([...ALL].sort())
  })

  it('Multi Spawn unticked while the copies run: a Restart and a Switch of one copy start, each on a lease of its own, and a new copy is refused', async () => {
    for (const id of ALL) await spawnAs(id)
    h.configs = [savedConfig({ allowMultiSpawn: false })]
    expect(await spawnAs(S1)).toEqual(STARTED) // Restart: the copy's own process is replaced
    expect(await spawnAs(S1, { providerAccountId: 'acct-b' })).toEqual(STARTED) // Switch account
    expect(await spawnAs('mc0000000000000000000004')).toMatchObject({ started: false, refused: { code: 'already-running' } })
    expect(h.ptys).toHaveLength(5)
    // The two replaced processes let go of their leases once they have ended.
    exitPty(h.ptys[0])
    exitPty(h.ptys[3])
    expect(registry.runningSessions(ACCOUNT)).toBe(2)
    expect(holders()).toEqual([S2, S3].sort())
    expect(registry.runningSessions('acct-b')).toBe(1)
  })

  it('the whole set can be swept: every lease is let go as its process ends', async () => {
    for (const id of ALL) await spawnAs(id)
    killAllPty()
    for (const p of h.ptys) exitPty(p)
    expect(registry.count(ACCOUNT)).toBe(0)
  })

  it('copies spread over accounts are leased on the account each names', async () => {
    await spawnAs(S1, { providerAccountId: 'acct-a' })
    await spawnAs(S2, { providerAccountId: 'acct-a' })
    await spawnAs(S3, { providerAccountId: 'acct-b' })
    expect([registry.runningSessions('acct-a'), registry.runningSessions('acct-b')]).toEqual([2, 1])
    for (const p of h.ptys) exitPty(p)
    expect([registry.count('acct-a'), registry.count('acct-b')]).toEqual([0, 0])
  })
})

describe('a config that is not Multi Spawn: one process, one lease', () => {
  for (const flag of [undefined, false] as const) {
    it(`${flag === undefined ? 'never chosen' : 'declined'}: the second copy is refused and takes no lease`, async () => {
      h.configs = [savedConfig(flag === undefined ? {} : { allowMultiSpawn: flag })]
      expect(await spawnAs(S1)).toEqual(STARTED)
      const refused = await spawnAs(S2)
      expect(refused).toMatchObject({ started: false, refused: { code: 'already-running', providerId: 'codex' } })
      expect(h.ptys).toHaveLength(1)
      expect(h.prepared).toHaveLength(1)
      expect(registry.count(ACCOUNT)).toBe(1)
      expect(holders()).toEqual([S1])
      // The running copy is untouched by the refusal.
      expect(h.ptys[0].kill).not.toHaveBeenCalled()
    })
  }

  it('a copy asked for while the first is still preparing its account is refused: still one lease', async () => {
    const gate = deferred<void>()
    h.prepareGate = gate.promise
    const first = spawnAs(S1)
    await flush()
    expect(isSessionLiveOrStarting(S1)).toBe(true)
    const second = spawnAs(S2)
    // Answered at once, not after the first has finished preparing.
    const answered = await Promise.race([second, new Promise((r) => setTimeout(() => r('still preparing'), 100))])
    expect(answered).toMatchObject({ started: false, refused: { code: 'already-running' } })
    expect(h.prepared).toHaveLength(1)
    gate.resolve()
    expect(await first).toEqual(STARTED)
    await second
    expect(registry.count(ACCOUNT)).toBe(1)
    expect(h.ptys).toHaveLength(1)
  })

  it('a first copy whose tab was closed while it was preparing leaves the config free', async () => {
    const gate = deferred<void>()
    h.prepareGate = gate.promise
    const first = spawnAs(S1)
    await flush()
    closeTab(S1)
    gate.resolve()
    expect(await first).toEqual({ started: false })
    expect(h.ptys).toHaveLength(0)
    expect(registry.count(ACCOUNT)).toBe(0)
    h.prepareGate = null
    expect(await spawnAs(S2)).toEqual(STARTED)
  })

  it('once the copy has ended, and again once it was closed, another starts', async () => {
    expect(await spawnAs(S1)).toEqual(STARTED)
    exitPty(h.ptys[0]) // it ended by itself
    expect(isSessionLiveOrStarting(S1)).toBe(false)
    expect(await spawnAs(S2)).toEqual(STARTED)
    closeTab(S2)
    expect(await spawnAs(S3)).toEqual(STARTED)
    // The closed copy's process is winding down, so its lease is still held
    // beside the new copy's own: one lease each, never a shared one.
    expect(registry.runningSessions(ACCOUNT)).toBe(2)
    exitPty(h.ptys[1])
    expect(holders()).toEqual([S3])
  })

  it('a Restart of the running copy is not a second copy', async () => {
    expect(await spawnAs(S1)).toEqual(STARTED)
    expect(await spawnAs(S1)).toEqual(STARTED)
    exitPty(h.ptys[0]) // the replaced process ends
    expect(registry.runningSessions(ACCOUNT)).toBe(1)
    expect(h.ptys).toHaveLength(2)
  })

  it('its partner terminal is a shell, not a copy', async () => {
    expect(await spawnAs(S1)).toEqual(STARTED)
    expect(await spawnAs(`${S1}-partner`, { provider: undefined, codexOptions: undefined, shellOnly: true })).not.toMatchObject({ refused: expect.anything() })
    expect(h.ptys).toHaveLength(2)
    expect(registry.count(ACCOUNT)).toBe(1)
  })
})

describe('restored copies keep their right to run', () => {
  it('two restored copies of a declined config start, each on its own lease; a new copy is refused and takes none', async () => {
    h.configs = [savedConfig({ allowMultiSpawn: false })]
    seedRestoredSessions({ sessions: [{ id: S1, configId: 'cfgcodex' }, { id: S2, configId: 'cfgcodex' }] })
    expect(await spawnAs(S1)).toEqual(STARTED)
    expect(await spawnAs(S2)).toEqual(STARTED)
    expect(registry.runningSessions(ACCOUNT)).toBe(2)
    expect(await spawnAs(S3)).toMatchObject({ started: false, refused: { code: 'already-running' } })
    expect(h.prepared).toHaveLength(2)
    expect(holders()).toEqual([S1, S2].sort())
  })
})

describe('isSessionLiveOrStarting', () => {
  it('is true from the moment main accepts a spawn until its process is gone, and false for an id main never saw', async () => {
    expect(isSessionLiveOrStarting('never-seen')).toBe(false)
    const gate = deferred<void>()
    h.prepareGate = gate.promise
    const p = spawnAs(S1)
    await flush()
    expect(isSessionLiveOrStarting(S1)).toBe(true) // preparing
    gate.resolve()
    await p
    expect(isSessionLiveOrStarting(S1)).toBe(true) // running
    closeTab(S1)
    expect(isSessionLiveOrStarting(S1)).toBe(false)
  })
})
