// tests/unit/channel-feature-state.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
const store = new Map<string, unknown>()
vi.mock('../../src/main/channel-storage', () => ({
  readJsonFile: <T>(n: string, seed: () => T): T => (store.has(n) ? store.get(n) as T : seed()),
  writeJsonFile: (n: string, d: unknown) => { store.set(n, d); return true },
}))
const { getFeatureState, setKillSwitch, markIntroShown } = await import('../../src/main/channel-feature-state')

describe('channel-feature-state', () => {
  beforeEach(() => store.clear())
  it('defaults: not disabled, intro not shown', () => {
    expect(getFeatureState()).toEqual({ disableConductorChannels: false, introShown: false })
  })
  it('setKillSwitch + markIntroShown persist independently', () => {
    setKillSwitch(true)
    markIntroShown()
    expect(getFeatureState()).toEqual({ disableConductorChannels: true, introShown: true })
  })
})
