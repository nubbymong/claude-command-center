/**
 * P6.10.1 regression: enableCodexReview propagates through buildSessionState
 * into claudeOptions.enableCodexReview on persistence (sparse boolean: true
 * when on, undefined when off). Mirrors disableAutoMemory's pattern.
 *
 * Why this exists: the original P6.6 commit wired the toggle into
 * SessionDialog and Session type, but the persistence-and-restore chain
 * dropped the flag. This test pins the propagation contract so a future
 * refactor cannot silently break it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionStore, type Session } from '../../../src/renderer/stores/sessionStore'
import { buildSessionState } from '../../../src/renderer/session-persistence'

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'sess-codex-review-1',
  label: 'test',
  workingDirectory: 'C:/work',
  model: '',
  color: '#89B4FA',
  status: 'idle',
  createdAt: 1714850000000,
  sessionType: 'local',
  provider: 'claude',
  ...overrides,
})

describe('session-persistence buildSessionState -- enableCodexReview (P6.10.1)', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], activeSessionId: null, isRestoring: false })
  })

  it('writes enableCodexReview=true into claudeOptions when the session opted in', () => {
    useSessionStore.setState({
      sessions: [makeSession({ enableCodexReview: true })],
      activeSessionId: 'sess-codex-review-1',
      isRestoring: false,
    })
    const state = buildSessionState()
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0].claudeOptions?.enableCodexReview).toBe(true)
  })

  it('omits enableCodexReview when the session has not opted in (sparse storage)', () => {
    useSessionStore.setState({
      sessions: [makeSession({ enableCodexReview: false })],
      activeSessionId: 'sess-codex-review-1',
      isRestoring: false,
    })
    const state = buildSessionState()
    expect(state.sessions[0].claudeOptions?.enableCodexReview).toBeUndefined()
  })

  it('omits enableCodexReview when the field is unset on the session', () => {
    useSessionStore.setState({
      sessions: [makeSession()],
      activeSessionId: 'sess-codex-review-1',
      isRestoring: false,
    })
    const state = buildSessionState()
    expect(state.sessions[0].claudeOptions?.enableCodexReview).toBeUndefined()
  })

  it('does not write claudeOptions at all for Codex sessions', () => {
    useSessionStore.setState({
      sessions: [makeSession({ provider: 'codex', enableCodexReview: true })],
      activeSessionId: 'sess-codex-review-1',
      isRestoring: false,
    })
    const state = buildSessionState()
    expect(state.sessions[0].claudeOptions).toBeUndefined()
  })
})
