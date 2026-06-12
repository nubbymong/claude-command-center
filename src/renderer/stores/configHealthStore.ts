import { create } from 'zustand'

/**
 * Tracks config keys whose last save FAILED (writeConfig returned false or the
 * IPC call rejected, after one retry). Non-empty failedKeys means the UI is
 * showing state that is NOT on disk — surfaced as a warning pill in BottomBar.
 */
interface ConfigHealthState {
  failedKeys: string[]
  markFailed: (key: string) => void
  markSaved: (key: string) => void
}

export const useConfigHealthStore = create<ConfigHealthState>((set) => ({
  failedKeys: [],
  markFailed: (key) =>
    set((s) => (s.failedKeys.includes(key) ? s : { failedKeys: [...s.failedKeys, key] })),
  markSaved: (key) =>
    set((s) =>
      s.failedKeys.includes(key) ? { failedKeys: s.failedKeys.filter((k) => k !== key) } : s,
    ),
}))
