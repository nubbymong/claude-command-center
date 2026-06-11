// Renderer snapshot of the model registry. Hydrated at startup, hot-reloaded
// via REGISTRY_UPDATE push. Components call resolve() so every surface
// re-renders with new registry data without a restart (spec §4).
import { create } from 'zustand'
import baselineJson from '../../../resources/model-registry.json'
import { resolveModelInfo, type ModelRegistry, type ResolvedModelInfo } from '../../shared/model-registry'

interface RegistryState {
  registry: ModelRegistry
  hydrate: () => Promise<void>
  resolve: (modelId: string) => ResolvedModelInfo
}

// Baseline as the synchronous initial value: first paint never sees an empty
// registry even if the IPC hydrate is in flight.
export const useRegistryStore = create<RegistryState>((set, get) => ({
  registry: baselineJson as unknown as ModelRegistry,
  hydrate: async () => {
    const reg = await window.electronAPI.registry.get()
    set({ registry: reg })
    window.electronAPI.registry.onUpdate((updated) => set({ registry: updated }))
  },
  resolve: (modelId) => resolveModelInfo(get().registry, modelId),
}))
