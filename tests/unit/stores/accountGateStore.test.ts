import { describe, it, expect, beforeEach } from 'vitest'
import { useAccountGateStore, GATE_CANCELLED } from '../../../src/renderer/stores/accountGateStore'

describe('accountGateStore', () => {
  beforeEach(() => {
    useAccountGateStore.setState({ queue: [], predetermined: [] })
  })

  it('resolveChoice answers the head request with the chosen profile', async () => {
    const p = useAccountGateStore.getState().requestChoice('s1', 'Session 1', undefined)
    expect(useAccountGateStore.getState().isPending('s1')).toBe(true)
    useAccountGateStore.getState().resolveChoice('profile-a')
    await expect(p).resolves.toBe('profile-a')
    expect(useAccountGateStore.getState().queue).toHaveLength(0)
  })

  it('cancelChoice resolves the head request with GATE_CANCELLED and empties the slot', async () => {
    const p = useAccountGateStore.getState().requestChoice('s1', 'Session 1', 'profile-a')
    useAccountGateStore.getState().cancelChoice()
    await expect(p).resolves.toBe(GATE_CANCELLED)
    expect(useAccountGateStore.getState().queue).toHaveLength(0)
  })

  it('cancel only affects the head; the next queued gate still resolves normally', async () => {
    const p1 = useAccountGateStore.getState().requestChoice('s1', 'Session 1', undefined)
    const p2 = useAccountGateStore.getState().requestChoice('s2', 'Session 2', undefined)
    useAccountGateStore.getState().cancelChoice()
    useAccountGateStore.getState().resolveChoice('profile-b')
    await expect(p1).resolves.toBe(GATE_CANCELLED)
    await expect(p2).resolves.toBe('profile-b')
  })
})
