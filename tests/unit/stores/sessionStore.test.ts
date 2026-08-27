import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore, structuralSessionsEqual, Session } from '../../../src/renderer/stores/sessionStore'

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

    it('preserves the array AND session identity on a value-identical (no-op) patch', () => {
      useSessionStore.getState().addSession(makeSession({ id: 'a', contextPercent: 42 }))
      const before = useSessionStore.getState().sessions
      const beforeSession = before[0]
      // Re-send the SAME telemetry value (statusline bridge does this ~1-3×/s).
      useSessionStore.getState().updateSession('a', { contextPercent: 42 })
      const after = useSessionStore.getState().sessions
      // No re-render: both the array AND the session object keep identity.
      expect(after).toBe(before)
      expect(after[0]).toBe(beforeSession)
    })

    it('replaces only the matched session (others keep identity) on a real change', () => {
      useSessionStore.getState().addSession(makeSession({ id: 'a', contextPercent: 1 }))
      useSessionStore.getState().addSession(makeSession({ id: 'b', contextPercent: 1 }))
      const before = useSessionStore.getState().sessions
      const bBefore = before[1]
      useSessionStore.getState().updateSession('a', { contextPercent: 2 })
      const after = useSessionStore.getState().sessions
      expect(after).not.toBe(before)              // array identity changes
      expect(after[0]).not.toBe(before[0])         // updated session is fresh
      expect(after[1]).toBe(bBefore)               // untouched session keeps identity
    })

    it('is a no-op for an unknown id', () => {
      useSessionStore.getState().addSession(makeSession({ id: 'a' }))
      const before = useSessionStore.getState().sessions
      useSessionStore.getState().updateSession('missing', { label: 'x' })
      expect(useSessionStore.getState().sessions).toBe(before)
    })
  })

  describe('structuralSessionsEqual', () => {
    it('treats telemetry-only changes as equal (skips a root re-render)', () => {
      const a = [makeSession({ id: 'a', contextPercent: 10, costUsd: 1 })]
      const b = [{ ...a[0], contextPercent: 99, costUsd: 50, status: 'working' as const }]
      expect(structuralSessionsEqual(a, b)).toBe(true)
    })

    it('is false when a structural field changes (configId / cwd / length)', () => {
      const a = [makeSession({ id: 'a', configId: 'cfg-1' })]
      expect(structuralSessionsEqual(a, [{ ...a[0], configId: 'cfg-2' }])).toBe(false)
      expect(structuralSessionsEqual(a, [{ ...a[0], workingDirectory: 'C:\\new' }])).toBe(false)
      expect(structuralSessionsEqual(a, [a[0], makeSession({ id: 'b' })])).toBe(false)
    })

    it('short-circuits true on reference equality', () => {
      const a = [makeSession({ id: 'a' })]
      expect(structuralSessionsEqual(a, a)).toBe(true)
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

  describe('rename (customName)', () => {
    it('beginRename sets/clears the renaming session id', () => {
      useSessionStore.getState().addSession(makeSession({ id: 'a' }))
      useSessionStore.getState().beginRename('a')
      expect(useSessionStore.getState().renamingSessionId).toBe('a')
      useSessionStore.getState().beginRename(null)
      expect(useSessionStore.getState().renamingSessionId).toBeNull()
    })

    it('renameSession sets a trimmed customName and exits rename mode', () => {
      useSessionStore.getState().addSession(makeSession({ id: 'a', label: 'Config A' }))
      useSessionStore.getState().beginRename('a')
      useSessionStore.getState().renameSession('a', '  IM-8315 keychain fix  ')
      const s = useSessionStore.getState().sessions[0]
      expect(s.customName).toBe('IM-8315 keychain fix')
      expect(s.label).toBe('Config A') // origin label is untouched
      expect(useSessionStore.getState().renamingSessionId).toBeNull()
    })

    it('blank/whitespace name clears customName (reverts to label)', () => {
      useSessionStore.getState().addSession(makeSession({ id: 'a', customName: 'old name' }))
      useSessionStore.getState().renameSession('a', '   ')
      expect(useSessionStore.getState().sessions[0].customName).toBeUndefined()
    })

    it('renameSession persists the effective name to the logs DB (best-effort IPC)', () => {
      const renameSessionIpc = vi.fn()
      ;(globalThis as any).window = { electronAPI: { logs2: { renameSession: renameSessionIpc } } }
      useSessionStore.getState().addSession(makeSession({ id: 'a', label: 'Config A' }))

      useSessionStore.getState().renameSession('a', 'Boot perf')
      // #536: customName (the user's own work name) rides alongside configLabel so
      // the transcript sidecar carries the work name, never the generic config label.
      expect(renameSessionIpc).toHaveBeenCalledWith({ sessionId: 'a', configLabel: 'Boot perf', customName: 'Boot perf' })

      // Blank => effective label falls back to the config label.
      useSessionStore.getState().renameSession('a', '   ')
      // A blank rename sends an EMPTY customName — the real "cleared" signal that
      // removes the sidecar — while configLabel still falls back to the label.
      expect(renameSessionIpc).toHaveBeenLastCalledWith({ sessionId: 'a', configLabel: 'Config A', customName: '' })

      delete (globalThis as any).window
    })

    it('renameSession does not throw when the preload bridge is absent', () => {
      delete (globalThis as any).window
      useSessionStore.getState().addSession(makeSession({ id: 'a' }))
      expect(() => useSessionStore.getState().renameSession('a', 'x')).not.toThrow()
    })
  })
})
