// [host] WP2 PR 4, P4.3 (row 53), the IPC side (src/main/ipc/pty-handlers.ts):
//  - `askConductor:handOff`: a question for a live Ask session on Codex,
//    answered only to the app's own window (its top frame), with a strict
//    payload, and handed to main's submit-primitive door
//    (pty-manager handOffAskQuestion), never written raw;
//  - the help folder rebuilt in main before EVERY Ask spawn of either
//    assistant (a first launch, a revive, a Restart, Past discussions, an
//    account switch's remount, a restored tab all come through pty:spawn),
//    last before the spawn, and failing closed: no rebuild, no launch.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  order: [] as string[],
  rebuildThrows: null as Error | null,
  handOffs: [] as Array<{ sessionId: string; question: string }>,
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { h.handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: class {},
  app: { getVersion: () => '9.9.9-test' },
}))
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: vi.fn(() => { h.order.push('spawn') }), writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: vi.fn(), endSshRemote: vi.fn(),
  beginSpawnPreparation: vi.fn(() => ({ current: true, spawn: () => { h.order.push('spawn') }, abandon: vi.fn() })),
  holdsCodexLaunchLease: () => false, codexLaunchLeaseTaken: () => false,
  isSessionLiveOrStarting: () => false, getKeptCodexConversationSource: () => undefined, getKeptCodexConversation: () => undefined,
  codexRunEnded: async () => true,
  handOffAskQuestion: vi.fn(async (_win: unknown, sessionId: string, question: string) => { h.handOffs.push({ sessionId, question }); return { delivered: true } }),
}))
vi.mock('../../../src/main/help-workspace', () => ({
  ensureHelpWorkspace: vi.fn((dir: string, opts: { appVersion?: string }) => {
    h.order.push(`rebuild ${dir} ${opts?.appVersion}`)
    if (h.rebuildThrows) throw h.rebuildThrows
    return `${dir}/help`
  }),
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => 'C:/res' }))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn() }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null }))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    prepareLaunch: async () => ({ ok: true, lease: { release: vi.fn(), accountId: 'acct-1' }, executable: '/proven/codex', env: {}, sessionsDir: '/s', home: '/h' }),
    snapshot: () => ({ providers: [] }),
    remoteLaunchRefusal: () => null,
  }),
}))
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))

const { IPC } = await import('../../../src/shared/ipc-channels')
const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')
const ptyManager = await import('../../../src/main/pty-manager')

const mainFrame = { id: 'top' }
const webContents = { mainFrame }
const win = { isDestroyed: () => false, webContents }
registerPtyHandlers(() => win as never)
const handOff = h.handlers.get(IPC.ASK_CONDUCTOR_HAND_OFF)!
const spawn = h.handlers.get('pty:spawn')!
const fromApp = { sender: webContents, senderFrame: mainFrame }
const SID = 'askh1111askh1111askh1111'

beforeEach(() => {
  h.order = []
  h.rebuildThrows = null
  h.handOffs = []
  vi.mocked(ptyManager.handOffAskQuestion).mockClear()
})

describe('askConductor:handOff', () => {
  it('[host] is registered', () => {
    expect(typeof handOff).toBe('function')
  })

  it('[host] the app\'s window: the question goes to main\'s submit-primitive door, whole', async () => {
    expect(await handOff(fromApp, { sessionId: SID, question: 'and then?' })).toEqual({ delivered: true })
    expect(h.handOffs).toEqual([{ sessionId: SID, question: 'and then?' }])
  })

  it('[host] another sender, or a frame inside the window: nothing handed over', async () => {
    expect(await handOff({ sender: {}, senderFrame: mainFrame }, { sessionId: SID, question: 'x' })).toEqual({ delivered: false, reason: 'session-gone' })
    expect(await handOff({ sender: webContents, senderFrame: { id: 'child' } }, { sessionId: SID, question: 'x' })).toEqual({ delivered: false, reason: 'session-gone' })
    expect(h.handOffs).toEqual([])
  })

  it.each([
    ['no payload', undefined],
    ['an unknown key', { sessionId: SID, question: 'x', raw: true }],
    ['a session id that is not one', { sessionId: '../../etc', question: 'x' }],
    ['an empty question', { sessionId: SID, question: '' }],
    ['a question past 8,000 characters', { sessionId: SID, question: 'q'.repeat(8_001) }],
    ['a question of the wrong type', { sessionId: SID, question: 42 }],
  ])('[host] refuses %s', async (_name, payload) => {
    expect(await handOff(fromApp, payload)).toEqual({ delivered: false, reason: 'refused-text' })
    expect(h.handOffs).toEqual([])
  })
})

describe('the help folder is rebuilt before every Ask spawn', () => {
  it('[host] a Claude Ask spawn: rebuilt in main, then spawned', async () => {
    await spawn({}, SID, { cwd: 'C:/res/help', isAsk: true })
    expect(h.order).toEqual(['rebuild C:/res 9.9.9-test', 'spawn'])
  })

  it('[host] a Codex Ask spawn: rebuilt last, after the account is prepared, then spawned', async () => {
    await spawn({}, SID, { cwd: 'C:/res/help', isAsk: true, provider: 'codex', codexOptions: { permissionsPreset: 'standard' } })
    expect(h.order).toEqual(['rebuild C:/res 9.9.9-test', 'spawn'])
  })

  it('[host] a rebuild that fails starts nothing (fails closed)', async () => {
    h.rebuildThrows = new Error('EPERM')
    await expect(spawn({}, SID, { cwd: 'C:/res/help', isAsk: true, provider: 'codex', codexOptions: { permissionsPreset: 'standard' } })).rejects.toThrow(/help folder could not be rebuilt/)
    expect(h.order).toEqual(['rebuild C:/res 9.9.9-test'])
  })

  it('[host] not for a session that is not Ask\'s, nor for the Ask tab\'s shell', async () => {
    await spawn({}, SID, { cwd: 'C:/dev/project' })
    await spawn({}, 'askh2222askh2222askh2222', { cwd: 'C:/res/help', isAsk: true, shellOnly: true })
    expect(h.order).toEqual(['spawn', 'spawn'])
  })
})
