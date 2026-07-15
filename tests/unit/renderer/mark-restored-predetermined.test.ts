// @vitest-environment jsdom
// Regression (issue #76): relaunch-restored sessions must CONTINUE under the
// account they were closed on, not re-pop the pre-spawn AccountLaunchGate. The
// restore path marks each restored session predetermined so its respawn skips
// the gate -- exactly like in-session Restart/Recover/Switch.
import { describe, it, expect, beforeEach } from 'vitest'
import { markRestoredSessionsPredetermined } from '../../../src/renderer/session-persistence'
import { useAccountGateStore } from '../../../src/renderer/stores/accountGateStore'

beforeEach(() => {
  useAccountGateStore.setState({ queue: [], predetermined: [] })
})

describe('markRestoredSessionsPredetermined', () => {
  it('marks every restored session predetermined so its spawn skips the gate', () => {
    markRestoredSessionsPredetermined(['s1', 's2', 's3'])
    const gate = useAccountGateStore.getState()
    // Each id is predetermined: consume returns true once, then clears.
    expect(gate.consumePredetermined('s1')).toBe(true)
    expect(gate.consumePredetermined('s2')).toBe(true)
    expect(gate.consumePredetermined('s3')).toBe(true)
    // Consumed -> cleared (a later in-session restart re-gates as normal).
    expect(useAccountGateStore.getState().consumePredetermined('s1')).toBe(false)
  })

  it('is a no-op for an empty restore set', () => {
    markRestoredSessionsPredetermined([])
    expect(useAccountGateStore.getState().predetermined).toHaveLength(0)
  })

  it('does not disturb an unrelated session (still gates as normal)', () => {
    markRestoredSessionsPredetermined(['s1'])
    // A brand-new (non-restored) session was never marked -> still needs the gate.
    expect(useAccountGateStore.getState().consumePredetermined('brand-new')).toBe(false)
  })
})
