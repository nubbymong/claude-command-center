/**
 * A local Claude session that names no account runs on the primary account,
 * which the start's profile steps may still be making (the first account from
 * the user's own sign-in). While those steps are still to run, pty:spawn holds
 * such a launch as a prepared spawn and starts it only once they have run, so
 * it starts on that account; a close of the tab while it waits starts nothing.
 * A launch that names an account, one over SSH, and a terminal-only one are not
 * held by this, and nothing is held once the steps have run.
 *
 * Driven through the REAL pty:spawn and pty:kill handlers on a fake ipcMain;
 * the start's profile steps are held on a gate the test opens (the account
 * store's own pending/settled pair, answered here), and pty-manager is faked
 * (a Set of session ids with a PTY, one of spawns it is still preparing, as
 * pty-manager's preparations behave), so nothing spawns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  BrowserWindow: class {},
  app: { getVersion: () => '0.0.0-test' },
}))
const live = new Set<string>()
const pending = new Set<string>()
const spawnPty = vi.fn((_win: unknown, sid: string, _o: unknown) => { live.add(sid) })
const beginSpawnPreparation = vi.fn((win: unknown, sid: string) => {
  pending.add(sid)
  // A close (killPty) cancels it, as pty-manager's does.
  return { get current() { return pending.has(sid) }, spawn: (o: unknown) => { pending.delete(sid); spawnPty(win, sid, o) }, abandon: () => { pending.delete(sid) } }
})
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: (w: unknown, s: string, o: unknown) => spawnPty(w, s, o),
  writePty: vi.fn(), resizePty: vi.fn(),
  killPty: (id: string) => { live.delete(id); pending.delete(id) },
  getSshFlow: () => undefined, endSshRemote: vi.fn(),
  beginSpawnPreparation: (w: unknown, s: string) => beginSpawnPreparation(w, s),
  isSessionWritable: (id: string) => live.has(id),
  isSessionLiveOrStarting: (id: string) => live.has(id) || pending.has(id),
  endAgentRunsInFolder: async () => true,
}))
// The start's profile steps: pending until the test opens the gate.
const steps = vi.hoisted(() => ({ pending: false, settled: Promise.resolve() as Promise<void>, open: () => {} }))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  startProfileStepsPending: () => steps.pending,
  startProfileStepsSettled: () => steps.settled,
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
vi.mock('../../../src/main/help-workspace', () => ({ ensureHelpWorkspace: vi.fn(() => '/res/help'), helpWorkspaceDir: (dir: string) => `${dir}/help` }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res' }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
vi.mock('../../../src/main/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/hooks')>()),
  getGateway: () => null,
}))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({ launchRefusal: () => null, remoteLaunchRefusal: () => null }),
}))

const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
registerPtyHandlers(() => ({} as never))
const spawn = handlers.get('pty:spawn')!
const kill = handlers.get('pty:kill')!

const S = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const PROFILE = 'profile-abc123'
const outcome = async (p: unknown): Promise<string> => {
  try {
    const r = await p as { refused?: { code?: string }; started?: boolean } | undefined
    return r?.refused?.code ?? (r?.started === false ? 'not-started' : 'started')
  } catch (e) {
    return `threw: ${(e as Error).message}`
  }
}
/** Let every promise the handler is waiting on, other than the gate, settle. */
const settleAllButTheGate = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
/** Hold the start's profile steps: pending, settled only when the test opens the gate. */
function holdTheSteps(): void {
  steps.pending = true
  steps.settled = new Promise<void>((resolve) => {
    // As the account store's own: no longer pending once settled.
    steps.open = () => { steps.pending = false; resolve() }
  })
}

beforeEach(() => {
  live.clear(); pending.clear()
  spawnPty.mockClear(); beginSpawnPreparation.mockClear()
  steps.pending = false
  steps.settled = Promise.resolve()
  steps.open = () => {}
})

describe('a local Claude launch that names no account, while the start\'s profile steps are still to run', () => {
  // Mutation to prove this can fail: decide the hold false (or drop the wait for the steps).
  it('is held as a prepared spawn and starts only once the steps have run', async () => {
    holdTheSteps()
    const started = outcome(spawn({}, S, { cwd: 'C:/w' }))
    await settleAllButTheGate()
    expect(spawnPty).not.toHaveBeenCalled()
    expect(beginSpawnPreparation).toHaveBeenCalledTimes(1)
    expect(pending.has(S)).toBe(true)
    steps.open()
    expect(await started).toBe('started')
    expect(spawnPty).toHaveBeenCalledTimes(1)
    expect(live.has(S)).toBe(true)
  })

  // Mutation to prove this can fail: start the launch without holding it as a prepared spawn.
  it('a close of the tab while it waits starts nothing', async () => {
    holdTheSteps()
    const started = outcome(spawn({}, S, { cwd: 'C:/w' }))
    await settleAllButTheGate()
    kill({}, S)
    steps.open()
    expect(await started).toBe('not-started')
    expect(spawnPty).not.toHaveBeenCalled()
    expect(live.has(S)).toBe(false)
  })
})

describe('what the start\'s profile steps do not hold', () => {
  it('a launch naming an account, one over SSH and a terminal-only one start while the steps are still to run', async () => {
    holdTheSteps()
    const shapes: Array<Record<string, unknown>> = [
      { cwd: 'C:/w', profileId: PROFILE },
      { cwd: 'C:/w', ssh: { host: 'build-box', port: 22, username: 'nick', remotePath: '~/proj' } },
      { cwd: 'C:/w', shellOnly: true },
    ]
    for (const [i, options] of shapes.entries()) {
      const sid = `b${i}b2c3d4e5f6a1b2c3d4e5f6`
      expect(await outcome(spawn({}, sid, options)), JSON.stringify(options)).toBe('started')
      expect(live.has(sid)).toBe(true)
    }
    steps.open()
  })

  it('once the steps have run, a launch naming no account starts at once', async () => {
    expect(await outcome(spawn({}, S, { cwd: 'C:/w' }))).toBe('started')
    expect(spawnPty).toHaveBeenCalledTimes(1)
  })
})
