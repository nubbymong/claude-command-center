import { describe, it, expect } from 'vitest'
import { shouldShowAccountGate } from '../../../src/renderer/lib/accountGate'
describe('shouldShowAccountGate', () => {
  it('shows on first install/update (not decided)', () => {
    expect(shouldShowAccountGate({ decided: false, multiEnabled: false, globalChanged: false })).toBe(true)
  })
  it('does not show once decided with no account change', () => {
    expect(shouldShowAccountGate({ decided: true, multiEnabled: false, globalChanged: false })).toBe(false)
  })
  it('re-surfaces when the account changed while multi-account is off', () => {
    expect(shouldShowAccountGate({ decided: true, multiEnabled: false, globalChanged: true })).toBe(true)
  })
  it('does not re-show when enabled (live chip handles it)', () => {
    expect(shouldShowAccountGate({ decided: true, multiEnabled: true, globalChanged: true })).toBe(false)
  })
})
