import { create } from 'zustand'
import type { GlobalVisionConfig } from '../../shared/types'

interface ConductorMcpState {
  // Server-level
  serverRunning: boolean
  mcpPort: number

  // Vision sub-tool
  visionConfig: GlobalVisionConfig
  browserRunning: boolean
  browserConnected: boolean

  // Error surface (shared across sub-tools)
  error: string | null

  // Actions
  loadConfig: () => Promise<void>
  saveConfig: (config: GlobalVisionConfig) => Promise<void>
  launchBrowser: () => Promise<void>
  stopBrowser: () => Promise<void>
  fetchStatus: () => Promise<void>
  handleStatusChanged: (data: { connected: boolean; browser: string; mcpPort: number }) => void
}

const DEFAULT_CONFIG: GlobalVisionConfig = {
  browser: 'chrome',
  debugPort: 9222,
  headless: true,
}

export const useConductorMcpStore = create<ConductorMcpState>((set, get) => ({
  // P7.7.16: serverRunning is derived from mcpPort > 0 rather than hardcoded
  // true. The MCP listener is *intended* to be always running after boot
  // (P7.3), but EADDRINUSE or a startMcpServer error can leave it un-bound;
  // SidebarNav's dot should not lie in those cases. Initial false until the
  // first fetchStatus / handleStatusChanged confirms a real port.
  serverRunning: false,
  mcpPort: 0,
  visionConfig: { ...DEFAULT_CONFIG },
  browserRunning: false,
  browserConnected: false,
  error: null,

  loadConfig: async () => {
    const config = await window.electronAPI.vision.getConfig()
    if (config) set({ visionConfig: config })
  },

  saveConfig: async (config) => {
    await window.electronAPI.vision.saveConfig(config)
    set({ visionConfig: config })
  },

  launchBrowser: async () => {
    set({ error: null })
    const { visionConfig } = get()
    // P7.7.12: debugPort is value-ignored main-side -- the IPC handler resolves
    // it via resolveCdpPort(isPackagedApp()) so a stale saved config can't
    // defeat the dev/prod CDP-port split. The argument stays in the call to
    // preserve the IPC signature; do not add UI controls for visionConfig.debugPort
    // without re-enabling the handler-side use too.
    const result = await window.electronAPI.vision.launch(
      visionConfig.browser,
      visionConfig.debugPort,
      visionConfig.url,
      visionConfig.headless ?? true,
    )
    if (result.ok) {
      set({ browserRunning: true })
    } else {
      set({ error: result.error || 'Failed to launch browser' })
    }
  },

  stopBrowser: async () => {
    await window.electronAPI.vision.stop()
    set({ browserRunning: false, browserConnected: false, error: null })
  },

  fetchStatus: async () => {
    const status = await window.electronAPI.vision.status()
    if (status) {
      const port = status.mcpPort || 0
      set({
        browserRunning: status.running,
        browserConnected: status.connected,
        mcpPort: port,
        serverRunning: port > 0,
      })
    }
  },

  handleStatusChanged: (data) => {
    set({
      browserConnected: data.connected,
      mcpPort: data.mcpPort,
      serverRunning: data.mcpPort > 0,
    })
  },
}))

/** Call once from App.tsx -- sets up the global IPC listener. Never torn down. */
export function setupConductorMcpListener(): () => void {
  return window.electronAPI.vision.onStatusChanged((data) => {
    useConductorMcpStore.getState().handleStatusChanged(data)
  })
}
