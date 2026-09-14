/**
 * Which session teardowns wipe the browser profile, and which must not (#371).
 *
 * `persist:webview-<sessionId>` holds the pane's cookies. Closing a session for
 * good should take them with it; a RESTART and an in-tile ACCOUNT SWITCH must
 * not, because both tear the tile down and rebuild it under the SAME session id
 * — wiping there would sign the user out of every site in the pane every time
 * they restarted a session.
 *
 * That is exactly why the wipe is not wired into `sessionStore.removeSession`,
 * which all of them call. This file is the guard on that decision: point it at
 * the store action and the "restart keeps its cookies" tests go red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const forget = vi.fn(() => Promise.resolve(true))

vi.stubGlobal('window', {
  electronAPI: {
    webview: { forget },
    pty: { write: vi.fn(), kill: vi.fn() },
  },
})

vi.mock('../../../src/renderer/ptyTracker', () => ({
  killSessionPty: vi.fn(),
  clearSpawned: vi.fn(),
}))

const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useWebviewStore } = await import('../../../src/renderer/stores/webviewStore')
const { requestCloseSession, leaveRunningAndClose, forgetSessionBrowserProfile } = await import(
  '../../../src/renderer/stores/sshCloseStore'
)

const session = (over: Record<string, unknown> = {}) => ({
  id: 'sess-1',
  label: 'One',
  status: 'idle',
  createdAt: 1,
  ...over,
}) as never

beforeEach(() => {
  forget.mockClear()
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  useWebviewStore.setState({ bySessionId: {} })
})

describe('closing a session for good takes its browser profile with it', () => {
  it('an ordinary tab close wipes the profile', () => {
    useSessionStore.setState({ sessions: [session()], activeSessionId: 'sess-1' })
    requestCloseSession('sess-1')
    expect(forget).toHaveBeenCalledWith('sess-1')
    expect(useSessionStore.getState().sessions).toHaveLength(0)
  })

  it('"leave running" on a persistent SSH session wipes it too', () => {
    useSessionStore.setState({ sessions: [session()], activeSessionId: 'sess-1' })
    leaveRunningAndClose('sess-1')
    expect(forget).toHaveBeenCalledWith('sess-1')
  })

  it('drops the renderer-side pane state as well', () => {
    useSessionStore.setState({ sessions: [session()], activeSessionId: 'sess-1' })
    useWebviewStore.setState({ bySessionId: { 'sess-1': { url: 'https://x.test/' } as never } })
    requestCloseSession('sess-1')
    expect(useWebviewStore.getState().bySessionId['sess-1']).toBeUndefined()
  })

  it('a persistent SSH session asks first and wipes nothing yet', () => {
    useSessionStore.setState({
      sessions: [session({ sessionType: 'ssh', sshTmuxPersistent: true })],
      activeSessionId: 'sess-1',
    })
    requestCloseSession('sess-1')
    expect(forget).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions).toHaveLength(1) // still open, dialog pending
  })

  it('a failing wipe never blocks the close', () => {
    forget.mockRejectedValueOnce(new Error('locked'))
    useSessionStore.setState({ sessions: [session()], activeSessionId: 'sess-1' })
    expect(() => requestCloseSession('sess-1')).not.toThrow()
    expect(useSessionStore.getState().sessions).toHaveLength(0)
  })

  it('survives a missing preload rather than taking the close down with it', () => {
    vi.stubGlobal('window', {})
    expect(() => forgetSessionBrowserProfile('sess-1')).not.toThrow()
    vi.stubGlobal('window', { electronAPI: { webview: { forget } } })
  })
})

describe('a teardown that re-uses the session id keeps its cookies', () => {
  it('removeSession on its own wipes nothing — this is what restart and account-switch call', () => {
    useSessionStore.setState({ sessions: [session()], activeSessionId: 'sess-1' })

    // Exactly what useRestartSession.forceRemount does: same id, new createdAt.
    const store = useSessionStore.getState()
    store.removeSession('sess-1')
    store.addSession(session({ createdAt: 2 }))

    expect(forget).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions[0].id).toBe('sess-1')
  })
})
