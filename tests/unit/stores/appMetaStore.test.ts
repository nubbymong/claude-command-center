import { describe, it, expect, beforeEach } from 'vitest'
import { useAppMetaStore } from '../../../src/renderer/stores/appMetaStore'

describe('appMetaStore', () => {
  beforeEach(() => {
    useAppMetaStore.setState({ meta: {}, isLoaded: false })
  })

  describe('hydrate', () => {
    it('sets meta and marks loaded', () => {
      useAppMetaStore.getState().hydrate({ setupVersion: '1.0.0', commandsSeeded: true })
      const state = useAppMetaStore.getState()
      expect(state.isLoaded).toBe(true)
      expect(state.meta.setupVersion).toBe('1.0.0')
      expect(state.meta.commandsSeeded).toBe(true)
    })
  })

  describe('update', () => {
    it('patches meta partially', () => {
      useAppMetaStore.getState().hydrate({ setupVersion: '1.0.0' })
      useAppMetaStore.getState().update({ lastSeenVersion: '1.2.0' })
      const meta = useAppMetaStore.getState().meta
      expect(meta.setupVersion).toBe('1.0.0')
      expect(meta.lastSeenVersion).toBe('1.2.0')
    })

    it('overwrites existing keys', () => {
      useAppMetaStore.getState().hydrate({ setupVersion: '1.0.0' })
      useAppMetaStore.getState().update({ setupVersion: '2.0.0' })
      expect(useAppMetaStore.getState().meta.setupVersion).toBe('2.0.0')
    })
  })

  describe('lastTrainingVersion', () => {
    it('hydrates with lastTrainingVersion', () => {
      useAppMetaStore.getState().hydrate({ lastTrainingVersion: '1.0.0' })
      expect(useAppMetaStore.getState().meta.lastTrainingVersion).toBe('1.0.0')
    })

    it('updates lastTrainingVersion independently', () => {
      useAppMetaStore.getState().hydrate({ setupVersion: '1.2.0', lastSeenVersion: '1.2.0' })
      useAppMetaStore.getState().update({ lastTrainingVersion: '1.0.0' })
      const meta = useAppMetaStore.getState().meta
      expect(meta.lastTrainingVersion).toBe('1.0.0')
      expect(meta.setupVersion).toBe('1.2.0')
      expect(meta.lastSeenVersion).toBe('1.2.0')
    })

    it('is undefined by default', () => {
      useAppMetaStore.getState().hydrate({})
      expect(useAppMetaStore.getState().meta.lastTrainingVersion).toBeUndefined()
    })
  })

  describe('onboarding fields', () => {
    it('hydrates completedSteps and onboardingCompletedVersion', () => {
      useAppMetaStore.getState().hydrate({ completedSteps: { welcome: '2.0.0' }, onboardingCompletedVersion: '2' })
      const meta = useAppMetaStore.getState().meta
      expect(meta.completedSteps).toEqual({ welcome: '2.0.0' })
      expect(meta.onboardingCompletedVersion).toBe('2')
    })

    it('are undefined by default', () => {
      useAppMetaStore.getState().hydrate({})
      const meta = useAppMetaStore.getState().meta
      expect(meta.completedSteps).toBeUndefined()
      expect(meta.onboardingCompletedVersion).toBeUndefined()
    })

    it('update merges a new completed step (caller spreads prev — top-level replace)', () => {
      useAppMetaStore.getState().hydrate({ completedSteps: { welcome: '2.0.0' } })
      const prev = useAppMetaStore.getState().meta.completedSteps ?? {}
      useAppMetaStore.getState().update({ completedSteps: { ...prev, statusline: '2.0.0' } })
      expect(useAppMetaStore.getState().meta.completedSteps).toEqual({ welcome: '2.0.0', statusline: '2.0.0' })
    })
  })
})
