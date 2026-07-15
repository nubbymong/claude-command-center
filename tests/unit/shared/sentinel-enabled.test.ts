import { describe, it, expect } from 'vitest'
import { isSentinelEnabled } from '../../../src/shared/sentinel-enabled'

// Sentinel is OPT-IN: it spends Claude tokens (a `claude -p` run on a Claude Code
// version change), so it must never run without explicit consent. Absent or false
// = OFF; only an explicit `true` enables it.
describe('isSentinelEnabled (opt-in)', () => {
  it('is OFF when absent (fresh install -- no token spend without consent)', () => {
    expect(isSentinelEnabled(undefined)).toBe(false)
  })
  it('is OFF when explicitly false', () => {
    expect(isSentinelEnabled(false)).toBe(false)
  })
  it('is ON only when explicitly true', () => {
    expect(isSentinelEnabled(true)).toBe(true)
  })
})
