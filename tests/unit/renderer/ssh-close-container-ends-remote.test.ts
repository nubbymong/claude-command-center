// @vitest-environment jsdom
// rc.14 review F12 (aicc_planning#56): closing a CONTAINER session tab must end
// the session-scoped claude inside the container.
//
// Container sessions force tmux persistence off, so the ordinary close never
// reached the persistent-session dialog -- the only route to "End remote" and
// the in-container kill -- and just killed the local PTY. The exec client
// dropping does not reliably end the process inside the container, so
// abandoned claudes accumulated there. Close now ends the remote first
// (best-effort, session-scoped), then closes as before.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const kill = vi.fn()
const endRemote = vi.fn(async () => {})
const persist = vi.fn(async () => {})
vi.mock('../../../src/renderer/ptyTracker', () => ({ killSessionPty: kill }))
vi.mock('../../../src/renderer/session-persistence', () => ({ persistSessionState: persist }))

const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { requestCloseSession, useSshCloseStore } = await import('../../../src/renderer/stores/sshCloseStore')

const base = {
  id: 'c1', configId: 'cfg-c', sessionType: 'ssh', label: 'container', workingDirectory: '~', createdAt: 0,
  color: 'blue', status: 'idle', model: '', sshTmuxPersistent: false,
}
const containerSession = {
  ...base,
  sshConfig: { host: 'rocky.local', port: 22, username: 'user', remotePath: '~', runtime: { type: 'container', engine: 'docker', container: 'ccc-test' } },
} as never
const legacyDockerSession = {
  ...base, id: 'c2',
  sshConfig: { host: 'rocky.local', port: 22, username: 'user', remotePath: '~', postCommand: 'docker exec -it ccc-test bash' },
} as never
const plainSshSession = {
  ...base, id: 'p1',
  sshConfig: { host: 'pi.local', port: 22, username: 'mong', remotePath: '~' },
} as never
// The pre-structured badge-only hint: the sidebar chip reads it, main never
// composes a container hop from it, so there is no in-container claude to end.
const badgeHintOnlySession = {
  ...base, id: 'h1',
  sshConfig: { host: 'pi.local', port: 22, username: 'mong', remotePath: '~', dockerContainer: 'ccc-test' },
} as never
const persistentSession = { ...plainSshSession, id: 'pp1', sshTmuxPersistent: true } as never

beforeEach(() => {
  kill.mockClear()
  endRemote.mockClear()
  useSessionStore.setState({ sessions: [] } as never)
  useSshCloseStore.setState({ pending: null } as never)
  ;(window as any).electronAPI = { ...((window as any).electronAPI ?? {}), ssh: { endRemote }, webview: { forget: vi.fn(async () => {}) } }
})

describe('requestCloseSession on a container session', () => {
  it('REGRESSION: ends the remote (session-scoped, with the config for the target lookup) BEFORE killing the local PTY, then closes', () => {
    useSessionStore.setState({ sessions: [containerSession] } as never)
    requestCloseSession('c1')
    expect(endRemote).toHaveBeenCalledWith({ sessionId: 'c1', configId: 'cfg-c' })
    expect(kill).toHaveBeenCalledWith('c1')
    expect(endRemote.mock.invocationCallOrder[0]).toBeLessThan(kill.mock.invocationCallOrder[0])
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useSshCloseStore.getState().pending).toBeNull() // no dialog: nothing to leave running
  })

  it('a legacy docker post-command session counts as a container session too', () => {
    useSessionStore.setState({ sessions: [legacyDockerSession] } as never)
    requestCloseSession('c2')
    expect(endRemote).toHaveBeenCalledWith({ sessionId: 'c2', configId: 'cfg-c' })
    expect(kill).toHaveBeenCalledWith('c2')
  })

  it('a session with only the badge-only dockerContainer hint (no runtime, no docker post-command) closes as before: no End remote', () => {
    useSessionStore.setState({ sessions: [badgeHintOnlySession] } as never)
    requestCloseSession('h1')
    expect(endRemote).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith('h1')
  })

  it('a plain (non-persistent, non-container) SSH session closes as before: no End remote', () => {
    useSessionStore.setState({ sessions: [plainSshSession] } as never)
    requestCloseSession('p1')
    expect(endRemote).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith('p1')
  })

  it('a persistent session still gets the End-or-Leave dialog, untouched', () => {
    useSessionStore.setState({ sessions: [persistentSession] } as never)
    requestCloseSession('pp1')
    expect(endRemote).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect(useSshCloseStore.getState().pending?.sessionId).toBe('pp1')
  })

  it('a missing preload never blocks the close', () => {
    ;(window as any).electronAPI = undefined
    useSessionStore.setState({ sessions: [containerSession] } as never)
    expect(() => requestCloseSession('c1')).not.toThrow()
    expect(kill).toHaveBeenCalledWith('c1')
  })
})
