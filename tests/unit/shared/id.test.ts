/**
 * #151 / CodeQL js/insecure-randomness -- regression guard for id generation.
 *
 * Ids were `Date.now().toString(36) + Math.random().toString(36).slice(2, 8)`.
 * CodeQL flagged the account add / re-auth login flows; the whole family now
 * routes through randomId(), which is backed by crypto.getRandomValues.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { randomId } from '../../../src/shared/id'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('randomId', () => {
  it('is 32 lowercase hex chars (128 bits)', () => {
    expect(randomId()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('applies a prefix without disturbing the hex body', () => {
    expect(randomId('ca-')).toMatch(/^ca-[0-9a-f]{32}$/)
  })

  it('is path-safe -- ids reach the filesystem as <statusDir>/<id>.json', () => {
    for (let i = 0; i < 200; i++) {
      const id = randomId()
      expect(id).not.toMatch(/[/\\:*?"<>|.]/)
    }
  })

  it('does not collide across a large sample', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20_000; i++) seen.add(randomId())
    expect(seen.size).toBe(20_000)
  })

  it('does NOT use Math.random', () => {
    const spy = vi.spyOn(Math, 'random')
    randomId()
    expect(spy).not.toHaveBeenCalled()
  })

  it('draws from crypto.getRandomValues', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues')
    randomId()
    expect(spy).toHaveBeenCalledOnce()
  })

  it('is not derived from the clock -- ids minted in the same tick differ', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    expect(randomId()).not.toBe(randomId())
  })

  it('pads low bytes rather than dropping them (fixed length always)', () => {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((a: Uint8Array) => {
      a.fill(0x05)
      return a
    }) as typeof globalThis.crypto.getRandomValues)
    expect(randomId()).toBe('05'.repeat(16))
  })
})
