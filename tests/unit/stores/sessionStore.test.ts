import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionStore, Session } from '../../../src/renderer/stores/sessionStore'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-' + Math.random().toString(36).slice(2, 8),
    label: 'Test Session',
    workingDirectory: 'C:\\dev\\project',
    model: 'sonnet',
    color: '#89B4FA',
    status: 'idle',
    createdAt: Date.now(),
    sessionType: 'local',
    ...overrides,
  }
}

describe('sessionStore', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false })
  })

  describe('addSession', () => {
    it('adds a session and activates it', () => {
      const session = makeSession({ id: 'a' })
      useSessionStore.getState().addSession(session)
      const state = useSessionStore.getState()
      expect(state.sessions).toHaveLength(1)
      expect(state.sessions[0].id).toBe('a')
      expect(state.activeSessionId).toBe('a')
    })

    it('switches active to newly added session', () => {
      const s1 = makeSession({ id: 'a' })
      const s2 = makeSession({ id: 'b' })
      useSessionStore.getState().addSession(s1)
      useSessionStore.getState().addSession(s2)
      expect(useSessionStore.getState().activeSessionId).toBe('b')
    })

    it('preserves all session properties', () => {
      const session = makeSession({
        id: 'full',
        configId: 'cfg-1',
        shellOnly: true,
        partnerTerminalPath: 'C:\\shell',
        sessionType: 'ssh',
        sshConfig: {
          host: '192.168.1.1',
          port: 22,
          username: 'user',
          remotePath: '/home/user',
        },
      })
      useSessionStore.getState().addSession(session)
      const stored = useSessionStore.getState().sessions[0]
      expect(stored.configId).toBe('cfg-1')
      expect(stored.shellOnly).toBe(true)
      expect(stored.sshConfig?.host).toBe('192.168.1.1')
    })
  })

  describe('removeSession', () => {
    it('removes a session by id', () => {
      const s1 = makeSession({ id: 'a' })
      const s2 = makeSession({ id: 'b' })
      useSessionStore.getState().addSession(s1)
      useSessionStore.getState().addSession(s2)
      useSessionStore.getState().removeSession('a')
      expect(useSessionStore.getState().sessions).toHaveLength(1)
      expect(useSessionStore.getState().sessions[0].id).toBe('b')
    })

    it('switches active session to last remaining when active is removed', () => {
      const s1 = makeSession({ id: 'a' })
      const s2 = makeSession({ id: 'b' })
      useSessionStore.getState().addSession(s1)
      useSessionStore.getState().addSession(s2)
      // b is active now
      useSessionStore.getState().removeSession('b')
      expect(useSessionStore.getState().activeSessionId).toBe('a')
    })

    it('sets activeSessionId to null when last session removed', () => {
      const s1 = makeSession({ id: 'a' })
      useSessionStore.getState().addSession(s1)
      useSessionStore.getState().removeSession('a')
      expect(useSessionStore.getState().activeSessionId).toBeNull()
      expect(useSessionStore.getState().sessions).toHaveLength(0)
    })

    it('keeps active unchanged when non-active session is removed', () => {
      const s1 = makeSession({ id: 'a' })
      const s2 = makeSession({ id: 'b' })
      useSessionStore.getState().addSession(s1)
      useSessionStore.getState().addSession(s2)
      useSessionStore.getState().setActiveSession('a')
      useSessionStore.getState().removeSession('b')
      expect(useSessionStore.getState().activeSessionId).toBe('a')
    })
  })

  describe('setActiveSession', () => {
    it('switches active session', () => {
      const s1 = makeSession({ id: 'a' })
      const s2 = makeSession({ id: 'b' })
      useSessionStore.getState().addSession(s1)
      useSessionStore.getState().addSession(s2)
      useSessionStore.getState().setActiveSession('a')
      expect(useSessionStore.getState().activeSessionId).toBe('a')
    })
  })

  describe('updateSession', () => {
    it('updates session properties', () => {
      const session = makeSession({ id: 'a', label: 'Old' })
      useSessionStore.getState().addSession(session)
      useSessionStore.getState().updateSession('a', { label: 'New', status: 'working' })
      const updated = useSessionStore.getState().sessions[0]
      expect(updated.label).toBe('New')
      expect(updated.status).toBe('working')
    })

    it('does not affect other sessions', () => {
      const s1 = makeSession({ id: 'a', label: 'A' })
      const s2 = makeSession({ id: 'b', label: 'B' })
      useSessionStore.getState().addSession(s1)
      useSessionStore.getState().addSession(s2)
      useSessionStore.getState().updateSession('a', { label: 'A-Updated' })
      expect(useSessionStore.getState().sessions[1].label).toBe('B')
    })
  })

  describe('getSession', () => {
    it('returns session by id', () => {
      const session = makeSession({ id: 'a', label: 'Find Me' })
      useSessionStore.getState().addSession(session)
      expect(useSessionStore.getState().getSession('a')?.label).toBe('Find Me')
    })

    it('returns undefined for missing id', () => {
      expect(useSessionStore.getState().getSession('nonexistent')).toBeUndefined()
    })
  })

  describe('hasWorkingSessions', () => {
    it('returns false when no sessions', () => {
      expect(useSessionStore.getState().hasWorkingSessions()).toBe(false)
    })

    it('returns true when a session is working', () => {
      useSessionStore.getState().addSession(makeSession({ id: 'a', status: 'working' }))
      expect(useSessionStore.getState().hasWorkingSessions()).toBe(true)
    })

    it('returns false when all sessions idle', () => {
      useSessionStore.getState().addSession(makeSession({ id: 'a', status: 'idle' }))
      useSessionStore.getState().addSession(makeSession({ id: 'b', status: 'complete' }))
      expect(useSessionStore.getState().hasWorkingSessions()).toBe(false)
    })
  })

  describe('restoreSessions', () => {
    it('bulk restores sessions with active id', () => {
      const sessions = [makeSession({ id: 'a' }), makeSession({ id: 'b' })]
      useSessionStore.getState().restoreSessions(sessions, 'b')
      const state = useSessionStore.getState()
      expect(state.sessions).toHaveLength(2)
      expect(state.activeSessionId).toBe('b')
      expect(state.isRestoring).toBe(false)
    })

    it('falls back to first session if activeId is null', () => {
      const sessions = [makeSession({ id: 'a' }), makeSession({ id: 'b' })]
      useSessionStore.getState().restoreSessions(sessions, null)
      expect(useSessionStore.getState().activeSessionId).toBe('a')
    })

    it('handles empty restore', () => {
      useSessionStore.getState().restoreSessions([], null)
      expect(useSessionStore.getState().sessions).toHaveLength(0)
      expect(useSessionStore.getState().activeSessionId).toBeNull()
    })
  })
})
