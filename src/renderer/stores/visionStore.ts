import { create } from 'zustand'
import type { GlobalVisionConfig } from '../../shared/types'

interface VisionState {
  config: GlobalVisionConfig
  running: boolean
  connected: boolean
  mcpPort: number
  error: string | null

  loadConfig: () => Promise<void>
  saveConfig: (config: GlobalVisionConfig) => Promise<void>
  start: () => Promise<void>
  stop: () => Promise<void>
  launchBrowser: () => Promise<void>
  fetchStatus: () => Promise<void>
  handleStatusChanged: (data: { connected: boolean; browser: string; mcpPort: number }) => void
}

const DEFAULT_CONFIG: GlobalVisionConfig = {
  enabled: false,
  browser: 'chrome',
  debugPort: 9222,
  mcpPort: 19333,
  headless: true
}

export const useVisionStore = create<VisionState>((set, get) => ({
  config: { ...DEFAULT_CONFIG },
  running: false,
  connected: false,
  mcpPort: 0,
  error: null,

  loadConfig: async () => {
    const config = await window.electronAPI.vision.getConfig()
    if (config) set({ config })
  },

  saveConfig: async (config) => {
    await window.electronAPI.vision.saveConfig(config)
    set({ config })
  },

  start: async () => {
    set({ error: null })
    const result = await window.electronAPI.vision.start()
    if (result.ok) {
      set({ running: true })
    } else {
      set({ error: result.error || 'Failed to start' })
    }
  },

  stop: async () => {
    await window.electronAPI.vision.stop()
    set({ running: false, connected: false, mcpPort: 0, error: null })
  },

  launchBrowser: async () => {
    const { config } = get()
    const result = await window.electronAPI.vision.launch(
      config.browser,
      config.debugPort,
      config.url,
      config.headless ?? true
    )
    if (!result.ok) {
      set({ error: result.error || 'Failed to launch browser' })
    }
  },

  fetchStatus: async () => {
    const status = await window.electronAPI.vision.status()
    if (status) {
      set({
        running: status.running,
        connected: status.connected,
        mcpPort: status.mcpPort || 0
      })
    }
  },

  handleStatusChanged: (data) => {
    set({ connected: data.connected, mcpPort: data.mcpPort })
  },
}))

/** Call once from App.tsx — sets up the global IPC listener. Never torn down. */
export function setupVisionListener(): () => void {
  return window.electronAPI.vision.onStatusChanged((data: any) => {
    useVisionStore.getState().handleStatusChanged(data)
  })
}
