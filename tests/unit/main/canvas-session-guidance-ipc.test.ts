// [host] WP2 PR 4, P4.1 (row 51): `canvas:sessionGuidance`, the canvas page's
// read of whether a Codex session's launch carried the skills' guidance with
// the tools (section 10 question 5, default A). A pure read of main's own
// launch record, answered only to the app's own window (its top frame), with
// a strict payload; anything else gets nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: class {},
}))
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: vi.fn(), writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: vi.fn(), endSshRemote: vi.fn(),
  beginSpawnPreparation: vi.fn(), holdsCodexLaunchLease: () => false, codexLaunchLeaseTaken: () => false,
  isSessionLiveOrStarting: () => false, getKeptCodexConversationSource: () => undefined, getKeptCodexConversation: () => undefined,
  codexRunEnded: async () => true,
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn() }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => null }))
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))

const { IPC } = await import('../../../src/shared/ipc-channels')
const guidance = await import('../../../src/main/canvas/codex-guidance')
const { registerPtyHandlers } = await import('../../../src/main/ipc/pty-handlers')

const mainFrame = { id: 'top' }
const webContents = { mainFrame }
const win = { isDestroyed: () => false, webContents }
registerPtyHandlers(() => win as never)
const handler = handlers.get(IPC.CANVAS_SESSION_GUIDANCE)!
const fromApp = { sender: webContents, senderFrame: mainFrame }
const SID = 'gdnc1111gdnc1111gdnc1111'

beforeEach(() => {
  guidance._resetCodexGuidanceForTest()
})

describe('canvas:sessionGuidance', () => {
  it('is registered', () => {
    expect(typeof handler).toBe('function')
  })

  it('answers the app\'s window with the session\'s launch record', () => {
    expect(handler(fromApp, { sessionId: SID })).toBeNull()
    guidance.noteCodexSessionGuidance(SID, { guidance: 'tools-only', reason: 'npm-route' })
    expect(handler(fromApp, { sessionId: SID })).toEqual({ guidance: 'tools-only', reason: 'npm-route' })
  })

  it('answers nothing to another sender, or to a frame inside the window', () => {
    guidance.noteCodexSessionGuidance(SID, { guidance: 'full' })
    expect(handler({ sender: {}, senderFrame: mainFrame }, { sessionId: SID })).toBeNull()
    expect(handler({ sender: webContents, senderFrame: { id: 'child' } }, { sessionId: SID })).toBeNull()
  })

  it.each([
    ['no payload', undefined],
    ['an unknown key', { sessionId: SID, extra: 1 }],
    ['a session id that is not one', { sessionId: '../../etc' }],
    ['a session id of the wrong type', { sessionId: 42 }],
  ])('refuses %s', (_name, payload) => {
    guidance.noteCodexSessionGuidance(SID, { guidance: 'full' })
    expect(handler(fromApp, payload)).toBeNull()
  })
})
