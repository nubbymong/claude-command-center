/**
 * P3.13 round 1 (ADR-009 lens B): the one-at-a-time rule on the REAL pty:spawn
 * and the REAL pty-manager, for a CLAUDE managed launch (a profile), which is
 * DEFERRED by the profile-refresh wait and the project-settings gate
 * (deferSpawnUntil, refreshWaitSpawns): the path the other handler suites never
 * reach (they resolve no profile). A copy parked there is a copy main holds, so
 * a second copy asked for meanwhile is refused; a parked copy that fails or is
 * closed leaves the config free. Nothing real starts: node-pty is faked and the
 * project gate is never allowed to answer clean.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

const h = vi.hoisted(() => ({
  ptys: [] as Array<{ kill: () => void }>,
  handlers: new Map<string, (...a: any[]) => any>(),
  listeners: new Map<string, (...a: any[]) => any>(),
  configs: [] as unknown[],
  gate: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void },
  refresh: null as null | Promise<void>,
  sent: [] as string[],
  /** The folders this file made (its own mkdtemp, in the mocks below). */
  profileDir: '' as string,
  resDir: '' as string,
}))
const mk = () => {
  let resolve!: (v: unknown) => void
  let reject!: (e: unknown) => void
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

vi.mock('node-pty', () => ({
  spawn: () => {
    const p = { kill: vi.fn() }
    h.ptys.push(p)
    return { pid: 1, process: 'x', onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }), write: () => {}, resize: () => {}, kill: p.kill }
  },
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-claude-defer-res-'))
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
vi.mock('../../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 0, registerCodexReviewSession: () => {}, registerClaudeReviewSession: () => {}, unregisterCodexReviewSession: () => {}, releaseMcpSessionProvider: () => {}, disposeCodexReviewUsage: () => {} }))
vi.mock('../../../src/main/providers', () => ({ getProvider: () => ({ buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }), prepareSessionHooks: () => null, ingestSessionTelemetry: () => ({ stop: () => {} }) }) }))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({ writeLocalSessionSettings: () => null, removeLocalSessionSettings: () => {}, writeLocalSessionMcpConfig: () => null, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {} }))
vi.mock('../../../src/main/claude-account-identity', () => ({ captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null }))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {} }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/config-manager', async (orig) => ({ ...(await orig<any>()), readConfig: (key: string) => (key === 'configs' ? h.configs : {}), getConfigDir: () => os.tmpdir() }))
vi.mock('../../../src/main/account-profiles', async (orig) => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  h.profileDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-claude-defer-prof-'))
  return {
    ...(await orig<any>()),
    isValidProfileId: () => true,
    getPrimaryProfileId: () => 'p1',
    getProfileConfigDir: () => h.profileDir,
    setupProfileLinks: () => {},
    syncPrimaryCredentialsWithGlobal: () => {},
    backupProfileHomeToCanonical: () => {},
    withProfileHome: () => { throw new Error('never reached: the project gate never answers') },
  }
})
vi.mock('../../../src/main/profile-consumers', async (orig) => ({ ...(await orig<any>()), acquireProfileConsumer: () => () => {}, pendingProfileRefresh: () => h.refresh }))
vi.mock('../../../src/main/managed-launch-diagnostics', async (orig) => ({ ...(await orig<any>()), gateManagedLaunchDirs: () => h.gate!.promise, recordManagedLaunchPreflight: () => {} }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: async () => ({ ok: true }) }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => ({ launchRefusal: () => null, remoteLaunchRefusal: () => null, prepareLaunch: async () => ({ ok: false, message: 'n/a' }) }) }))

// Nothing real may start: the process layer must be the fake above.
const nodePty = await import('node-pty')
if (!String((nodePty as any).spawn).includes('h.ptys.push')) throw new Error('node-pty is not mocked: abort')
const { killPty, isSessionLiveOrStarting } = await import('../../../src/main/pty-manager')
const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
const { _resetConfigLaunchClaimsForTest } = await import('../../../src/main/launch-one-at-a-time')
const fakeWin = { isDestroyed: () => false, webContents: { send: (ch: string) => { h.sent.push(ch) } } }
registerPtyHandlers(() => fakeWin as never)
if (typeof h.handlers.get('pty:spawn') !== 'function') throw new Error('ipcMain was not captured: abort')

