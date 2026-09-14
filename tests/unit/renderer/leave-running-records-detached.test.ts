/**
 * SSH Persistent — the close-path wiring (Phase 1 lifecycle).
 *
 * "Leave running" must record the detached remote in the registry BEFORE tearing
 * the tab down AND flush it to disk (so it survives an app restart); "End remote"
 * must drop it. This exercises the real sshCloseStore + session-persistence +
 * registry store together, so it also pins that buildSessionState folds the
 * registry into the persisted state that reaches `session.save`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionState } from '../../../src/shared/types'

const save = vi.fn(() => Promise.resolve(true))
const endRemote = vi.fn(() => Promise.resolve())

vi.stubGlobal('window', {
  electronAPI: {
    webview: { forget: vi.fn(() => Promise.resolve(true)) },
    pty: { write: vi.fn(), kill: vi.fn() },
    session: { save },
    ssh: { endRemote },
  },
})

vi.mock('../../../src/renderer/ptyTracker', () => ({
  killSessionPty: vi.fn(),
  clearSpawned: vi.fn(),
}))

const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useDetachedRemotesStore } = await import('../../../src/renderer/stores/detachedRemotesStore')
const { leaveRunningAndClose, endRemoteAndClose } = await import('../../../src/renderer/stores/sshCloseStore')

const sshSession = (over: Record<string, unknown> = {}) => ({
  id: 'ssh-1',
  label: 'Pi',
  workingDirectory: '',
  color: '#fff',
  status: 'idle',
  createdAt: 1,
  sessionType: 'ssh',
  provider: 'claude',
  sshConfig: { host: 'pi.local', port: 22, username: 'mong', remotePath: '~/work' },
  sshRemoteAccount: 'mong@example.com',
  sshTmuxPersistent: true,
  ...over,
}) as never

beforeEach(() => {
  save.mockClear()
  endRemote.mockClear()
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  useDetachedRemotesStore.setState({ entries: [] })
})

describe('Leave running records the detached remote', () => {
  it('records an entry (keyed by session id) and removes the tab', () => {
    useSessionStore.setState({ sessions: [sshSession()], activeSessionId: 'ssh-1' })
    leaveRunningAndClose('ssh-1')

    const { entries } = useDetachedRemotesStore.getState()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      sessionId: 'ssh-1',
      configId: undefined,
      host: 'pi.local',
      username: 'mong',
      remotePath: '~/work',
      mux: 'tmux',
      accountEmail: 'mong@example.com',
      label: 'Pi',
    })
    expect(useSessionStore.getState().sessions).toHaveLength(0)
  })

  it('flushes a state that carries the entry to session.save (buildSessionState folds the registry in)', () => {
    useSessionStore.setState({ sessions: [sshSession({ configId: 'cfg-9' })], activeSessionId: 'ssh-1' })
    leaveRunningAndClose('ssh-1')

    // persistSessionState builds the arg synchronously before awaiting save.
    expect(save).toHaveBeenCalledTimes(1)
    const saved = save.mock.calls[0][0] as SessionState
    expect(saved.detachedRemotes?.map((e) => e.sessionId)).toEqual(['ssh-1'])
    expect(saved.detachedRemotes?.[0].configId).toBe('cfg-9')
  })

  it('records NOTHING (and does not flush) for a non-SSH session', () => {
    useSessionStore.setState({ sessions: [sshSession({ id: 'local-1', sessionType: 'local', sshConfig: undefined })], activeSessionId: 'local-1' })
    leaveRunningAndClose('local-1')
    expect(useDetachedRemotesStore.getState().entries).toHaveLength(0)
    expect(save).not.toHaveBeenCalled()
  })
})

describe('End remote drops the registry entry', () => {
  it('removes the entry for the ended session and flushes', async () => {
    useSessionStore.setState({ sessions: [sshSession()], activeSessionId: 'ssh-1' })
    useDetachedRemotesStore.setState({
      entries: [
        { sessionId: 'ssh-1', configId: undefined, host: 'pi.local', username: 'mong', remotePath: '~/work', mux: 'tmux', label: 'Pi', detachedAt: 1 },
        { sessionId: 'other', configId: undefined, host: 'h', username: 'u', remotePath: '/p', mux: 'tmux', label: 'O', detachedAt: 1 },
      ],
    })

    await endRemoteAndClose('ssh-1')

    expect(endRemote).toHaveBeenCalledWith('ssh-1')
    expect(useDetachedRemotesStore.getState().entries.map((e) => e.sessionId)).toEqual(['other'])
    const saved = save.mock.calls.at(-1)?.[0] as SessionState
    expect(saved.detachedRemotes?.map((e) => e.sessionId)).toEqual(['other'])
  })
})
