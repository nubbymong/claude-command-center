// @vitest-environment jsdom
// P3.5 fix round 1, item D (a C item found in review; the introduction's
// spec already named it): the resume prompt does not block the app, and every
// write of the session file (the autosave on a tab added or closed, the
// account and GitHub flushes, Save and close) wrote the open tabs alone,
// overwriting on disk the saved set the prompt was still offering. A crash
// before the answer then lost it. While the offer is unanswered, every write
// keeps it: the offered tabs, then the open ones, each once.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildSessionState, setUnansweredRestore } from '../../../src/renderer/session-persistence'
import { useSessionStore, type Session } from '../../../src/renderer/stores/sessionStore'
import type { SessionState } from '../../../src/renderer/types/electron'

const live = (id: string): Session => ({ id, label: id, workingDirectory: 'C:\\p', model: '', color: '#89B4FA', status: 'idle', createdAt: 1, sessionType: 'local' })
const offer = (ids: string[], active: string | null = ids[0] ?? null): SessionState => ({
  sessions: ids.map((id) => ({ id, label: `saved ${id}`, workingDirectory: 'C:\\p', color: '#89B4FA', sessionType: 'local' })) as SessionState['sessions'],
  activeSessionId: active,
  savedAt: 1,
})

beforeEach(() => {
  useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false })
})
afterEach(() => {
  setUnansweredRestore(null)
})

describe('a session file written while the resume prompt is unanswered', () => {
  it('keeps the offered tabs, then the tabs open now', () => {
    setUnansweredRestore(offer(['a', 'b'], 'b'))
    useSessionStore.getState().addSession(live('new'))
    const state = buildSessionState()
    expect(state.sessions.map((s) => s.id)).toEqual(['a', 'b', 'new'])
    expect(state.sessions[0].label).toBe('saved a')
    expect(state.activeSessionId).toBe('new')
  })

  it('writes each tab once: an offered tab that is open now is written as it is now', () => {
    setUnansweredRestore(offer(['a', 'x']))
    useSessionStore.getState().addSession(live('x'))
    const state = buildSessionState()
    expect(state.sessions.map((s) => s.id)).toEqual(['a', 'x'])
    expect(state.sessions.find((s) => s.id === 'x')?.label).toBe('x')
  })

  it('with no tab open yet it writes the offer as it was, its active tab included', () => {
    setUnansweredRestore(offer(['a', 'b'], 'b'))
    const state = buildSessionState()
    expect(state.sessions.map((s) => s.id)).toEqual(['a', 'b'])
    expect(state.activeSessionId).toBe('b')
  })

  it('once the prompt is answered (Resume or Don\'t open), only the open tabs are written', () => {
    setUnansweredRestore(offer(['a', 'b']))
    setUnansweredRestore(null)
    useSessionStore.getState().addSession(live('new'))
    expect(buildSessionState().sessions.map((s) => s.id)).toEqual(['new'])
  })
})
