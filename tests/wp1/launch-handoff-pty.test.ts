// WP1.38 / WP1.46 -- WP2 commit 4 (plan A10): a Codex session's PTY runs only
// from the launch main prepared -- the executable setup proved, the realm's
// environment and its transcript folder -- and holds its account lease for
// exactly as long as its process is the session's: released on a natural
// exit, and on a close, a respawn or a failure only once the killed process
// has ended (never by the replaced PTY's late exit). While pty:spawn is still
// preparing the launch, the spawn is registered with pty-manager: a close, a
// sweep or a newer spawn supersedes it, and the replaced PTY's exit is not
// taken for the end of the session being prepared (ADR-009 pass on commit 4).
// P3.6 (row 22): a respawn on another account carries the conversation this
// session is on into it, from main's own record of this session, once the
// old process has ended: kill, carry, spawn (ADR-009 thesis 3).
//
// Drives the REAL spawnPty and the REAL pty:spawn handler with node-pty, the
// providers and the accounts service mocked (the stack of
// tests/unit/main/canvas-worktree-spawn.test.ts). No process is started.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
  carry: null as null | ((...a: unknown[]) => Promise<unknown>),
  realWatch: false,
  watchFn: null as null | ((...a: any[]) => { stop: () => void }),
  watchers: [] as Array<{ stop: () => void }>,
  carries: [] as unknown[][],
  resumable: false,
  // P3.6 VM finding V2: the pick file a picker launch is given (and its folder).
  pickFile: null as string | null,
  pickFolder: null as unknown,
  installs: 0,
  credentialLoads: 0,
  legacyInstalled: true,
  claudeReview: [] as Array<{ sid: string; cwd: string }>,
  ptyCwds: [] as string[],
  /** P3.10: a Hooks gateway listening (none: the gateway is off). */
  gateway: null as null | Record<string, unknown>,
}))

