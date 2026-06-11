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
    // Subscribe BEFORE the initial get so a reload firing in between is never
    // missed (every push is a full snapshot, so orderings self-correct).
    // Listener is deliberately process-lifetime: this store is a singleton and
    // App.tsx hydrates it at most once per renderer lifetime.
    window.electronAPI.registry.onUpdate((updated) => set({ registry: updated }))
    const reg = await window.electronAPI.registry.get()
    set({ registry: reg })
  },
  resolve: (modelId) => resolveModelInfo(get().registry, modelId),
}))
