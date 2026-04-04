import { describe, it, expect, beforeEach } from 'vitest'
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'

describe('settingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: false })
  })

  describe('DEFAULT_SETTINGS', () => {
    it('has expected defaults', () => {
      expect(DEFAULT_SETTINGS.defaultModel).toBe('sonnet')
      expect(DEFAULT_SETTINGS.terminalFontSize).toBe(14)
      expect(DEFAULT_SETTINGS.debugMode).toBe(false)
    })

    it('localMachineName defaults to empty string', () => {
      expect(DEFAULT_SETTINGS.localMachineName).toBe('')
    })

    it('updateChannel defaults to stable', () => {
      expect(DEFAULT_SETTINGS.updateChannel).toBe('stable')
    })
  })

  describe('hydrate', () => {
    it('merges with defaults and marks loaded', () => {
      useSettingsStore.getState().hydrate({ defaultModel: 'opus' } as any)
      const state = useSettingsStore.getState()
      expect(state.isLoaded).toBe(true)
      expect(state.settings.defaultModel).toBe('opus')
      // Defaults preserved
      expect(state.settings.terminalFontSize).toBe(14)
    })

    it('fully overrides when all keys provided', () => {
      useSettingsStore.getState().hydrate({
        defaultModel: 'haiku',
        defaultWorkingDirectory: 'C:\\custom',
        terminalFontSize: 18,
        debugMode: true,
      })
      const s = useSettingsStore.getState().settings
      expect(s.defaultModel).toBe('haiku')
      expect(s.defaultWorkingDirectory).toBe('C:\\custom')
      expect(s.terminalFontSize).toBe(18)
      expect(s.debugMode).toBe(true)
    })
  })

  describe('updateSettings', () => {
    it('patches settings partially', () => {
      useSettingsStore.getState().hydrate(DEFAULT_SETTINGS)
      useSettingsStore.getState().updateSettings({ terminalFontSize: 20 })
      expect(useSettingsStore.getState().settings.terminalFontSize).toBe(20)
      // Other fields unchanged
      expect(useSettingsStore.getState().settings.defaultModel).toBe('sonnet')
    })
  })
})
