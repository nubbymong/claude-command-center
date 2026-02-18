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
})
