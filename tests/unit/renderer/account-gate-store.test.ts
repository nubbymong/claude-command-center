/**
 * accountGateStore -- unit tests for the pre-spawn account launch gate.
 *
 * Verifies:
 *   - requestChoice enqueues a pending gate and resolveChoice settles it FIFO.
 *   - isPending reflects whether a session has a queued gate.
 *   - predetermined flag round-trips (mark -> consume clears it).
 *   - the queue shifts so a second session's gate surfaces after the first.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useAccountGateStore } from '../../../src/renderer/stores/accountGateStore'

function reset() {
  useAccountGateStore.setState({ queue: [], predetermined: [] })
}

describe('accountGateStore', () => {
  beforeEach(reset)

  it('requestChoice enqueues a pending gate; isPending is true until resolved', async () => {
    const store = useAccountGateStore.getState()
    const p = store.requestChoice('s1', 'My session', undefined)

    expect(useAccountGateStore.getState().isPending('s1')).toBe(true)
    expect(useAccountGateStore.getState().queue[0]?.sessionLabel).toBe('My session')

    useAccountGateStore.getState().resolveChoice('profile-a')
    await expect(p).resolves.toBe('profile-a')
    expect(useAccountGateStore.getState().isPending('s1')).toBe(false)
  })

  it('resolves with undefined for the Default account choice', async () => {
    const p = useAccountGateStore.getState().requestChoice('s1', '', 'profile-x')
    useAccountGateStore.getState().resolveChoice(undefined)
    await expect(p).resolves.toBeUndefined()
  })

  it('processes the queue FIFO across two sessions', async () => {
    const a = useAccountGateStore.getState().requestChoice('s1', 'A', undefined)
    const b = useAccountGateStore.getState().requestChoice('s2', 'B', undefined)

    // Head is s1; s2 waits behind it.
    expect(useAccountGateStore.getState().queue.map((q) => q.sessionId)).toEqual(['s1', 's2'])

    useAccountGateStore.getState().resolveChoice('p1')
    await expect(a).resolves.toBe('p1')
    // Now s2 is the head.
    expect(useAccountGateStore.getState().queue.map((q) => q.sessionId)).toEqual(['s2'])

    useAccountGateStore.getState().resolveChoice('p2')
    await expect(b).resolves.toBe('p2')
    expect(useAccountGateStore.getState().queue).toHaveLength(0)
  })

  it('resolveChoice is a safe no-op when the queue is empty', () => {
    expect(() => useAccountGateStore.getState().resolveChoice('x')).not.toThrow()
  })

  it('predetermined: mark sets it, consume reads-and-clears, second consume is false', () => {
    const store = useAccountGateStore.getState()
    expect(store.consumePredetermined('s1')).toBe(false)

    store.markPredetermined('s1')
    expect(useAccountGateStore.getState().consumePredetermined('s1')).toBe(true)
    // Consumed -> cleared.
    expect(useAccountGateStore.getState().consumePredetermined('s1')).toBe(false)
  })

  it('markPredetermined is idempotent (no duplicate entries)', () => {
    const store = useAccountGateStore.getState()
    store.markPredetermined('s1')
    store.markPredetermined('s1')
    expect(useAccountGateStore.getState().predetermined.filter((id) => id === 's1')).toHaveLength(1)
  })
})
