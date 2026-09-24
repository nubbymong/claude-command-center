// WP1.38 / WP1.46 -- WP2 commit 4 (plan A10): a Codex session's PTY runs only
// from the launch main prepared -- the executable setup proved, the realm's
// environment and its transcript folder -- and holds its account lease for
// exactly as long as its process is the session's: released on a natural
// exit, and on a close, a respawn or a failure only once the killed process
// has ended (never by the replaced PTY's late exit). While pty:spawn is still
// preparing the launch, the spawn is registered with pty-manager: a close, a
// sweep or a newer spawn supersedes it, and the replaced PTY's exit is not
// taken for the end of the session being prepared (ADR-009 pass on commit 4).
//
// Drives the REAL spawnPty and the REAL pty:spawn handler with node-pty, the
// providers and the accounts service mocked (the stack of
// tests/unit/main/canvas-worktree-spawn.test.ts). No process is started.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

interface FakePty { cmd: string; args: string[] | string; env: Record<string, string>; exit: Array<(e: { exitCode: number }) => void>; kill: ReturnType<typeof vi.fn> }
interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void }
const deferred = <T>(): Deferred<T> => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
const h = vi.hoisted(() => ({
  ptys: [] as FakePty[],
  failSpawn: false,
  failTelemetry: false,
  failMeta: false,
  commandLine: undefined as string | undefined,
  built: [] as Array<Record<string, unknown>>,
  telemetry: [] as Array<{ sessionId: string; opts: Record<string, unknown> }>,
  handlers: new Map<string, (...a: any[]) => any>(),
  listeners: new Map<string, (...a: any[]) => any>(),
  prepare: null as null | ((input: Record<string, unknown>) => Promise<unknown>),
  prepareCalls: 0,
  installs: 0,
  credentialLoads: 0,
  legacyInstalled: true,
}))

vi.mock('node-pty', () => ({
  spawn: (cmd: string, args: string[] | string, opts: { env?: Record<string, string> }) => {
    if (h.failSpawn) throw new Error('File not found: ' + cmd)
    const p: FakePty = { cmd, args, env: opts?.env ?? {}, exit: [], kill: vi.fn() }
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
/** Report a fake PTY's process as ended, to every listener node-pty would call. */
const exitPty = (p: FakePty, exitCode = 0) => { for (const cb of [...p.exit]) cb({ exitCode }) }

vi.mock('../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-launch-pty-res-'))
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
vi.mock('../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  registerCodexReviewSession: () => {},
  unregisterCodexReviewSession: () => {},
  disposeCodexReviewUsage: () => {},
}))
vi.mock('../../src/main/providers', () => ({
  getProvider: () => ({
    buildSpawnCommand: (opts: Record<string, unknown>) => {
      // A Claude or shell spawn: the bare shell the local branch writes into.
      if (opts.provider !== 'codex') return { cmd: 'pwsh', args: [], env: {} }
      h.built.push(opts)
      const launch = opts.realmLaunch as { executable: string; env: Record<string, string> } | undefined
      if (!launch) throw new Error('A Codex session needs its account')
      const env = { ...launch.env, CLAUDE_MULTI_SESSION_ID: String(opts.sessionId) }
      return h.commandLine ? { cmd: 'C:/Windows/System32/cmd.exe', args: [], env, commandLine: h.commandLine } : { cmd: launch.executable, args: ['--sandbox', 'read-only'], env }
    },
    ingestSessionTelemetry: (sessionId: string, opts: Record<string, unknown>) => {
      if (h.failTelemetry) throw new Error('telemetry failed')
      h.telemetry.push({ sessionId, opts })
      return { stop: () => {} }
    },
  }),
}))
vi.mock('../../src/main/providers/claude/spawn', () => ({
  resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }),
  resolveHostColorScheme: () => 'dark',
}))
vi.mock('../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null,
  removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => null,
  removeLocalSessionMcpConfig: () => {},
  removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {},
  clearClaudeAccount: () => {},
  getAccountIdentity: () => null,
  pushAccountIdentity: () => {},
  startWatchingAccountIdentity: () => {},
  stopWatchingAccountIdentity: () => {},
  getWatchedProfileId: () => null,
}))
vi.mock('../../src/main/session-registry', () => ({
  updateSessionMeta: () => { if (h.failMeta) throw new Error('meta failed') },
  clearSessionMeta: () => {},
  markPtySessionAlive: () => {},
  markPtySessionGone: () => {},
}))
vi.mock('../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/config-manager')>()),
  readConfig: () => ({}),
  getConfigDir: () => os.tmpdir(),
}))
vi.mock('../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/account-profiles')>()),
  isValidProfileId: () => false,
  getPrimaryProfileId: () => null,
  getProfileConfigDir: () => path.join(os.tmpdir(), 'ccc-no-such-profile'),
  setupProfileLinks: () => {},
  syncPrimaryCredentialsWithGlobal: () => {},
  backupProfileHomeToCanonical: () => {},
}))
vi.mock('../../src/main/legacy-version-manager', () => ({
  isVersionInstalled: () => h.legacyInstalled,
  installVersion: async () => { h.installs++; return { ok: true } },
}))
vi.mock('../../src/main/credential-store', () => ({ loadCredential: () => { h.credentialLoads++; return null } }))
vi.mock('../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    remoteLaunchRefusal: () => ({ ok: false, code: 'unsupported', message: 'Codex runs on this computer only in this release; it is not available in SSH sessions.' }),
    prepareLaunch: (input: Record<string, unknown>) => { h.prepareCalls++; return h.prepare ? h.prepare(input) : Promise.resolve({ ok: false, code: 'not-found', message: 'no account' }) },
  }),
}))

