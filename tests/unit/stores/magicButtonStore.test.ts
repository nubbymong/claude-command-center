import { describe, it, expect, beforeEach } from 'vitest'
import { useMagicButtonStore, MAGIC_BUTTON_DEFAULTS } from '../../../src/renderer/stores/magicButtonStore'

describe('magicButtonStore', () => {
  beforeEach(() => {
    useMagicButtonStore.setState({ settings: { ...MAGIC_BUTTON_DEFAULTS }, isLoaded: false })
  })

  describe('MAGIC_BUTTON_DEFAULTS', () => {
    it('has expected defaults', () => {
      expect(MAGIC_BUTTON_DEFAULTS.screenshotColor).toBe('#00FFFF')
      expect(MAGIC_BUTTON_DEFAULTS.autoDeleteDays).toBeNull()
    })
  })

  describe('hydrate', () => {
    it('merges with defaults', () => {
      useMagicButtonStore.getState().hydrate({ screenshotColor: '#FF0000' } as any)
      const state = useMagicButtonStore.getState()
      expect(state.isLoaded).toBe(true)
      expect(state.settings.screenshotColor).toBe('#FF0000')
      expect(state.settings.autoDeleteDays).toBeNull() // default preserved
    })
  })

  describe('updateSettings', () => {
    it('patches settings', () => {
      useMagicButtonStore.getState().hydrate(MAGIC_BUTTON_DEFAULTS)
      useMagicButtonStore.getState().updateSettings({ autoDeleteDays: 7 })
      expect(useMagicButtonStore.getState().settings.autoDeleteDays).toBe(7)
      expect(useMagicButtonStore.getState().settings.screenshotColor).toBe('#00FFFF')
    })
  })
})
