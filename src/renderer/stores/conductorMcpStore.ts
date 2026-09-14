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
  /**
   * #371 MAJOR-5. The token main handed out with the config this store is
   * holding. It goes back with every save so main can refuse a save built from
   * defaults that were shown while the settings file was unreadable — by then
   * the read may have recovered elsewhere, so the latch alone cannot tell.
   * 0 means "never loaded"; the handler treats a mismatch as stale.
   */
  visionConfigGeneration: number
  /** True when the last load could not READ the settings, so `visionConfig`
   *  holds defaults that are NOT what is on disk. */
  visionConfigReadFailed: boolean

  // Error surface (shared across sub-tools)
  error: string | null

  // Actions
  loadConfig: () => Promise<void>
  saveConfig: (config: GlobalVisionConfig) => Promise<{ ok: boolean; error?: string }>
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
  visionConfigGeneration: 0,
  visionConfigReadFailed: false,
  error: null,

  // #371 MINOR-5/MAJOR-5. `config: null` is two different things and they need
  // opposite handling: "nothing saved yet" (defaults are the honest answer) and
  // "could not read the file" (defaults are a LIE that the user will then save
  // over their real settings). Main now says which, so say so too.
  loadConfig: async () => {
    set({ error: null })
    const result = await window.electronAPI.vision.getConfig()
    if (result.readFailed) {
      set({
        visionConfigGeneration: result.generation,
        visionConfigReadFailed: true,
        error: 'Vision settings could not be read, so the values shown are defaults, not your saved settings. Your settings file is untouched — reopen this panel once it is readable.',
      })
      return
    }
    set({
      visionConfig: result.config ?? { ...DEFAULT_CONFIG },
      visionConfigGeneration: result.generation,
      visionConfigReadFailed: false,
    })
  },

  saveConfig: async (config) => {
    set({ error: null })
    const result = await window.electronAPI.vision.saveConfig(config, get().visionConfigGeneration)
    if (!result.ok) {
      // Includes the `stale` case: the form was built from defaults shown while
      // the file was unreadable, so main refused to write them over the real
      // settings. Either way the config is NOT on disk — don't commit it here.
      const error = result.error || 'Vision settings could not be saved.'
      set({ error })
      return { ok: false, error }
    }
    set({ visionConfig: config, visionConfigReadFailed: false })
    return { ok: true }
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

// P2.3: module-local unsub so setupConductorMcpListener is idempotent — a
// repeated call (StrictMode double-invoke / remount) returns the existing
// teardown instead of installing a duplicate vision-status listener.
let mcpListenerUnsub: (() => void) | null = null

/** Call once from App.tsx -- sets up the global IPC listener. Never torn down. */
export function setupConductorMcpListener(): () => void {
  if (mcpListenerUnsub) return mcpListenerUnsub
  mcpListenerUnsub = window.electronAPI.vision.onStatusChanged((data) => {
    useConductorMcpStore.getState().handleStatusChanged(data)
  })
  return mcpListenerUnsub
}
