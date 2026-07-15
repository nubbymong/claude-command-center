import { describe, it, expect } from 'vitest'
import { describeInsightsTimeout } from '../../src/main/insights-runner'

// Unit 3 W7 (safe half): the /insights PTY timeout now reports WHY it failed by
// how far it got, so the failure surfaced in the UI (W4) is meaningful instead of
// a raw truncated terminal dump.
describe('describeInsightsTimeout', () => {
  it('explains a no-report timeout after the command was sent (likely no usage data)', () => {
    const msg = describeInsightsTimeout(true, 600)
    expect(msg).toContain('did not produce a report')
    expect(msg).toContain('no usage data')
    expect(msg).toContain('600s')
  })

  it('explains a never-reached-prompt timeout', () => {
    const msg = describeInsightsTimeout(false, 600)
    expect(msg).toContain('did not reach an interactive prompt')
    expect(msg).toContain('600s')
  })
})
