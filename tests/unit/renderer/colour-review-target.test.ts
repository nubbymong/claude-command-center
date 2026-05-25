import { describe, it, expect } from 'vitest'
import { pickColourReviewTarget } from '../../../src/renderer/utils/migrateIdentityColors'

describe('pickColourReviewTarget', () => {
  it('picks the first migrated config', () => {
    expect(pickColourReviewTarget([{ id: 'a' }, { id: 'b', legacyColor: '#FF3366' }], []))
      .toEqual({ kind: 'config', configId: 'b' })
  })
  it('falls back to a migrated session mapped to an existing config', () => {
    expect(pickColourReviewTarget([{ id: 'a' }], [{ configId: 'a', legacyColor: '#00FFFF' }]))
      .toEqual({ kind: 'config', configId: 'a' })
  })
  it('returns none when the migrated session config no longer exists', () => {
    expect(pickColourReviewTarget([{ id: 'a' }], [{ configId: 'gone', legacyColor: '#00FFFF' }]))
      .toEqual({ kind: 'none' })
  })
  it('returns none when nothing was migrated', () => {
    expect(pickColourReviewTarget([{ id: 'a' }], [{ configId: 'a' }])).toEqual({ kind: 'none' })
  })
})