const { spawnPty, killPty, killAllPty, holdsCodexLaunchLease, countUnleasedAgentSessions, beginSpawnPreparation } = await import('../../src/main/pty-manager')
const { registerPtyHandlers } = await import('../../src/main/ipc/pty-handlers')
type Launch = NonNullable<NonNullable<Parameters<typeof spawnPty>[2]>['codexLaunch']>

const SID = 'lh0000000000000000000001'
const sent: string[] = []
let destroyed = false
const fakeWin = { isDestroyed: () => destroyed, webContents: { send: (ch: string) => { sent.push(ch) } } } as unknown as Parameters<typeof spawnPty>[0]
registerPtyHandlers(() => fakeWin as never)
const spawnIpc = (opts: Record<string, unknown>) => h.handlers.get('pty:spawn')!({}, SID, opts)
const killIpc = () => h.listeners.get('pty:kill')!({}, SID)

function launch(tag: string): Launch & { lease: { release: ReturnType<typeof vi.fn> } } {
  return {
    lease: { release: vi.fn() } as never,
    executable: `/proven/${tag}/codex`,
    env: { PATH: '/usr/bin', CODEX_HOME: `/res/codex-realms/${tag}` },
    sessionsDir: `/res/codex-realms/${tag}/sessions`,
  } as never
}
/** What the accounts service returns for a launch it prepared. */
const prepared = (l: Launch) => ({ ok: true, lease: l.lease, binding: {}, realmOnly: false, home: 'h', executable: l.executable, env: l.env, sessionsDir: l.sessionsDir })
const codexOptions = { permissionsPreset: 'read-only' as const }
const codexRequest = { cwd: os.tmpdir(), provider: 'codex', codexOptions }
const start = (l: Launch | undefined) => spawnPty(fakeWin, SID, { cwd: os.tmpdir(), provider: 'codex', codexOptions, codexLaunch: l })
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  try { killPty(SID) } catch { /* nothing running */ }
  h.ptys = []
  h.built = []
  h.telemetry = []
  h.failSpawn = false
  h.failTelemetry = false
  h.failMeta = false
  h.commandLine = undefined
  h.prepare = null
  h.prepareCalls = 0
  h.installs = 0
  h.credentialLoads = 0
  h.legacyInstalled = true
  sent.length = 0
  destroyed = false
})

describe('a Codex PTY runs from its prepared launch (WP1.38)', () => {
  it('without one, nothing is spawned', () => {
    expect(() => start(undefined)).toThrow(/needs its account/)
    expect(h.ptys).toHaveLength(0)
    expect(h.built).toHaveLength(0)
  })

  it('a cmd.exe line from the builder reaches node-pty verbatim, as one string (its per-argument quoting would break the /s form)', () => {
    h.commandLine = '/d /v:off /s /c ""C:/Program Files (x86)/nodejs/codex.cmd" --sandbox read-only"'
    start(launch('a'))
    expect(h.ptys[0].cmd).toBe('C:/Windows/System32/cmd.exe')
    expect(h.ptys[0].args).toBe(h.commandLine)
  })

  it('runs the launch\'s executable in its realm\'s environment, and watches its realm\'s transcripts', () => {
    const l = launch('a')
    start(l)
    expect(h.ptys).toHaveLength(1)
    expect(h.ptys[0].cmd).toBe('/proven/a/codex')
    expect(h.ptys[0].env.CODEX_HOME).toBe('/res/codex-realms/a')
    expect(h.built[0].realmLaunch).toEqual({ executable: l.executable, env: l.env, sessionsDir: l.sessionsDir })
    expect(h.telemetry[0].opts.sessionsDir).toBe('/res/codex-realms/a/sessions')
  })
})

