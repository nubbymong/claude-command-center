import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCodexAccountStore } from '../../../src/renderer/stores/codexAccountStore'

describe('codexAccountStore', () => {
  beforeEach(() => {
    useCodexAccountStore.setState({
      installed: false,
      version: null,
      authMode: 'none',
      hasOpenAiApiKeyEnv: false,
      loading: false,
    })
    vi.mocked(window.electronAPI.codex.status).mockReset()
    vi.mocked(window.electronAPI.codex.login).mockReset()
    vi.mocked(window.electronAPI.codex.logout).mockReset()
    vi.mocked(window.electronAPI.codex.testConnection).mockReset()

    // Restore default return values after reset
    vi.mocked(window.electronAPI.codex.status).mockResolvedValue({
      installed: false,
      version: null,
      authMode: 'none' as const,
      hasOpenAiApiKeyEnv: false,
    })
    vi.mocked(window.electronAPI.codex.login).mockResolvedValue({ ok: true })
    vi.mocked(window.electronAPI.codex.logout).mockResolvedValue({ ok: true })
    vi.mocked(window.electronAPI.codex.testConnection).mockResolvedValue({ ok: true, message: 'connected' })
  })

  describe('initial state', () => {
    it('has correct defaults', () => {
      const state = useCodexAccountStore.getState()
      expect(state.installed).toBe(false)
      expect(state.authMode).toBe('none')
      expect(state.loading).toBe(false)
      expect(state.version).toBeNull()
      expect(state.hasOpenAiApiKeyEnv).toBe(false)
    })
  })

  describe('refresh()', () => {
    it('updates state from IPC status response', async () => {
      vi.mocked(window.electronAPI.codex.status).mockResolvedValueOnce({
        installed: true,
        version: '0.125.0',
        authMode: 'chatgpt' as const,
        planType: 'plus',
        hasOpenAiApiKeyEnv: false,
      })

      await useCodexAccountStore.getState().refresh()

      const state = useCodexAccountStore.getState()
      expect(state.installed).toBe(true)
      expect(state.version).toBe('0.125.0')
      expect(state.authMode).toBe('chatgpt')
      expect(state.planType).toBe('plus')
      expect(state.hasOpenAiApiKeyEnv).toBe(false)
      expect(state.loading).toBe(false)
    })

    it('clears loading flag even when IPC throws', async () => {
      vi.mocked(window.electronAPI.codex.status).mockRejectedValueOnce(new Error('IPC error'))

      await useCodexAccountStore.getState().refresh()

      expect(useCodexAccountStore.getState().loading).toBe(false)
    })
  })

  describe('loginApiKey()', () => {
    it('calls login IPC with correct mode and key, then refreshes', async () => {
      vi.mocked(window.electronAPI.codex.status).mockResolvedValueOnce({
        installed: true,
        version: '0.125.0',
        authMode: 'api-key' as const,
        hasOpenAiApiKeyEnv: false,
      })

      const result = await useCodexAccountStore.getState().loginApiKey('sk-test')

      expect(result.ok).toBe(true)
      expect(window.electronAPI.codex.login).toHaveBeenCalledWith({
        mode: 'api-key',
        apiKey: 'sk-test',
      })
      // status called once during refresh after login
      expect(window.electronAPI.codex.status).toHaveBeenCalledTimes(1)
      expect(useCodexAccountStore.getState().authMode).toBe('api-key')
    })
  })

  describe('loginChatgpt()', () => {
    it('loginChatgpt calls IPC with mode=chatgpt then refreshes', async () => {
      vi.mocked(window.electronAPI.codex.login)
        .mockResolvedValueOnce({ ok: true, browserUrl: 'https://login.example/abc' })
      const statusSpy = vi.mocked(window.electronAPI.codex.status)

      const out = await useCodexAccountStore.getState().loginChatgpt()

      expect(window.electronAPI.codex.login).toHaveBeenCalledWith({ mode: 'chatgpt' })
      expect(statusSpy).toHaveBeenCalled()
      expect(out.ok).toBe(true)
    })
  })

  describe('loginDevice()', () => {
    it('loginDevice surfaces deviceCode and refreshes', async () => {
      vi.mocked(window.electronAPI.codex.login)
        .mockResolvedValueOnce({ ok: true, deviceCode: 'DC-1234' })
      const statusSpy = vi.mocked(window.electronAPI.codex.status)

      const out = await useCodexAccountStore.getState().loginDevice()

      expect(window.electronAPI.codex.login).toHaveBeenCalledWith({ mode: 'device' })
      expect(statusSpy).toHaveBeenCalled()
      expect(out.deviceCode).toBe('DC-1234')
      expect(out.ok).toBe(true)
    })
  })
})
