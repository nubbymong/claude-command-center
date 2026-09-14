import { create } from 'zustand'

/**
 * A latch that stops the renderer writing config to disk.
 *
 * It exists for exactly one situation, and it is the worst one: the config
 * could not be READ. When `config:loadAll` rejects, App's boot catch hydrates
 * every store from `{}` — which is correct as a way to get a usable window, and
 * catastrophic as a starting point for saving. The stores now hold empty
 * defaults, so the first ordinary action (add a config, resize a panel, toggle
 * a setting) persists that emptiness over a configs.json that was probably
 * fine. The read failed; the data did not.
 *
 * So on that path writes are latched OFF until the user says otherwise. Nothing
 * is lost while the latch holds: quitting and fixing the file recovers
 * everything. `unlock()` is the deliberate escape — the notice offers it as
 * "start fresh anyway" — for someone who would rather have a working app than
 * the config they cannot load.
 *
 * A store rather than a module flag so the notice re-renders when it changes;
 * non-React callers read it with `getState()`.
 */
interface ConfigWriteLockState {
  /** Why writes are latched off, or null when they are allowed. */
  lockedReason: string | null
  lock: (reason: string) => void
  unlock: () => void
}

export const useConfigWriteLockStore = create<ConfigWriteLockState>((set) => ({
  lockedReason: null,
  lock: (reason) => set({ lockedReason: reason }),
  unlock: () => set({ lockedReason: null }),
}))

/** Non-React read: null when writing is allowed. */
export function configWritesLocked(): string | null {
  return useConfigWriteLockStore.getState().lockedReason
}
