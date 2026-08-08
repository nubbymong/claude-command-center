import { describe, it, expect } from 'vitest'
import { isAccountActive } from '../../../src/shared/account-types'

// The contract that lets existing accounts stay selectable with no migration:
// only an explicit `active: false` deactivates; anything else is active.
describe('isAccountActive', () => {
  it('treats a missing active field as active (pre-existing accounts, no migration)', () => {
    expect(isAccountActive({})).toBe(true)
    expect(isAccountActive({ active: undefined })).toBe(true)
  })

  it('is active when active is true', () => {
    expect(isAccountActive({ active: true })).toBe(true)
  })

  it('is inactive only when active is explicitly false', () => {
    expect(isAccountActive({ active: false })).toBe(false)
  })
})