const spawnAs = (id: string, over: Record<string, unknown> = {}) => h.handlers.get('pty:spawn')!({}, id, { cwd: os.tmpdir(), configId: 'cfgclaude', profileId: 'p1', ...over })
const closeTab = (id: string) => h.listeners.get('pty:kill')!({}, id)
// A macrotask boundary: every promise reaction of the rejection or the settle has run by then (no real wait).
const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const S = (n: number) => `ad${String(n).padStart(22, '0')}`

// The folders this file made go with it: only a path of its own prefix, directly under the temp folder.
afterAll(() => {
  for (const [dir, prefix] of [[h.resDir, 'ccc-claude-defer-res-'], [h.profileDir, 'ccc-claude-defer-prof-']] as const) {
    if (!dir) continue
    if (path.basename(dir).startsWith(prefix) && path.resolve(path.dirname(dir)) === path.resolve(os.tmpdir())) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
})

beforeEach(() => {
  for (let i = 1; i < 10; i++) { try { killPty(S(i)) } catch { /* none */ } }
  h.ptys = []; h.sent = []
  h.gate = mk(); h.refresh = null
  h.configs = [{ id: 'cfgclaude', label: 'App Dev', provider: 'claude', sessionType: 'local', workingDirectory: os.tmpdir(), allowMultiSpawn: false }]
  _resetConfigLaunchClaimsForTest()
})

describe('Claude managed launch, deferred by the project gate', () => {
  it('a second copy while the first waits on the project gate is refused; nothing spawned', async () => {
    const r1 = await spawnAs(S(1))
    expect(r1 === undefined || (r1 as any).started !== false).toBe(true)
    expect(isSessionLiveOrStarting(S(1))).toBe(true)
    expect(h.ptys).toHaveLength(0) // still deferred
    const r2 = await spawnAs(S(2))
    expect(r2).toMatchObject({ started: false, refused: { code: 'already-running', providerId: 'claude' } })
  })

  it('the deferred first copy failing (its gate wait rejects) frees the config: the next copy is accepted', async () => {
    await spawnAs(S(1))
    h.gate!.reject(new Error('gate failed'))
    await tick()
    expect(isSessionLiveOrStarting(S(1))).toBe(false)
    h.gate = mk()
    const r3 = await spawnAs(S(3))
    expect(r3 === undefined || !(r3 as any).refused).toBe(true)
    expect(isSessionLiveOrStarting(S(3))).toBe(true)
  })

  it('closing the deferred first copy (pty:kill) frees the config at once', async () => {
    await spawnAs(S(1))
    closeTab(S(1))
    expect(isSessionLiveOrStarting(S(1))).toBe(false)
    const r = await spawnAs(S(2))
    expect(r === undefined || !(r as any).refused).toBe(true)
  })

  it('a deferred copy that is Restarted while it waits keeps its own right (the same session id)', async () => {
    await spawnAs(S(1))
    h.gate = mk()
    const again = await spawnAs(S(1))
    expect(again === undefined || !(again as any).refused).toBe(true)
  })
})

describe('Claude managed launch, deferred by a profile-refresh wait', () => {
  it('a second copy during the refresh wait is refused, and still once the re-entry waits on the project gate', async () => {
    const rf = mk()
    h.refresh = rf.promise as Promise<void>
    await spawnAs(S(4))
    expect(isSessionLiveOrStarting(S(4))).toBe(true)
    expect(await spawnAs(S(5))).toMatchObject({ started: false, refused: { code: 'already-running' } })
    // The refresh settles; the re-entry is deferred AGAIN by the project gate: still one copy held.
    h.refresh = null
    rf.resolve(undefined)
    await tick()
    expect(isSessionLiveOrStarting(S(4))).toBe(true)
    expect(await spawnAs(S(6))).toMatchObject({ started: false, refused: { code: 'already-running' } })
  })
})
