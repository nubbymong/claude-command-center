// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { IDENTITY_SWATCHES } from '../../../src/renderer/components/SessionDialog'
import { IDENTITY_COLOR_KEYS } from '../../../src/shared/identity-colors'

describe('IDENTITY_SWATCHES', () => {
  it('offers exactly the curated identity keys', () => {
    expect([...IDENTITY_SWATCHES]).toEqual([...IDENTITY_COLOR_KEYS])
  })
  it('offers no reserved status/brand/link hue', () => {
    for (const banned of ['red', 'green', 'teal', 'amber', 'yellow', 'sky', 'blue', 'copper']) {
      expect(IDENTITY_SWATCHES).not.toContain(banned as any)
    }
  })
})