vi.mock('node-pty', () => ({
  spawn: (cmd: string, args: string[] | string, opts: { env?: Record<string, string>; cwd?: string }) => {
    if (h.failSpawn) throw new Error('File not found: ' + cmd)
    h.ptyCwds.push(opts?.cwd ?? '')
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
  registerClaudeReviewSession: (sid: string, cwd: string) => { h.claudeReview.push({ sid, cwd }) },
  unregisterCodexReviewSession: () => {},
  releaseMcpSessionProvider: () => {},
  disposeCodexReviewUsage: () => {},
}))
vi.mock('../../src/main/providers', () => ({
  getProvider: () => ({
    resolveBinary: () => ({ cmd: 'claude', source: 'system' }), // WP2 PR 4: the local launch resolves Claude through the provider
    buildSpawnCommand: (opts: Record<string, unknown>) => {
      // A Claude or shell spawn: the bare shell the local branch writes into.
      if (opts.provider !== 'codex') return { cmd: 'pwsh', args: [], env: {} }
      h.built.push(opts)
      const launch = opts.realmLaunch as { executable: string; env: Record<string, string> } | undefined
      if (!launch) throw new Error('A Codex session needs its account')
      const env = { ...launch.env, CLAUDE_MULTI_SESSION_ID: String(opts.sessionId) }
      // P3.6: the realm holds the conversation asked for (the resume finds it).
      const resume = opts.resume as { uuid: string } | undefined
      const found = h.resumable && resume ? { resumeId: resume.uuid } : opts.useResumePicker && h.pickFile ? { pickFile: h.pickFile, pickFolder: h.pickFolder } : {}
      // P3.10: a launch handed a hook file carries the app's hooks.
      const hooks = opts.codexHooks ? { hooksInstalled: true } : {}
      return h.commandLine ? { cmd: 'C:/Windows/System32/cmd.exe', args: [], env, commandLine: h.commandLine, ...found, ...hooks } : { cmd: launch.executable, args: ['--sandbox', 'read-only'], env, ...found, ...hooks }
    },
    prepareSessionHooks: (sid: string) => (h.gateway ? { hookFile: `/tmp/ccc-codex-hook-t/${sid}/hook.json`, dispose: () => {} } : null),
    ingestSessionTelemetry: (sessionId: string, opts: Record<string, unknown>) => {
      if (h.failTelemetry) throw new Error('telemetry failed')
      h.telemetry.push({ sessionId, opts })
      // P3.6: the real watcher, for the claim race (real folders under the
      // system temp folder; no Codex process).
      if (h.realWatch && h.watchFn) {
        const o = opts as { cwd: string; spawnTimestamp: number; sessionsDir: string; resumeId?: string; resumePath?: string; pickFile?: string; pickFolder?: unknown; onClaim?: (c: unknown) => void; onRelease?: () => void; onShared?: (c: unknown) => void }
        const w = h.watchFn(sessionId, o.cwd, o.spawnTimestamp, () => {}, o.sessionsDir, undefined, { resumeId: o.resumeId, resumePath: o.resumePath, pickFile: o.pickFile, pickFolder: o.pickFolder, onClaim: o.onClaim, onRelease: o.onRelease, onShared: o.onShared })
        h.watchers.push(w)
        return w
      }
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
vi.mock('../../src/main/hooks', () => ({ getGateway: () => h.gateway, isExactBindSourceActive: () => true }))
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
    // Every provider is on here (main's launch rule, provider-launch-gate.ts).
    launchRefusal: () => null,
    remoteLaunchRefusal: () => ({ ok: false, code: 'unsupported', message: 'Codex runs on this computer only in this release; it is not available in SSH sessions.' }),
    prepareLaunch: (input: Record<string, unknown>) => { h.prepareCalls++; return h.prepare ? h.prepare(input) : Promise.resolve({ ok: false, code: 'not-found', message: 'no account' }) },
    carryConversation: (...a: unknown[]) => { h.carries.push(a); return h.carry ? h.carry(...a) : Promise.resolve({ ok: true, carried: 'copied' }) },
  }),
}))

const { spawnPty, killPty, killAllPty, holdsCodexLaunchLease, countUnleasedAgentSessions, beginSpawnPreparation, CODEX_LEASE_EXIT_GRACE_MS, codexRunEnded, rememberUncertainCodexConversationsFrom, getKeptCodexConversation, noteCodexHookTranscript } = await import('../../src/main/pty-manager')
h.watchFn = (await import('../../src/main/providers/codex/telemetry')).watchAndClaimRollout as never
const { codexDayFolders, codexFolderIdentity } = await import('../../src/main/providers/codex/rollout-lookup')
const { registerPtyHandlers, CODEX_CARRY_EXIT_WAIT_MS, CODEX_CARRY_TIMEOUT_MS } = await import('../../src/main/ipc/pty-handlers')
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
/** P3.8 round 3 (PB1): a started Codex spawn reports the preset it launched
 *  with; with no carry note it says nothing else. */
const STARTED = { started: true, launched: { codexPreset: 'read-only' as const } }
const codexRequest = { cwd: os.tmpdir(), provider: 'codex', codexOptions }
const start = (l: Launch | undefined) => spawnPty(fakeWin, SID, { cwd: os.tmpdir(), provider: 'codex', codexOptions, codexLaunch: l })
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  try { killPty(SID) } catch { /* nothing running */ }
  // Every process of the last test has ended by the next (a killed one's end
  // is what a respawn's carry waits for).
  for (const p of h.ptys) exitPty(p, 0)
  h.ptys = []
  h.built = []
  h.telemetry = []
  h.failSpawn = false
  h.failTelemetry = false
  h.failMeta = false
  h.commandLine = undefined
  h.prepare = null
  h.prepareCalls = 0
  h.carry = null
  h.carries = []
  h.resumable = false
  h.installs = 0
  h.credentialLoads = 0
  h.legacyInstalled = true
  h.claudeReview = []
  h.ptyCwds = []
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
    // WP2 commit 6: and the request says it started nothing, so a renderer
    // holding exits while its spawn is in flight knows to apply this one.
    await expect(req).resolves.toEqual({ started: false })
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
    // The window survives a sweep when the update installer fails to launch:
    // the view whose preparation was swept learns its start ended from this.
    await expect(req).resolves.toEqual({ started: false })
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

// WP2 commit 5b: a local Codex session may ask for a Claude review of the
// project its PTY runs in; never of home or anything above it (#188).
describe('a Codex session registers for claude_review (WP2 5b)', () => {
  it('with the directory its PTY started in, once it is running', () => {
    start(launch('a'))
    expect(h.claudeReview).toEqual([{ sid: SID, cwd: h.ptyCwds[0] }])
    expect(h.ptyCwds[0]).toBeTruthy()
  })

  it('not when that directory is the home folder or above it, nor when the spawn fails', () => {
    spawnPty(fakeWin, SID, { cwd: path.parse(os.homedir()).root, provider: 'codex', codexOptions, codexLaunch: launch('b') })
    expect(h.ptys).toHaveLength(1)
    expect(h.claudeReview).toEqual([])
    h.failSpawn = true
    expect(() => start(launch('c'))).toThrow()
    expect(h.claudeReview).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// P3.6 (row 22; quality round 1, item 2; ADR-009 thesis 3): a Switch account
// restarts the session on the new account; main's respawn of THAT session
// carries the conversation it is on into the new account -- from main's own
// record of the session, once the old process has ended -- and the launch
// then resumes it there by id (P3.5).
// ---------------------------------------------------------------------------

describe('a respawn on another account carries this session\'s conversation (P3.6)', () => {
  // A new pair of session ids per test: the kept conversation outlives a
  // kill by design, so one test's would be the next test's to carry.
  let seq = 0
  let sid = ''
  let sid2 = ''
  beforeEach(() => { seq++; sid = `lh-p36-${seq}-a`; sid2 = `lh-p36-${seq}-b` })
  const CID = '019dd000-0006-7000-8000-0000000000c1'
  const OTHER = '019dd000-0006-7000-8000-0000000000c2'
  const on = (tag: string, accountId: string, sessionsDir?: string) => {
    const l = launch(tag)
    ;(l.lease as unknown as { accountId: string }).accountId = accountId
    if (sessionsDir) (l as unknown as { sessionsDir: string }).sessionsDir = sessionsDir
    return l
  }
  const spawnFor = (id: string, opts: Record<string, unknown>) => h.handlers.get('pty:spawn')!({}, id, opts)
  const spawnIn = (opts: Record<string, unknown>) => spawnFor(sid, opts)
  const killIn = () => h.listeners.get('pty:kill')!({}, sid)
  const killPtyFor = (id: string) => h.listeners.get('pty:kill')!({}, id)
  const claim = (of: string, id: string, cwd = '/p/demo') => {
    const t = [...h.telemetry].reverse().find((x) => x.sessionId === of)!
    // A claim the watcher was certain of (P3.6): the case these tests are about.
    ;(t.opts.onClaim as (c: { id: string; cwd: string; certain: boolean }) => void)({ id, cwd, certain: true })
  }
  const onAccount = (accountId: string) => { h.prepare = async () => prepared(on(accountId, accountId)) }
  const request = (accountId: string, extra: Record<string, unknown> = {}) => ({ ...codexRequest, providerAccountId: accountId, ...extra })
  afterEach(() => { for (const id of [sid, sid2]) { try { killPty(id) } catch { /* not running */ } } })

  it('kill, carry, spawn: the copy starts only once the old process has ended; the new launch then resumes the conversation, and says nothing', async () => {
    onAccount('acct-a')
    await spawnIn(request('acct-a'))
    claim(sid, CID)
    killIn()
    onAccount('acct-b')
    h.resumable = true
    const req = spawnIn(request('acct-b'))
    for (let i = 0; i < 5; i++) await flush()
    // The old process is still ending: nothing copied, nothing spawned yet.
    expect(h.carries).toEqual([])
    expect(h.ptys).toHaveLength(1)
    exitPty(h.ptys[0], 0)
    await expect(req).resolves.toEqual(STARTED)
    expect(h.carries.map((c) => c.slice(0, 2))).toEqual([[{ accountId: 'acct-b' }, { uuid: CID, cwd: '/p/demo', accountId: 'acct-a' }]])
    expect(h.ptys).toHaveLength(2)
    expect(h.built.at(-1)).toMatchObject({ resume: { uuid: CID } })
    // The destination is the account this launch was prepared on: the
    // provider default when the request names none.
    killIn()
    exitPty(h.ptys[1], 0)
    onAccount('acct-default')
    await expect(spawnIn({ ...codexRequest })).resolves.toEqual(STARTED)
    expect(h.carries[1].slice(0, 2)).toEqual([{ accountId: 'acct-default' }, expect.objectContaining({ uuid: CID, accountId: 'acct-b' })])
  })

  it('ADR-009 thesis 3: the respawn of one session carries that session\'s conversation, never another tab\'s, and never one the request names', async () => {
    onAccount('acct-a')
    await spawnIn(request('acct-a'))
    claim(sid, CID)
    await spawnFor(sid2, request('acct-a'))
    claim(sid2, OTHER, '/p/other')
    killIn()
    exitPty(h.ptys[0], 0)
    onAccount('acct-b')
    h.resumable = true
    await spawnIn(request('acct-b'))
    expect(h.carries.map((c) => (c[1] as { uuid: string }).uuid)).toEqual([CID])
    // A request naming a conversation itself (here the other tab's) resumes
    // that one as named, and nothing is carried for it.
    killIn()
    exitPty(h.ptys.at(-1)!, 0)
    onAccount('acct-c')
    await spawnIn(request('acct-c', { resume: { uuid: OTHER, cwd: '/p/other' } }))
    expect(h.carries).toHaveLength(1)
    // The picker: nothing kept is resumed, so nothing is carried.
    killIn()
    exitPty(h.ptys.at(-1)!, 0)
    claim(sid, CID)
    onAccount('acct-d')
    await spawnIn(request('acct-d', { useResumePicker: true }))
    expect(h.carries).toHaveLength(1)
  })

  it('not carried: the spawn says why in main\'s words, and whether the launch resumed the conversation from a copy already there or started a new one', async () => {
    onAccount('acct-a')
    await spawnIn(request('acct-a'))
    claim(sid, CID)
    killIn()
    exitPty(h.ptys[0], 0)
    h.carry = async () => ({ ok: false, code: 'conversation-differs', message: 'It differs there.' })
    h.resumable = true
    onAccount('acct-b')
    await expect(spawnIn(request('acct-b'))).resolves.toEqual({ ...STARTED, carry: { code: 'conversation-differs', message: 'It differs there.', resumed: true } })
    killIn()
    exitPty(h.ptys.at(-1)!, 0)
    h.carry = async () => ({ ok: false, code: 'too-large', message: 'Too large.' })
    h.resumable = false
    onAccount('acct-a')
    await expect(spawnIn(request('acct-a'))).resolves.toEqual({ ...STARTED, carry: { code: 'too-large', message: 'Too large.', resumed: false } })
    // Carried, but the launch did not resume it: said too, never silent.
    claim(sid, CID)
    killIn()
    exitPty(h.ptys.at(-1)!, 0)
    h.carry = async () => ({ ok: true, carried: 'copied' })
    onAccount('acct-b')
    await expect(spawnIn(request('acct-b'))).resolves.toMatchObject({ started: true, carry: { code: 'conversation-missing', resumed: false } })
    // A carry that throws is not carried, in plain words.
    claim(sid, CID)
    killIn()
    exitPty(h.ptys.at(-1)!, 0)
    h.carry = async () => { throw new Error('boom') }
    onAccount('acct-a')
    await expect(spawnIn(request('acct-a'))).resolves.toEqual({ ...STARTED, carry: { code: 'internal', message: 'The conversation could not be carried over.', resumed: false } })
  })

  it('an old process still running, or not ended within the bound: nothing is carried, and the spawn says so', async () => {
    onAccount('acct-a')
    await spawnIn(request('acct-a'))
    claim(sid, CID)
    // Never killed: a respawn straight over it.
    onAccount('acct-b')
    await expect(spawnIn(request('acct-b'))).resolves.toMatchObject({ started: true, carry: { code: 'busy', resumed: false } })
    expect(h.carries).toEqual([])
    // Killed, but its process never reports its end.
    claim(sid, CID)
    killIn()
    onAccount('acct-a')
    vi.useFakeTimers()
    try {
      const req = spawnIn(request('acct-a'))
      await vi.advanceTimersByTimeAsync(CODEX_CARRY_EXIT_WAIT_MS + 100)
      await expect(req).resolves.toMatchObject({ started: true, carry: { code: 'busy', resumed: false } })
    } finally {
      vi.useRealTimers()
    }
    expect(h.carries).toEqual([])
    expect(CODEX_CARRY_EXIT_WAIT_MS).toBeGreaterThan(0)
    expect(CODEX_CARRY_EXIT_WAIT_MS).toBeLessThanOrEqual(10_000)
  })

  it('nothing to carry: the same account again, or no conversation known -- nothing asked, nothing said', async () => {
    onAccount('acct-a')
    await spawnIn(request('acct-a'))
    claim(sid, CID)
    killIn()
    exitPty(h.ptys[0], 0)
    await expect(spawnIn(request('acct-a'))).resolves.toEqual(STARTED)
    killIn()
    exitPty(h.ptys.at(-1)!, 0)
    onAccount('acct-b')
    await expect(spawnIn(request('acct-b'))).resolves.toEqual(STARTED)
    expect(h.carries).toEqual([])
  })

  // Quality round 2: a spawn that is no longer the session's never carries,
  // so it never holds the realms against the spawn that replaced it.
  it('a respawn superseded while it waits for the old process carries nothing; the one that replaced it carries once', async () => {
    onAccount('acct-a')
    await spawnIn(request('acct-a'))
    claim(sid, CID)
    killIn()
    onAccount('acct-b')
    h.resumable = true
    const first = spawnIn(request('acct-b'))
    for (let i = 0; i < 5; i++) await flush()
    const second = spawnIn(request('acct-b'))
    for (let i = 0; i < 5; i++) await flush()
    expect(h.carries).toEqual([])
    exitPty(h.ptys[0], 0)
    await expect(first).resolves.toEqual({ started: false })
    await expect(second).resolves.toEqual(STARTED)
    expect(h.carries).toHaveLength(1)
    expect(h.ptys).toHaveLength(2)
  })

  it('a respawn superseded while its launch is prepared neither waits for the old process nor carries', async () => {
    onAccount('acct-a')
    await spawnIn(request('acct-a'))
    claim(sid, CID)
    // The old process never reports its end.
    killIn()
    const d = deferred<unknown>()
    h.prepare = () => d.promise
    const first = spawnIn(request('acct-b'))
    for (let i = 0; i < 3; i++) await flush()
    let firstDone = false
    void first.then(() => { firstDone = true })
    vi.useFakeTimers()
    try {
      onAccount('acct-b')
      const second = spawnIn(request('acct-b'))
      await vi.advanceTimersByTimeAsync(0)
      d.resolve(prepared(on('acct-b', 'acct-b')))
      await vi.advanceTimersByTimeAsync(10)
      // Started nothing, at once: no wait for a process it will not follow.
      expect(firstDone).toBe(true)
      await expect(first).resolves.toEqual({ started: false })
      await vi.advanceTimersByTimeAsync(CODEX_CARRY_EXIT_WAIT_MS + 100)
      await expect(second).resolves.toMatchObject({ started: true, carry: { code: 'busy' } })
    } finally {
      vi.useRealTimers()
    }
    expect(h.carries).toEqual([])
  })

  it('an old process that never reports its end counts as ended once its account lease is let go, and its record goes', async () => {
    onAccount('acct-a')
    await spawnIn(request('acct-a'))
    claim(sid, CID)
    vi.useFakeTimers()
    try {
      killIn()
      vi.advanceTimersByTime(CODEX_LEASE_EXIT_GRACE_MS + 1)
      onAccount('acct-b')
      h.resumable = true
      const req = spawnIn(request('acct-b'))
      await vi.advanceTimersByTimeAsync(10)
      expect(h.carries).toHaveLength(1)
      await expect(req).resolves.toEqual(STARTED)
    } finally {
      vi.useRealTimers()
    }
  })

  // ADR-009 round 1 (quality R3): the wait says what happened: true when the
  // killed run reported its end, false when its grace passed first with no
  // end reported; once that grace is over the run counts as over, as its
  // account lease does.
  it('a wait on a killed run is answered truthfully: false when its grace passes with no end reported, true once it is over', async () => {
    onAccount('acct-a')
    await spawnIn(request('acct-a'))
    vi.useFakeTimers()
    try {
      killIn()
      const waited = codexRunEnded(sid, CODEX_LEASE_EXIT_GRACE_MS * 2)
      await vi.advanceTimersByTimeAsync(CODEX_LEASE_EXIT_GRACE_MS + 1)
      await expect(waited).resolves.toBe(false)
      await expect(codexRunEnded(sid, 0)).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
    // A run that reports its end: true.
    onAccount('acct-a')
    await spawnIn(request('acct-a'))
    killIn()
    const ended = codexRunEnded(sid, 5_000)
    exitPty(h.ptys.at(-1)!, 0)
    await expect(ended).resolves.toBe(true)
  })

  // ADR-009 round 1, B1 (b): a conversation another open session is on is
  // never carried, so it is neither forked nor added to under that session.
  it('two open sessions on one conversation: a switch of one carries nothing, and says another open session is on it', async () => {
    onAccount('acct-a')
    await spawnIn(request('acct-a'))
    claim(sid, CID)
    await spawnFor(sid2, request('acct-a'))
    claim(sid2, CID)
    killIn()
    exitPty(h.ptys[0], 0)
    onAccount('acct-b')
    await expect(spawnIn(request('acct-b'))).resolves.toEqual({ ...STARTED, carry: { code: 'in-use', message: 'Another open session is on this conversation, so it was not carried over.', resumed: false } })
    expect(h.carries).toEqual([])
    // Once the other session has closed, the conversation is this one's to carry.
    killPtyFor(sid2)
    exitPty(h.ptys[1], 0)
    killIn()
    exitPty(h.ptys.at(-1)!, 0)
    claim(sid, CID)
    onAccount('acct-c')
    h.resumable = true
    await expect(spawnIn(request('acct-c'))).resolves.toEqual(STARTED)
    expect(h.carries).toHaveLength(1)
  })

  // ADR-009 round 2 (C1): nor resumed on the new account, where the other
  // session may be on it: two sessions would write one rollout there.
  it('the other open session on that conversation is on the account switched to: the switch neither carries nor resumes it there, and starts a new conversation', async () => {
    onAccount('acct-a')
    await spawnIn(request('acct-a'))
    claim(sid, CID)
    onAccount('acct-b')
    await spawnFor(sid2, request('acct-b'))
    claim(sid2, CID)
    killIn()
    exitPty(h.ptys[0], 0)
    // The copy there is one the launch could resume.
    h.resumable = true
    onAccount('acct-b')
    await expect(spawnIn(request('acct-b'))).resolves.toEqual({ ...STARTED, carry: { code: 'in-use', message: 'Another open session is on this conversation, so it was not carried over.', resumed: false } })
    expect(h.carries).toEqual([])
    expect(h.built.at(-1)).toMatchObject({ sessionId: sid })
    expect(h.built.at(-1)!.resume).toBeUndefined()
  })

  // ADR-009 round 1, B2: a copy already under way is told once its respawn
  // is no longer the session's, so it stops and the newer respawn carries.
  it('a respawn superseded while its copy runs: the copy is told it is no longer wanted', async () => {
    onAccount('acct-a')
    await spawnIn(request('acct-a'))
    claim(sid, CID)
    killIn()
    exitPty(h.ptys[0], 0)
    let release!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    let firstCurrent: (() => boolean) | undefined
    h.carry = async (...a: unknown[]) => {
      if (!firstCurrent) { firstCurrent = (a[2] as { current: () => boolean }).current; await blocked; return { ok: false, code: 'cancelled', message: 'Stopped on request; nothing was changed.' } }
      return { ok: true, carried: 'copied' }
    }
    onAccount('acct-b')
    const first = spawnIn(request('acct-b'))
    for (let i = 0; i < 20 && !firstCurrent; i++) await flush()
    expect(firstCurrent!()).toBe(true)
    onAccount('acct-c')
    const second = spawnIn(request('acct-c'))
    for (let i = 0; i < 5; i++) await flush()
    expect(firstCurrent!()).toBe(false)
    release()
    await expect(first).resolves.toEqual({ started: false })
    await second
    expect(h.carries.map((c) => (c[0] as { accountId: string }).accountId)).toEqual(['acct-b', 'acct-c'])
  })

  // ADR-009 round 1, B3 (decided: Claude parity): any respawn onto another
  // account carries the conversation, a plain Restart of a tab that names no
  // account after the default account changed included, as every Claude
  // profile's respawn resumes the same conversation from the one shared
  // projects folder.
  it('a plain Restart of a tab that names no account, after the default account changed, carries the conversation into the new default (Claude parity)', async () => {
    onAccount('acct-work')
    await spawnIn({ ...codexRequest })
    claim(sid, CID)
    killIn()
    exitPty(h.ptys[0], 0)
    onAccount('acct-personal')
    h.resumable = true
    await expect(spawnIn({ ...codexRequest })).resolves.toEqual(STARTED)
    expect(h.carries.map((c) => c.slice(0, 2))).toEqual([[{ accountId: 'acct-personal' }, expect.objectContaining({ uuid: CID, accountId: 'acct-work' })]])
  })

  // ADR-009 round 1, A6: the copy has a time bound inside the respawn.
  it('a copy that does not finish in time: the respawn goes on without the conversation in the failed-carry words, and the copy is told to stop', async () => {
    onAccount('acct-a')
    await spawnIn(request('acct-a'))
    claim(sid, CID)
    killIn()
    exitPty(h.ptys[0], 0)
    let told: (() => boolean) | undefined
    h.carry = (...a: unknown[]) => { told = (a[2] as { current: () => boolean }).current; return new Promise(() => {}) }
    onAccount('acct-b')
    vi.useFakeTimers()
    try {
      const req = spawnIn(request('acct-b'))
      await vi.advanceTimersByTimeAsync(CODEX_CARRY_TIMEOUT_MS - 100)
      expect(told!()).toBe(true)
      await vi.advanceTimersByTimeAsync(200)
      await expect(req).resolves.toEqual({ ...STARTED, carry: { code: 'io-failed', message: "The conversation could not be copied into the other Codex account's folder, so it was not carried over.", resumed: false } })
      expect(told!()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
    expect(CODEX_CARRY_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
    expect(CODEX_CARRY_TIMEOUT_MS).toBeLessThanOrEqual(5 * 60_000)
  })
})

// ---------------------------------------------------------------------------
// P3.6 (ADR-009 round 1, B1; owner decision, option 2): P3.5's claim is kept
// as it is, with its recorded limit (two new tabs on one account in one folder
// can take each other's rollout until P3.10's exact claim), but a claim that
// could have been the other tab's is not certain, and a Switch account never
// carries or brings up to date one of those: it starts a new conversation on
// the new account and says why. A Restart on the same account keeps P3.5's
// behaviour. The uncertainty is kept across a relaunch.
// ---------------------------------------------------------------------------

describe('a conversation whose claim was not certain is never carried (P3.6, owner decision)', () => {
  let seq = 0
  let sid = ''
  let sid2 = ''
  const PREFIX = 'ccc-p36-claimrace-'
  const bases: string[] = []
  beforeEach(() => { seq++; sid = `lh-p36u-${seq}-a`; sid2 = `lh-p36u-${seq}-b` })
  afterEach(() => {
    h.realWatch = false
    h.gateway = null
    h.pickFile = null
    h.pickFolder = null
    for (const w of h.watchers.splice(0)) { try { w.stop() } catch { /* stopped */ } }
    for (const id of [sid, sid2]) { try { killPty(id) } catch { /* not running */ } }
    // TEST CLEANUP GUARD: only a folder this block made (its own prefix,
    // directly in the system temp folder) is removed.
    for (const b of bases.splice(0)) if (path.dirname(b) === os.tmpdir() && path.basename(b).startsWith(PREFIX)) require('node:fs').rmSync(b, { recursive: true, force: true })
  })
  const nfs = require('node:fs') as typeof import('node:fs')
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  /** Until `ok` holds, looked at often, bounded (ADR-009 round 2, C7): the
   *  watcher's poll decides when, never a fixed wait. */
  const until = async (ok: () => boolean, boundMs = 5_000) => {
    const end = Date.now() + boundMs
    while (!ok()) {
      if (Date.now() > end) throw new Error('not within the bound')
      await sleep(20)
    }
  }
  const spawnFor = (id: string, opts: Record<string, unknown>) => h.handlers.get('pty:spawn')!({}, id, opts)
  const killFor = (id: string) => h.listeners.get('pty:kill')!({}, id)
  const onAccount = (accountId: string, sessionsDir?: string) => {
    h.prepare = async () => {
      const l = launch(accountId)
      ;(l.lease as unknown as { accountId: string }).accountId = accountId
      if (sessionsDir) (l as unknown as { sessionsDir: string }).sessionsDir = sessionsDir
      return prepared(l)
    }
  }
  const metaOf = (id: string, cwd: string, iso: string) => JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, timestamp: iso, cwd, cli_version: '0.155.1' } })
  function rolloutIn(sessions: string, id: string, cwd: string): string {
    const dir = codexDayFolders(sessions, [Date.now()])[0]
    nfs.mkdirSync(dir, { recursive: true })
    const iso = new Date().toISOString()
    const file = path.join(dir, `rollout-${iso.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`)
    nfs.writeFileSync(file, metaOf(id, cwd, iso) + '\n', 'utf-8')
    return file
  }
  const UNCERTAIN = 'Another session started in the same folder at about the same time, so the app could not be sure which conversation was this one, and did not carry it over.'

  it('two new tabs on one account in one folder, the later one\'s rollout first (the cross-claim shape): a Restart on that account resumes as before; a Switch carries nothing and starts a new conversation there, saying why', async () => {
    const base = nfs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
    bases.push(base)
    const sessA = path.join(base, 'A', 'sessions')
    nfs.mkdirSync(sessA, { recursive: true })
    const proj = path.join(base, 'proj')
    nfs.mkdirSync(proj)
    const convX = '019dd000-0036-7000-8000-0000000000aa'
    const convY = '019dd000-0036-7000-8000-0000000000bb'
    h.realWatch = true
    onAccount('acct-a', sessA)
    await spawnFor(sid, { ...codexRequest, cwd: proj, providerAccountId: 'acct-a' })
    await sleep(90)
    await spawnFor(sid2, { ...codexRequest, cwd: proj, providerAccountId: 'acct-a' })
    const cwdSeen = String((h.telemetry.find((t) => t.sessionId === sid)!.opts as { cwd: string }).cwd)
    rolloutIn(sessA, convY, cwdSeen)
    await until(() => !!getKeptCodexConversation(sid) || !!getKeptCodexConversation(sid2))
    rolloutIn(sessA, convX, cwdSeen)
    await until(() => !!getKeptCodexConversation(sid) && !!getKeptCodexConversation(sid2))
    const claimedByX = [...h.telemetry].reverse().find((t) => t.sessionId === sid)
    expect(claimedByX).toBeTruthy()
    // A Restart on the same account: P3.5's behaviour, the kept one resumed.
    killFor(sid)
    for (const p of h.ptys) exitPty(p, 0)
    h.resumable = true
    onAccount('acct-a', sessA)
    await expect(spawnFor(sid, { ...codexRequest, cwd: proj, providerAccountId: 'acct-a' })).resolves.toEqual(STARTED)
    const keptUuid = (h.built.at(-1)!.resume as { uuid: string }).uuid
    expect([convX, convY]).toContain(keptUuid)
    expect(h.carries).toEqual([])
    // A Switch to another account: nothing carried, a new conversation there.
    killFor(sid)
    for (const p of h.ptys) exitPty(p, 0)
    onAccount('acct-b')
    await expect(spawnFor(sid, { ...codexRequest, cwd: proj, providerAccountId: 'acct-b' })).resolves.toEqual({ ...STARTED, carry: { code: 'conversation-uncertain', message: UNCERTAIN, resumed: false } })
    expect(h.carries).toEqual([])
    expect(h.built.at(-1)!.resume).toBeUndefined()
    // The other tab too.
    killFor(sid2)
    for (const p of h.ptys) exitPty(p, 0)
    onAccount('acct-c')
    await expect(spawnFor(sid2, { ...codexRequest, cwd: proj, providerAccountId: 'acct-c' })).resolves.toMatchObject({ started: true, carry: { code: 'conversation-uncertain', resumed: false } })
    expect(h.carries).toEqual([])
  })

  // P3.6 VM finding V2: a second tab that picks the conversation a first tab
  // holds on the same account is on it too, so its Switch refuses it as in
  // use and says so, as the other in-use case does. (A resume by id is kept
  // at its launch already, P3.5.)
  it('a second tab that picks the conversation a first tab holds on one account: recorded on it, so its Switch refuses it as in use and starts a new one', async () => {
    const base = nfs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
    bases.push(base)
    const sessA = path.join(base, 'A', 'sessions')
    nfs.mkdirSync(sessA, { recursive: true })
    const proj = path.join(base, 'proj')
    nfs.mkdirSync(proj)
    const pickDir = path.join(base, 'pick')
    nfs.mkdirSync(pickDir)
    const conv = '019dd000-0036-7000-8000-0000000000dd'
    rolloutIn(sessA, conv, proj)
    h.realWatch = true
    h.resumable = true
    onAccount('acct-a', sessA)
    await spawnFor(sid, { ...codexRequest, cwd: proj, providerAccountId: 'acct-a', resume: { uuid: conv, cwd: proj } })
    await until(() => getKeptCodexConversation(sid)?.uuid === conv)
    // The second tab opens the picker, which names that conversation.
    h.resumable = false
    h.pickFile = path.join(pickDir, 'pick.json')
    h.pickFolder = codexFolderIdentity(pickDir)
    await spawnFor(sid2, { ...codexRequest, cwd: proj, providerAccountId: 'acct-a', useResumePicker: true })
    expect(getKeptCodexConversation(sid2)).toBeUndefined()
    nfs.writeFileSync(h.pickFile, JSON.stringify({ id: conv }))
    await until(() => getKeptCodexConversation(sid2)?.uuid === conv)
    // The second tab switches; the first is still running on the conversation.
    killFor(sid2)
    exitPty(h.ptys[1], 0)
    onAccount('acct-b')
    await expect(spawnFor(sid2, { ...codexRequest, cwd: proj, providerAccountId: 'acct-b' })).resolves.toEqual({ ...STARTED, carry: { code: 'in-use', message: 'Another open session is on this conversation, so it was not carried over.', resumed: false } })
    expect(h.carries).toEqual([])
    expect(h.built.at(-1)).toMatchObject({ sessionId: sid2 })
    expect(h.built.at(-1)!.resume).toBeUndefined()
  })

  // P3.10: the exact claim from the session's own hook. Where the session's
  // own Codex hooks are heard from (round 1, S4: this session's, not merely
  // another tab's of the account), a conversation that is still only inferred
  // was never named by the session's Codex, which names the one it is on with
  // every event, and may be another writer's (a CLI outside the app in the
  // same folder): never carried. Once the session's own hook names it, a
  // Switch carries it.
  it('P3.10: where the session\'s own hooks are heard from, a conversation only inferred is not carried; one the session\'s own hook named is', async () => {
    const base = nfs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
    bases.push(base)
    const sessA = path.join(base, 'A', 'sessions')
    nfs.mkdirSync(sessA, { recursive: true })
    const proj = path.join(base, 'proj')
    const proj2 = path.join(base, 'proj2')
    nfs.mkdirSync(proj)
    nfs.mkdirSync(proj2)
    const convX = '019dd000-0310-7000-8000-0000000000aa'
    const convY = '019dd000-0310-7000-8000-0000000000bb'
    h.realWatch = true
    h.gateway = { status: () => ({ enabled: true, listening: true, port: 51234 }), registerSession: () => '0f8b6a2c-1d3e-4f50-9a61-7b2c3d4e5f60', unregisterSession: () => {} }
    onAccount('acct-a', sessA)
    await spawnFor(sid, { ...codexRequest, cwd: proj, providerAccountId: 'acct-a' })
    const cwdSeen = String((h.telemetry.find((t) => t.sessionId === sid)!.opts as { cwd: string }).cwd)
    const x = rolloutIn(sessA, convX, cwdSeen)
    await until(() => getKeptCodexConversation(sid)?.uuid === convX)
    // Another session of the account is heard from: its hooks run there.
    onAccount('acct-a', sessA)
    await spawnFor(sid2, { ...codexRequest, cwd: proj2, providerAccountId: 'acct-a' })
    const cwd2Seen = String((h.telemetry.find((t) => t.sessionId === sid2)!.opts as { cwd: string }).cwd)
    const y = rolloutIn(sessA, convY, cwd2Seen)
    expect(noteCodexHookTranscript(sid2, y)).toBe(true)
    await until(() => getKeptCodexConversation(sid2)?.uuid === convY)
    // The first tab's own hook is heard, naming nothing its watch takes: its
    // conversation stays only inferred, and a Switch carries nothing.
    expect(noteCodexHookTranscript(sid, path.join(base, 'elsewhere', 'rollout-x.jsonl'))).toBe(true)
    const sidPty = h.ptys[0]
    killFor(sid)
    exitPty(sidPty, 0)
    onAccount('acct-b')
    await expect(spawnFor(sid, { ...codexRequest, cwd: proj, providerAccountId: 'acct-b' })).resolves.toEqual({ ...STARTED, carry: { code: 'conversation-uncertain', message: 'Codex did not confirm that this session is on this conversation, so the app could not be sure it was this session\'s, and did not carry it over.', resumed: false } })
    expect(h.carries).toEqual([])
    expect(h.built.at(-1)!.resume).toBeUndefined()
    // The second tab's own hook named its conversation: a Switch carries it.
    const sid2Pty = h.ptys[1]
    killFor(sid2)
    exitPty(sid2Pty, 0)
    onAccount('acct-c')
    h.resumable = true
    await expect(spawnFor(sid2, { ...codexRequest, cwd: proj2, providerAccountId: 'acct-c' })).resolves.toEqual(STARTED)
    expect(h.carries.length).toBe(1)
    expect((h.carries[0] as unknown[])[1]).toMatchObject({ uuid: convY, accountId: 'acct-a' })
    void x
  })

  it('kept across a relaunch: a restored tab on a conversation whose claim was not certain is still never carried', async () => {
    const CID = '019dd000-0036-7000-8000-0000000000cc'
    // What main read back from the saved session state at load (the
    // session:load read-back, ADR-009 round 2, C4); anything but a state, or
    // a list entry that is not a conversation id, is passed over.
    for (const odd of [null, undefined, 'a state', 7]) rememberUncertainCodexConversationsFrom(odd)
    rememberUncertainCodexConversationsFrom({ sessions: [], activeSessionId: null, savedAt: 1, codexUncertainConversations: [CID, 'not-an-id', 42] })
    onAccount('acct-a')
    h.resumable = true
    await spawnFor(sid, { ...codexRequest, providerAccountId: 'acct-a', resume: { uuid: CID, cwd: os.tmpdir() } })
    killFor(sid)
    for (const p of h.ptys) exitPty(p, 0)
    onAccount('acct-b')
    await expect(spawnFor(sid, { ...codexRequest, providerAccountId: 'acct-b' })).resolves.toMatchObject({ started: true, carry: { code: 'conversation-uncertain', resumed: false } })
    expect(h.carries).toEqual([])
  })
})
