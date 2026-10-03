// WP2 commit 6f: whether Hello Codex, the Codex introduction, is open outside
// onboarding, and the replay request. Its own module, with no store imports,
// so the surfaces that only need to know it is open (the global shortcuts,
// the sidebar's New config shortcut) do not load the page's gate and copy.
// The rest of the page's logic is in hello-codex.ts, which re-exports this.
import { create } from 'zustand'

/** Which way the introduction is open outside onboarding: the one-time
 *  takeover, a replay (Feature Guide or Settings, Accounts), or not at all. */
export type HelloCodexOpen = 'takeover' | 'replay' | null

interface HelloCodexState {
  open: HelloCodexOpen
  /** The takeover, once, when it is due and nothing is in its way. */
  openTakeover: () => void
  /** A replay. Ignored while the introduction is already open. */
  replay: () => void
  close: () => void
}

export const useHelloCodexStore = create<HelloCodexState>((set) => ({
  open: null,
  openTakeover: () => set((s) => (s.open ? s : { open: 'takeover' })),
  replay: () => set((s) => (s.open ? s : { open: 'replay' })),
  close: () => set({ open: null }),
}))

/** "Show the Codex introduction": the Feature Guide and Settings, Accounts,
 *  which offer it only once Codex is set up (codexSetUp in hello-codex.ts). */
export function showHelloCodexReplay(): void {
  useHelloCodexStore.getState().replay()
}
