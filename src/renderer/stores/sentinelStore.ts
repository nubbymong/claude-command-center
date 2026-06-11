// Renderer mirror of Sentinel state + panel-open UI state. Auto-opens the panel
// ONCE per completed analysis with open findings (spec §6), respecting the
// sentinelAutoOpen setting.
import { create } from 'zustand'
import type { SentinelStateSnapshot } from '../../shared/sentinel-types'
import { useSettingsStore } from './settingsStore'

interface SentinelUiState {
  snap: SentinelStateSnapshot | null
  panelOpen: boolean
  autoOpenedForAnalysisAt: number | null
  hydrate: () => Promise<void>
  setPanelOpen: (open: boolean) => void
  /** Pure transition used by the update handler; exported for tests. */
  applyUpdate: (next: SentinelStateSnapshot) => void
}

export const useSentinelStore = create<SentinelUiState>((set, get) => ({
  snap: null,
  panelOpen: false,
  autoOpenedForAnalysisAt: null,

  applyUpdate: (next) => {
    const prev = get()
    const autoOpenSetting = useSettingsStore.getState().settings.sentinelAutoOpen !== false
    const justFinished = !!prev.snap?.analyzing && !next.analyzing
    const hasOpen = next.findings.some((f) => f.status === 'open')
    const shouldAutoOpen =
      autoOpenSetting &&
      justFinished &&
      hasOpen &&
      next.lastAnalysisAt !== null &&
      next.lastAnalysisAt !== prev.autoOpenedForAnalysisAt
    set({
      snap: next,
      ...(shouldAutoOpen
        ? { panelOpen: true, autoOpenedForAnalysisAt: next.lastAnalysisAt }
        : {}),
    })
  },

  hydrate: async () => {
    // Subscribe before get (registryStore pattern); listener is process-lifetime.
    window.electronAPI.sentinel.onUpdate((snap) => get().applyUpdate(snap))
    const snap = await window.electronAPI.sentinel.getState()
    if (snap) set({ snap })
  },

  setPanelOpen: (open) => set({ panelOpen: open }),
}))
