// @vitest-environment jsdom
/**
 * #371 MAJOR-4 / MAJOR-5 / MINOR-5 — the vision settings round trip.
 *
 * `vision:getConfig` used to answer a bare `GlobalVisionConfig | null`, and null
 * meant two different things: "nothing saved yet" and "the file could not be
 * READ". The store took the second for the first, showed DEFAULT_CONFIG as if it
 * were the user's saved settings, and the next save wrote those defaults over
 * settings it had never read. `vision:saveConfig` then returned `{ ok: true }`
 * unconditionally, so a failed write also looked like a success.
 *
 * Main now reports `{ config, generation, readFailed }` and takes the generation
 * token back on save, refusing (`ok:false, stale:true`) a form built while the
 * file was unreadable. This covers the renderer half of that contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const getConfigMock = vi.fn()
const saveConfigMock = vi.fn()

;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  vision: {
    getConfig: getConfigMock,
    saveConfig: saveConfigMock,
    status: vi.fn(),
    onStatusChanged: vi.fn(),
  },
}

const { useConductorMcpStore } = await import('../../../src/renderer/stores/conductorMcpStore')

const DEFAULTS = { browser: 'chrome' as const, debugPort: 9222, headless: true }
const SAVED = { browser: 'edge' as const, debugPort: 9333, headless: false, url: 'https://example.test' }

describe('conductorMcpStore vision config persistence (#371)', () => {
  beforeEach(() => {
    getConfigMock.mockReset()
    saveConfigMock.mockReset()
    useConductorMcpStore.setState({
      visionConfig: { ...DEFAULTS },
      visionConfigGeneration: 0,
      visionConfigReadFailed: false,
      error: null,
    })
  })

  describe('loadConfig', () => {
    it('adopts the saved config and its generation token', async () => {
      getConfigMock.mockResolvedValue({ config: SAVED, generation: 7, readFailed: false })

      await useConductorMcpStore.getState().loadConfig()

      const s = useConductorMcpStore.getState()
      expect(s.visionConfig).toEqual(SAVED)
      expect(s.visionConfigGeneration).toBe(7)
      expect(s.visionConfigReadFailed).toBe(false)
      expect(s.error).toBeNull()
    })

    it('does NOT present defaults as saved settings when readFailed is true', async () => {
      getConfigMock.mockResolvedValue({ config: null, generation: 4, readFailed: true })

      await useConductorMcpStore.getState().loadConfig()

      const s = useConductorMcpStore.getState()
      // The panel must say the file could not be read rather than silently
      // rendering DEFAULT_CONFIG as if it were the user's settings.
      expect(s.visionConfigReadFailed).toBe(true)
      expect(s.error).toBeTruthy()
      expect(s.error).toMatch(/could not be read/i)
      expect(s.visionConfigGeneration).toBe(4)
    })

    it('a read failure does not overwrite the config already held', async () => {
      useConductorMcpStore.setState({ visionConfig: { ...SAVED }, visionConfigGeneration: 7 })
      getConfigMock.mockResolvedValue({ config: null, generation: 8, readFailed: true })

      await useConductorMcpStore.getState().loadConfig()

      expect(useConductorMcpStore.getState().visionConfig).toEqual(SAVED)
    })

    it('a genuine "nothing saved yet" (config null, readFailed false) is defaults with no error', async () => {
      getConfigMock.mockResolvedValue({ config: null, generation: 1, readFailed: false })

      await useConductorMcpStore.getState().loadConfig()

      const s = useConductorMcpStore.getState()
      expect(s.visionConfig).toEqual(DEFAULTS)
      expect(s.visionConfigReadFailed).toBe(false)
      expect(s.error).toBeNull()
    })
  })

  describe('saveConfig', () => {
    it('passes the generation token from the last load back to main', async () => {
      getConfigMock.mockResolvedValue({ config: SAVED, generation: 7, readFailed: false })
      await useConductorMcpStore.getState().loadConfig()
      saveConfigMock.mockResolvedValue({ ok: true })

      const next = { ...SAVED, debugPort: 9444 }
      await useConductorMcpStore.getState().saveConfig(next)

      expect(saveConfigMock).toHaveBeenCalledWith(next, 7)
    })

    it('does NOT commit visionConfig when main refuses the save as stale', async () => {
      useConductorMcpStore.setState({ visionConfig: { ...SAVED }, visionConfigGeneration: 2 })
      saveConfigMock.mockResolvedValue({
        ok: false,
        stale: true,
        error: 'Vision settings were not saved: these settings were shown before the settings file could be read.',
      })

      const result = await useConductorMcpStore.getState().saveConfig({ ...DEFAULTS })

      expect(result.ok).toBe(false)
      // The store keeps the config it actually loaded — the defaults the form
      // was built from never become the store's idea of "saved".
      expect(useConductorMcpStore.getState().visionConfig).toEqual(SAVED)
      expect(useConductorMcpStore.getState().error).toMatch(/were not saved/i)
    })

    it('does NOT commit visionConfig on a plain write failure', async () => {
      useConductorMcpStore.setState({ visionConfig: { ...SAVED }, visionConfigGeneration: 2 })
      saveConfigMock.mockResolvedValue({ ok: false, error: 'Vision settings could not be saved.' })

      const result = await useConductorMcpStore.getState().saveConfig({ ...DEFAULTS })

      expect(result.ok).toBe(false)
      expect(useConductorMcpStore.getState().visionConfig).toEqual(SAVED)
      expect(useConductorMcpStore.getState().error).toBe('Vision settings could not be saved.')
    })

    it('falls back to a plain-English error when main sends none', async () => {
      saveConfigMock.mockResolvedValue({ ok: false })

      const result = await useConductorMcpStore.getState().saveConfig({ ...DEFAULTS })

      expect(result.ok).toBe(false)
      expect(result.error).toBeTruthy()
      expect(useConductorMcpStore.getState().error).toBeTruthy()
    })

    it('commits the config and clears the error on success', async () => {
      useConductorMcpStore.setState({ error: 'stale failure from a previous attempt', visionConfigReadFailed: true })
      saveConfigMock.mockResolvedValue({ ok: true })

      const result = await useConductorMcpStore.getState().saveConfig({ ...SAVED })

      expect(result.ok).toBe(true)
      const s = useConductorMcpStore.getState()
      expect(s.visionConfig).toEqual(SAVED)
      expect(s.visionConfigReadFailed).toBe(false)
      expect(s.error).toBeNull()
    })
  })
})
