import { create } from 'zustand'

interface CodexAccountState {
  installed: boolean
  version: string | null
  authMode: 'chatgpt' | 'api-key' | 'none'
  planType?: string
  accountId?: string
  hasOpenAiApiKeyEnv: boolean
  loading: boolean

  refresh: () => Promise<void>
  loginChatgpt: () => Promise<{ ok: boolean; error?: string }>
  loginApiKey: (apiKey: string) => Promise<{ ok: boolean; error?: string }>
  loginDevice: () => Promise<{ ok: boolean; deviceCode?: string; error?: string }>
  logout: () => Promise<void>
  testConnection: () => Promise<{ ok: boolean; message: string }>
}

export const useCodexAccountStore = create<CodexAccountState>((set, get) => ({
  installed: false,
  version: null,
  authMode: 'none',
  hasOpenAiApiKeyEnv: false,
  loading: false,

  refresh: async () => {
    set({ loading: true })
    try {
      const status = await window.electronAPI.codex.status()
      set({
        installed: status.installed,
        version: status.version,
        authMode: status.authMode,
        planType: status.planType,
        accountId: status.accountId,
        hasOpenAiApiKeyEnv: status.hasOpenAiApiKeyEnv,
        loading: false,
      })
    } catch {
      set({ loading: false })
    }
  },

  loginChatgpt: async () => {
    const out = await window.electronAPI.codex.login({ mode: 'chatgpt' })
    await get().refresh()
    return { ok: out.ok, error: out.error }
  },

  loginApiKey: async (apiKey: string) => {
    const out = await window.electronAPI.codex.login({ mode: 'api-key', apiKey })
    await get().refresh()
    return { ok: out.ok, error: out.error }
  },

  loginDevice: async () => {
    const out = await window.electronAPI.codex.login({ mode: 'device' })
    await get().refresh()
    return { ok: out.ok, deviceCode: out.deviceCode, error: out.error }
  },

  logout: async () => {
    await window.electronAPI.codex.logout()
    await get().refresh()
  },

  testConnection: async () => {
    return await window.electronAPI.codex.testConnection()
  },
}))
