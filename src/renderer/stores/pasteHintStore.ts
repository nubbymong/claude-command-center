import { create } from 'zustand'

// Transient, per-session paste feedback (Unit 5 W2). Alt+V is a global shortcut
// with no button to flash, so a miss writes a short hint here; the CommandBar's
// <PasteHint> renders it just above the toolbar and it auto-dismisses.

const HINT_MS = 3000

interface PasteHintState {
  hints: Record<string, string>
  show: (sessionId: string, text: string) => void
  clear: (sessionId: string) => void
}

export const usePasteHintStore = create<PasteHintState>((set, get) => ({
  hints: {},
  show: (sessionId, text) => {
    set((s) => ({ hints: { ...s.hints, [sessionId]: text } }))
    setTimeout(() => {
      // Only clear if THIS message is still showing — a newer hint resets the window.
      if (get().hints[sessionId] === text) get().clear(sessionId)
    }, HINT_MS)
  },
  clear: (sessionId) => set((s) => {
    if (!(sessionId in s.hints)) return s
    const hints = { ...s.hints }
    delete hints[sessionId]
    return { hints }
  }),
}))
