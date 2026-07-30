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
  it('is 24 lowercase hex chars (96 bits) -- see ID_BYTES rationale', () => {
    expect(randomId()).toMatch(/^[0-9a-f]{24}$/)
  })

  it('applies a prefix without disturbing the hex body', () => {
    expect(randomId('ca-')).toMatch(/^ca-[0-9a-f]{24}$/)
  })

  it('is path-safe -- ids reach the filesystem as <statusDir>/<id>.json', () => {
    for (let i = 0; i < 200; i++) {
      const id = randomId()
      expect(id).not.toMatch(/[/\\:*?"<>|.]/)
    }
  })

  // Deliberately no "does not collide over N draws" test. Adversarial review
  // pointed out that 20k draws over a 2^128 space measures nothing -- the OLD
  // Math.random generator passed it too, so it had no discriminating power.

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

  // The obvious version of this test -- mock Date.now, assert two ids differ --
  // is vacuous: the OLD clock+Math.random generator passes it, because the
  // Math.random tail still differs. Adversarial review caught that. Invert it
  // instead: pin the randomness and assert the CLOCK contributes nothing, which
  // fails loudly on any implementation that mixes Date.now back in.
  it('is not derived from the clock -- output is clock-independent', () => {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((a: Uint8Array) => {
      a.fill(0xab)
      return a
    }) as typeof globalThis.crypto.getRandomValues)

    vi.spyOn(Date, 'now').mockReturnValue(1)
    const atEpoch = randomId()
    vi.spyOn(Date, 'now').mockReturnValue(9_999_999_999_999)
    expect(randomId()).toBe(atEpoch)
  })

  it('pads low bytes rather than dropping them (fixed length always)', () => {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((a: Uint8Array) => {
      a.fill(0x05)
      return a
    }) as typeof globalThis.crypto.getRandomValues)
    expect(randomId()).toBe('05'.repeat(12))
  })
})
