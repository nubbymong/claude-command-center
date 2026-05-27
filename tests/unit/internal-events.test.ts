// tests/unit/internal-events.test.ts
import { describe, it, expect, vi } from 'vitest'
import { emitInternal, onInternal } from '../../src/main/internal-events'

describe('internal-events', () => {
  it('delivers an emitted event to subscribers and unsubscribes cleanly', () => {
    const cb = vi.fn()
    const off = onInternal('pr:merged', cb)
    emitInternal('pr:merged', { repo: 'a/b', number: 48, branch: 'main' })
    expect(cb).toHaveBeenCalledWith({ repo: 'a/b', number: 48, branch: 'main' })
    off()
    emitInternal('pr:merged', { repo: 'a/b', number: 49, branch: 'main' })
    expect(cb).toHaveBeenCalledTimes(1)
  })
  it('a throwing subscriber does not break other subscribers', () => {
    const good = vi.fn()
    const offThrower = onInternal('ci:failed', () => { throw new Error('boom') })
    const offGood = onInternal('ci:failed', good)
    expect(() => emitInternal('ci:failed', { sessionId: 's', logTail: 'x' })).not.toThrow()
    expect(good).toHaveBeenCalled()
    offThrower()
    offGood()
  })
})
