// @vitest-environment jsdom
/**
 * The two persistence fences around Ask Conductor.
 *
 *  1. `kind` MUST round-trip, or a restored Ask session comes back as an
 *     ordinary config-less session: plain tab dot, loose in the project list,
 *     no dock. Same silent-drop class as the loggingEnabled / detachable bugs,
 *     and buildSessionState is a field-by-field ALLOWLIST, so a new field is
 *     dropped by default.
 *
 *  2. `askPrompt` MUST NOT round-trip. That same allowlist is the entire
 *     mechanism keeping the user's typed question out of session-state.json --
 *     and out of the NEXT launch, which would re-submit it unasked.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionStore, type Session } from '../../../src/renderer/stores/sessionStore'
import { buildSessionState } from '../../../src/renderer/session-persistence'

const askSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'sess-ask-1',
  kind: 'ask',
  label: 'Ask Conductor',
  workingDirectory: 'C:/res/help',
  model: '',
  color: '#5d8bf0',
  identityColorKey: 'lavender',
  status: 'idle',
  createdAt: 1714850000000,
  sessionType: 'local',
  provider: 'claude',
  ...overrides,
})

describe('session-persistence -- Ask Conductor', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false })
  })

  it('serializes kind so the session comes back AS an Ask session', () => {
    useSessionStore.setState({ sessions: [askSession()], activeSessionId: 'sess-ask-1', isRestoring: false })
    expect(buildSessionState().sessions[0].kind).toBe('ask')
  })

  it('leaves kind unset for an ordinary project session', () => {
    useSessionStore.setState({
      sessions: [askSession({ id: 'proj', kind: undefined, configId: 'cfg1' })],
      activeSessionId: 'proj',
      isRestoring: false,
    })
    expect(buildSessionState().sessions[0].kind).toBeUndefined()
    expect(buildSessionState().sessions[0].configId).toBe('cfg1')
  })

  it('never writes an Ask session with a configId', () => {
    useSessionStore.setState({ sessions: [askSession()], activeSessionId: 'sess-ask-1', isRestoring: false })
    expect(buildSessionState().sessions[0].configId).toBeUndefined()
  })

  it('NEVER serializes askPrompt -- not the key, not the text', () => {
    const question = 'what is the $ cost of running two accounts?'
    useSessionStore.setState({
      sessions: [askSession({ askPrompt: question })],
      activeSessionId: 'sess-ask-1',
      isRestoring: false,
    })
    const state = buildSessionState()
    expect('askPrompt' in state.sessions[0]).toBe(false)
    // Belt and braces: the text must not reach disk under ANY key, including one
    // added later inside claudeOptions or a spread that reintroduces it.
    expect(JSON.stringify(state)).not.toContain(question)
    expect(JSON.stringify(state)).not.toContain('askPrompt')
  })
})