describe('the account lease lives exactly as long as the session\'s process (WP1.46)', () => {
  it('is held while the PTY runs and released once when it exits', () => {
    const l = launch('a')
    start(l)
    expect(holdsCodexLaunchLease(SID, l.lease)).toBe(true)
    expect(l.lease.release).not.toHaveBeenCalled()
    exitPty(h.ptys[0])
    expect(l.lease.release).toHaveBeenCalledTimes(1)
    expect(holdsCodexLaunchLease(SID, l.lease)).toBe(false)
  })

  it('closing the session releases it once the killed process has ended, not before', () => {
    const l = launch('a')
    start(l)
    killPty(SID)
    expect(h.ptys[0].kill).toHaveBeenCalled()
    expect(holdsCodexLaunchLease(SID, l.lease)).toBe(false)
    expect(l.lease.release).not.toHaveBeenCalled()
    exitPty(h.ptys[0])
    expect(l.lease.release).toHaveBeenCalledTimes(1)
  })

  it('a killed process that never reports its exit releases the lease after a bounded grace', () => {
    vi.useFakeTimers()
    try {
      const l = launch('a')
      start(l)
      killPty(SID)
      vi.advanceTimersByTime(5_000)
      expect(l.lease.release).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1_500)
      expect(l.lease.release).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a respawn releases the previous lease when the previous process ends, holds the new one, and the replaced PTY\'s late exit leaves the new lease alone', () => {
    const first = launch('a')
    const second = launch('b')
    start(first)
    start(second)
    expect(holdsCodexLaunchLease(SID, second.lease)).toBe(true)
    expect(first.lease.release).not.toHaveBeenCalled()
    // node-pty reports the replaced PTY's exit asynchronously, after the respawn.
    exitPty(h.ptys[0], 1)
    expect(first.lease.release).toHaveBeenCalledTimes(1)
    expect(second.lease.release).not.toHaveBeenCalled()
    expect(holdsCodexLaunchLease(SID, second.lease)).toBe(true)
    exitPty(h.ptys[1])
    expect(second.lease.release).toHaveBeenCalledTimes(1)
  })

  it('a PTY that fails to start releases its lease and holds nothing', () => {
    const l = launch('a')
    h.failSpawn = true
    expect(() => start(l)).toThrow(/File not found/)
    expect(l.lease.release).toHaveBeenCalledTimes(1)
    expect(holdsCodexLaunchLease(SID, l.lease)).toBe(false)
  })

  it('a failure after the PTY started ends that PTY; its lease goes when its process does', () => {
    const l = launch('a')
    h.failTelemetry = true
    expect(() => start(l)).toThrow(/telemetry failed/)
    expect(h.ptys[0].kill).toHaveBeenCalled()
    expect(holdsCodexLaunchLease(SID, l.lease)).toBe(false)
    exitPty(h.ptys[0], 1)
    expect(l.lease.release).toHaveBeenCalledTimes(1)
  })
})

describe('turning a provider off sees its running and starting sessions (countUnleasedAgentSessions)', () => {
  it('counts an agent\'s PTYs that hold no account lease, and its spawns still waiting to start; never a shell or a leased Codex session', () => {
    const ids = ['cnt-claude', 'cnt-shell', SID]
    try {
      spawnPty(fakeWin, 'cnt-claude', { cwd: os.tmpdir(), provider: 'claude' })
      spawnPty(fakeWin, 'cnt-shell', { cwd: os.tmpdir(), shellOnly: true })
      start(launch('a'))
      expect([countUnleasedAgentSessions('claude'), countUnleasedAgentSessions('codex')]).toEqual([1, 0])
      const waiting = beginSpawnPreparation(fakeWin, 'cnt-wait', 'claude')
      expect(countUnleasedAgentSessions('claude')).toBe(2)
      waiting.abandon()
      expect(countUnleasedAgentSessions('claude')).toBe(1)
    } finally {
      for (const id of ids) { try { killPty(id) } catch { /* gone */ } }
    }
  })
})

describe('pty:spawn while the launch is prepared (ADR-009 pass on commit 4)', () => {
  it('a tab closed during the preparation gets no PTY; the lease is released and the renderer is told the start ended', async () => {
    const d = deferred<unknown>()
    h.prepare = () => d.promise
    const l = launch('a')
    const req = spawnIpc(codexRequest)
    await flush()
    killIpc()
    d.resolve(prepared(l))
    await req
    expect(h.ptys).toHaveLength(0)
    expect(l.lease.release).toHaveBeenCalledTimes(1)
    expect(sent).toContain(`pty:exit:${SID}`)
  })

  it('a sweep of every PTY during the preparation cancels it too', async () => {
    const d = deferred<unknown>()
    h.prepare = () => d.promise
    const l = launch('a')
    const req = spawnIpc(codexRequest)
    await flush()
    killAllPty()
    d.resolve(prepared(l))
    await req
    expect(h.ptys).toHaveLength(0)
    expect(l.lease.release).toHaveBeenCalledTimes(1)
  })

  it('a window gone during the preparation gets no PTY', async () => {
    const d = deferred<unknown>()
    h.prepare = () => d.promise
    const l = launch('a')
    const req = spawnIpc(codexRequest)
    await flush()
    destroyed = true
    d.resolve(prepared(l))
    await req
    expect(h.ptys).toHaveLength(0)
    expect(l.lease.release).toHaveBeenCalledTimes(1)
  })

  it('the newest spawn wins: an older one that finishes preparing later starts nothing and releases its lease', async () => {
    const older = deferred<unknown>()
    const newer = deferred<unknown>()
    const queue = [older, newer]
    h.prepare = () => queue.shift()!.promise
    const a = launch('a')
    const b = launch('b')
    const first = spawnIpc(codexRequest)
    await flush()
    const second = spawnIpc(codexRequest)
    await flush()
    newer.resolve(prepared(b))
    await second
    older.resolve(prepared(a))
    await first
    expect(h.ptys.map((p) => p.cmd)).toEqual(['/proven/b/codex'])
    expect(holdsCodexLaunchLease(SID, b.lease)).toBe(true)
    expect(a.lease.release).toHaveBeenCalledTimes(1)
  })

  it('a Restart: the replaced PTY\'s exit during the preparation is not taken for the end of the new session', async () => {
    const one = launch('a')
    h.prepare = async () => prepared(one)
    await spawnIpc(codexRequest)
    expect(h.ptys).toHaveLength(1)
    const d = deferred<unknown>()
    h.prepare = () => d.promise
    killIpc()
    const two = launch('b')
    const req = spawnIpc(codexRequest)
    await flush()
    sent.length = 0
    exitPty(h.ptys[0], 1)
    expect(sent).not.toContain(`pty:exit:${SID}`)
    d.resolve(prepared(two))
    await req
    expect(h.ptys).toHaveLength(2)
    expect(holdsCodexLaunchLease(SID, two.lease)).toBe(true)
    expect(sent).not.toContain(`pty:exit:${SID}`)
  })

  it('a refused preparation after a Restart ends the replaced session once, and holds nothing', async () => {
    const one = launch('a')
    h.prepare = async () => prepared(one)
    await spawnIpc(codexRequest)
    const d = deferred<unknown>()
    h.prepare = () => d.promise
    killIpc()
    const req = spawnIpc(codexRequest)
    await flush()
    sent.length = 0
    exitPty(h.ptys[0], 1)
    d.resolve({ ok: false, code: 'lifecycle', message: 'This account is not active.' })
    await expect(req).rejects.toThrow(/Codex session refused/)
    expect(sent.filter((c) => c === `pty:exit:${SID}`)).toHaveLength(1)
  })

  it('a spawn that fails after its PTY registered ends that PTY rather than leave it running unheld', async () => {
    const l = launch('a')
    h.prepare = async () => prepared(l)
    h.failMeta = true
    await expect(spawnIpc(codexRequest)).rejects.toThrow(/meta failed/)
    expect(h.ptys[0].kill).toHaveBeenCalled()
    expect(holdsCodexLaunchLease(SID, l.lease)).toBe(false)
    exitPty(h.ptys[0], 1)
    expect(l.lease.release).toHaveBeenCalledTimes(1)
  })

  it('Codex over SSH, shell-only or not, is refused before any install, credential or preparation', async () => {
    h.legacyInstalled = false
    const ssh = { host: 'example.com', port: 22, username: 'u', remotePath: '/w' }
    for (const shellOnly of [false, true]) {
      await expect(spawnIpc({ ...codexRequest, ssh, shellOnly, configId: 'cfg1', legacyVersion: { enabled: true, version: '2.1.0' } })).rejects.toThrow(/this computer only/)
    }
    expect([h.installs, h.credentialLoads, h.prepareCalls, h.ptys.length]).toEqual([0, 0, 0, 0])
  })
})
