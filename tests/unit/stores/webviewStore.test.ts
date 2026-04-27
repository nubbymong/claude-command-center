import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useWebviewStore, pollUrlForContent, probeWebviewUrls } from '../../../src/renderer/stores/webviewStore'

const checkMock = (window as any).electronAPI.webview.check as ReturnType<typeof vi.fn>

describe('webviewStore', () => {
  beforeEach(() => {
    useWebviewStore.setState({ bySessionId: {} })
    checkMock.mockReset()
    checkMock.mockResolvedValue({ reachable: false })
  })

  describe('state transitions', () => {
    it('starts with no state for unknown session', () => {
      expect(useWebviewStore.getState().bySessionId['s1']).toBeUndefined()
    })

    it('startActivation sets pending + records URL', () => {
      useWebviewStore.getState().startActivation('s1', 'http://localhost:3000')
      const s = useWebviewStore.getState().bySessionId['s1']
      expect(s.status).toBe('pending')
      expect(s.currentUrl).toBe('http://localhost:3000')
      expect(s.loadedAt).toBeNull()
    })

    it('markAvailable sets available + stamps loadedAt', () => {
      useWebviewStore.getState().markAvailable('s1', 'http://localhost:3000')
      const s = useWebviewStore.getState().bySessionId['s1']
      expect(s.status).toBe('available')
      expect(s.currentUrl).toBe('http://localhost:3000')
      expect(s.loadedAt).toBeGreaterThan(0)
    })

    it('markFailed flips to failed without changing URL', () => {
      useWebviewStore.getState().startActivation('s1', 'http://localhost:3000')
      useWebviewStore.getState().markFailed('s1')
      const s = useWebviewStore.getState().bySessionId['s1']
      expect(s.status).toBe('failed')
      expect(s.currentUrl).toBe('http://localhost:3000')
    })

    it('togglePane flips isOpen', () => {
      useWebviewStore.getState().startActivation('s1', 'http://localhost:3000')
      useWebviewStore.getState().togglePane('s1')
      expect(useWebviewStore.getState().bySessionId['s1'].isOpen).toBe(true)
      useWebviewStore.getState().togglePane('s1')
      expect(useWebviewStore.getState().bySessionId['s1'].isOpen).toBe(false)
    })

    it('reset wipes session state', () => {
      useWebviewStore.getState().startActivation('s1', 'http://localhost:3000')
      useWebviewStore.getState().reset('s1')
      expect(useWebviewStore.getState().bySessionId['s1']).toBeUndefined()
    })
  })

  describe('pollUrlForContent', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns true on first reachable response', async () => {
      checkMock.mockResolvedValueOnce({ reachable: true })
      const result = await pollUrlForContent('http://x', { intervalMs: 10, timeoutMs: 100 })
      expect(result).toBe(true)
      expect(checkMock).toHaveBeenCalledTimes(1)
    })

    it('keeps polling until reachable', async () => {
      checkMock
        .mockResolvedValueOnce({ reachable: false })
        .mockResolvedValueOnce({ reachable: false })
        .mockResolvedValueOnce({ reachable: true })
      const result = await pollUrlForContent('http://x', { intervalMs: 5, timeoutMs: 200 })
      expect(result).toBe(true)
      expect(checkMock).toHaveBeenCalledTimes(3)
    })

    it('returns false when timeout exceeded', async () => {
      checkMock.mockResolvedValue({ reachable: false })
      const result = await pollUrlForContent('http://x', { intervalMs: 5, timeoutMs: 30 })
      expect(result).toBe(false)
    })

    it('keeps polling through thrown errors', async () => {
      checkMock
        .mockRejectedValueOnce(new Error('net'))
        .mockResolvedValueOnce({ reachable: true })
      const result = await pollUrlForContent('http://x', { intervalMs: 5, timeoutMs: 100 })
      expect(result).toBe(true)
      expect(checkMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('probeWebviewUrls (auto-detect)', () => {
    it('returns false + makes no calls when url list is empty', async () => {
      const result = await probeWebviewUrls('s1', [])
      expect(result).toBe(false)
      expect(checkMock).not.toHaveBeenCalled()
    })

    it('promotes idle → available on first reachable URL', async () => {
      checkMock.mockResolvedValueOnce({ reachable: true })
      const result = await probeWebviewUrls('s1', ['http://localhost:3000'])
      expect(result).toBe(true)
      const s = useWebviewStore.getState().bySessionId['s1']
      expect(s.status).toBe('available')
      expect(s.currentUrl).toBe('http://localhost:3000')
    })

    it('promotes failed → available when server comes back', async () => {
      useWebviewStore.getState().startActivation('s1', 'http://localhost:3000')
      useWebviewStore.getState().markFailed('s1')
      checkMock.mockResolvedValueOnce({ reachable: true })
      await probeWebviewUrls('s1', ['http://localhost:3000'])
      expect(useWebviewStore.getState().bySessionId['s1'].status).toBe('available')
    })

    it('skips probing while status=pending (active poll owns state)', async () => {
      useWebviewStore.getState().startActivation('s1', 'http://localhost:3000')
      const result = await probeWebviewUrls('s1', ['http://localhost:3000'])
      expect(result).toBe(false)
      expect(checkMock).not.toHaveBeenCalled()
      expect(useWebviewStore.getState().bySessionId['s1'].status).toBe('pending')
    })

    it('re-probes available URLs (so server-down can downgrade to failed)', async () => {
      useWebviewStore.getState().markAvailable('s1', 'http://localhost:3000')
      checkMock.mockResolvedValueOnce({ reachable: true })
      const result = await probeWebviewUrls('s1', ['http://localhost:3000'])
      expect(result).toBe(true)
      expect(checkMock).toHaveBeenCalledTimes(1)
      expect(useWebviewStore.getState().bySessionId['s1'].status).toBe('available')
    })

    it('downgrades available → failed when no URL is reachable anymore', async () => {
      useWebviewStore.getState().markAvailable('s1', 'http://localhost:3000')
      checkMock.mockResolvedValue({ reachable: false })
      const result = await probeWebviewUrls('s1', ['http://localhost:3000'])
      expect(result).toBe(false)
      expect(useWebviewStore.getState().bySessionId['s1'].status).toBe('failed')
    })

    it('leaves idle as idle when no URL is reachable (no false-failure)', async () => {
      checkMock.mockResolvedValue({ reachable: false })
      const result = await probeWebviewUrls('s1', ['http://localhost:3000'])
      expect(result).toBe(false)
      expect(useWebviewStore.getState().bySessionId['s1']).toBeUndefined()
    })

    it('tries the next URL when the first is unreachable', async () => {
      checkMock
        .mockResolvedValueOnce({ reachable: false })
        .mockResolvedValueOnce({ reachable: true })
      const result = await probeWebviewUrls('s1', ['http://a:3000', 'http://b:3000'])
      expect(result).toBe(true)
      expect(checkMock).toHaveBeenCalledTimes(2)
      expect(useWebviewStore.getState().bySessionId['s1'].currentUrl).toBe('http://b:3000')
    })

    it('returns false when all URLs unreachable', async () => {
      checkMock.mockResolvedValue({ reachable: false })
      const result = await probeWebviewUrls('s1', ['http://a:3000', 'http://b:3000'])
      expect(result).toBe(false)
      expect(useWebviewStore.getState().bySessionId['s1']).toBeUndefined()
    })

    it('treats thrown errors as unreachable + continues', async () => {
      checkMock
        .mockRejectedValueOnce(new Error('refused'))
        .mockResolvedValueOnce({ reachable: true })
      const result = await probeWebviewUrls('s1', ['http://a:3000', 'http://b:3000'])
      expect(result).toBe(true)
      expect(useWebviewStore.getState().bySessionId['s1'].currentUrl).toBe('http://b:3000')
    })
  })
})
