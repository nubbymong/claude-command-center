// @vitest-environment jsdom
// rc.14 review F14 (aicc_planning#58): a session's transcript-indexing opt-out
// must survive Save -> relaunch -> restore.
//
// The serializer packed every other Claude option into `claudeOptions` but not
// `loggingEnabled`; restore read the missing field as undefined, and the
// run-registration gate treats undefined as "enabled" (global setting wins).
// So a session launched with indexing OFF came back indexed. The restore
// mapper already reads `claude?.loggingEnabled`; the serializer is the fix,
// and this test walks the whole chain: store -> serialize -> JSON -> the gate.
import { describe, it, expect, beforeEach } from 'vitest'
import { buildSessionState } from '../../../src/renderer/session-persistence'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import { shouldRegisterRun } from '../../../src/main/logging/should-register-run'

function seed(loggingEnabled: boolean | undefined) {
  useSessionStore.setState({
    sessions: [{
      id: 's1',
      label: 'local claude',
      provider: 'claude',
      sessionType: 'local',
      workingDirectory: 'C:\\work',
      createdAt: Date.now(),
      loggingEnabled,
    } as never],
    activeSessionId: 's1',
  } as never)
}

/** What App.tsx's restore does with the saved record: read from claudeOptions. */
function restoredLoggingEnabled(): boolean | undefined {
  const roundTripped = JSON.parse(JSON.stringify(buildSessionState()))
  const saved = roundTripped.sessions[0]
  expect(saved).toBeTruthy()
  return saved.claudeOptions?.loggingEnabled
}

beforeEach(() => {
  useSessionStore.setState({ sessions: [], activeSessionId: null } as never)
})

describe('session save/restore keeps the indexing opt-out', () => {
  it('REGRESSION: explicit false survives the round trip and the gate refuses to register the run', () => {
    seed(false)
    const restored = restoredLoggingEnabled()
    expect(restored).toBe(false)
    expect(shouldRegisterRun(
      { provider: 'claude', shellOnly: false, ssh: false, isAsk: false, loggingEnabled: restored },
      { loggingEnabled: true },
    )).toBe(false)
  })

  it('explicit true survives and registers', () => {
    seed(true)
    const restored = restoredLoggingEnabled()
    expect(restored).toBe(true)
    expect(shouldRegisterRun(
      { provider: 'claude', shellOnly: false, ssh: false, isAsk: false, loggingEnabled: restored },
      { loggingEnabled: true },
    )).toBe(true)
  })

  it('unspecified stays unspecified: the global setting decides, as before', () => {
    seed(undefined)
    const restored = restoredLoggingEnabled()
    expect(restored).toBeUndefined()
    expect(shouldRegisterRun(
      { provider: 'claude', shellOnly: false, ssh: false, isAsk: false, loggingEnabled: restored },
      { loggingEnabled: true },
    )).toBe(true)
    expect(shouldRegisterRun(
      { provider: 'claude', shellOnly: false, ssh: false, isAsk: false, loggingEnabled: restored },
      { loggingEnabled: false },
    )).toBe(false)
  })
})
