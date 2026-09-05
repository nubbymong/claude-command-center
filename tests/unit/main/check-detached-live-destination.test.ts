/**
 * ssh:checkDetachedLive -- the main-side destination check (#54).
 *
 * The renderer names a config id and the session ids to probe; main dials the
 * config's host. If that config was EDITED after a session was left running on
 * it, the probe would ask the NEW host about the OLD session -- and a verified-
 * empty answer would read as "dead" and PRUNE a session that is alive elsewhere.
 * The renderer no longer files such a probe (matchDetachedRemotes), and this is
 * the backstop behind it: main compares the saved config against the persisted
 * registry and answers 'unverified' (fail-open: nothing pruned, nothing probed on
 * the wrong host) for the WHOLE query when any queried session was recorded at a
 * different destination.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: class {},
}))
const probeTmuxLive = vi.fn(async (_target: unknown, ids: string[]) => ({ outcome: 'verified' as const, liveSessionIds: ids }))
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: vi.fn(), writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: vi.fn(),
  endSshRemote: vi.fn(), probeTmuxLive: (...a: unknown[]) => probeTmuxLive(...(a as [unknown, string[]])),
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn() }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))

let configsOnDisk: unknown = null
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: (key: string) => (key === 'configs' ? configsOnDisk : null),
}))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => 'pw' }))
let registryOnDisk: unknown[] = []
vi.mock('../../../src/main/session-state', () => ({ readDetachedRemotesRegistry: () => registryOnDisk }))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
const { IPC } = await import('../../../src/shared/ipc-channels')
registerPtyHandlers(() => ({} as never))
const check = handlers.get(IPC.SSH_CHECK_DETACHED_LIVE)!

const A = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const B = 'b1b2c3d4e5f6a1b2c3d4e5f6'
const SSH = { host: 'pi.local', port: 2222, username: 'mong', remotePath: '~/work' }
const sshCfg = (id: string, extra: Record<string, unknown> = {}) => ({ id, sessionType: 'ssh', sshConfig: { ...SSH, ...extra } })
const recordedAt = (sessionId: string, over: Record<string, unknown> = {}) => ({
  sessionId, configId: 'cfgA', host: 'pi.local', username: 'mong', remotePath: '~/work',
  port: 2222, runtime: { type: 'host' }, mux: 'tmux', label: 'Pi', detachedAt: 1, ...over,
})

beforeEach(() => {
  probeTmuxLive.mockClear()
  configsOnDisk = [sshCfg('cfgA')]
  registryOnDisk = []
})

describe('ssh:checkDetachedLive — refuses to ask the new host about a session left on the old one (#54)', () => {
  it('probes the saved host when the recorded destination agrees', async () => {
    registryOnDisk = [recordedAt(A)]
    const res = await check({}, { configId: 'cfgA', sessionIds: [A] })
    expect(probeTmuxLive).toHaveBeenCalledTimes(1)
    expect(probeTmuxLive.mock.calls[0][0]).toMatchObject({ host: 'pi.local', port: 2222, username: 'mong' })
    expect(res).toEqual({ outcome: 'verified', liveSessionIds: [A] })
  })

  it('answers unverified and probes NOTHING when the config\'s host was edited away from the recorded one', async () => {
    configsOnDisk = [sshCfg('cfgA', { host: 'other.box' })]
    registryOnDisk = [recordedAt(A)]
    const res = await check({}, { configId: 'cfgA', sessionIds: [A] })
    expect(probeTmuxLive).not.toHaveBeenCalled()
    expect(res).toEqual({ outcome: 'unverified', liveSessionIds: [] })
  })

  it('one moved session among several makes the WHOLE answer unverified — a partial verified list would read the rest as dead', async () => {
    configsOnDisk = [sshCfg('cfgA', { port: 22 })]
    registryOnDisk = [recordedAt(A), recordedAt(B, { port: 22 })] // B agrees, A was left on :2222
    const res = await check({}, { configId: 'cfgA', sessionIds: [A, B] })
    expect(probeTmuxLive).not.toHaveBeenCalled()
    expect(res).toEqual({ outcome: 'unverified', liveSessionIds: [] })
  })

  it('a runtime edit (host -> container) is a moved destination too', async () => {
    configsOnDisk = [sshCfg('cfgA', { runtime: { type: 'container', container: 'dev' } })]
    registryOnDisk = [recordedAt(A)]
    const res = await check({}, { configId: 'cfgA', sessionIds: [A] })
    expect(probeTmuxLive).not.toHaveBeenCalled()
    expect(res.outcome).toBe('unverified')
  })

  it('a session the registry does not know is probed as before (the config-only rule)', async () => {
    configsOnDisk = [sshCfg('cfgA', { host: 'other.box' })]
    registryOnDisk = [recordedAt(B)]
    await check({}, { configId: 'cfgA', sessionIds: [A] })
    expect(probeTmuxLive).toHaveBeenCalledTimes(1)
    expect(probeTmuxLive.mock.calls[0][0]).toMatchObject({ host: 'other.box' })
  })

  it('a PRE-#54 registry entry (no port/runtime) is compared on host/user/path only', async () => {
    registryOnDisk = [recordedAt(A, { port: undefined, runtime: undefined })]
    configsOnDisk = [sshCfg('cfgA', { port: 22, runtime: { type: 'container', container: 'x' } })]
    await check({}, { configId: 'cfgA', sessionIds: [A] })
    expect(probeTmuxLive).toHaveBeenCalledTimes(1) // an edit we cannot see is not an edit
    probeTmuxLive.mockClear()
    configsOnDisk = [sshCfg('cfgA', { host: 'other.box' })]
    const res = await check({}, { configId: 'cfgA', sessionIds: [A] })
    expect(probeTmuxLive).not.toHaveBeenCalled() // a host edit still is
    expect(res.outcome).toBe('unverified')
  })

  it('an unknown config is unverified regardless of the registry (unchanged fail-open)', async () => {
    registryOnDisk = [recordedAt(A)]
    const res = await check({}, { configId: 'ghost', sessionIds: [A] })
    expect(res).toEqual({ outcome: 'unverified', liveSessionIds: [] })
    expect(probeTmuxLive).not.toHaveBeenCalled()
  })
})
