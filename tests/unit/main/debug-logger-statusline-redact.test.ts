import { describe, it, expect, vi } from 'vitest'

// The global setup.ts mocks debug-logger to prevent file I/O during other
// tests. We need the real redactStatuslinePayload here, so use importActual.
vi.mock('../../../src/main/debug-logger', async () => {
  const actual = await vi.importActual<typeof import('../../../src/main/debug-logger')>('../../../src/main/debug-logger')
  return actual
})

import { redactStatuslinePayload } from '../../../src/main/debug-logger'

describe('redactStatuslinePayload', () => {
  it('replaces accountEmail with <redacted>', () => {
    expect(redactStatuslinePayload({ accountEmail: 'a@b.com' })).toEqual({ accountEmail: '<redacted>' })
  })

  it('preserves other fields verbatim', () => {
    expect(redactStatuslinePayload({ accountEmail: 'a@b.com', model: 'sonnet', inputTokens: 100 })).toEqual({
      accountEmail: '<redacted>',
      model: 'sonnet',
      inputTokens: 100,
    })
  })

  it('passes through when accountEmail is absent', () => {
    expect(redactStatuslinePayload({ model: 'sonnet' })).toEqual({ model: 'sonnet' })
  })
})
