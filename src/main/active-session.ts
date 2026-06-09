// Tracks the renderer's currently-viewed (active) session id in the main
// process, recorded from the renderer's GITHUB_FOCUS_CHANGED broadcast
// (App.tsx -> notifyFocusChanged). A lightweight primitive for focus-aware
// main-side features.
let activeSessionId: string | null = null

export function setActiveSessionId(id: string | null): void {
  activeSessionId = id
}

export function getActiveSessionId(): string | null {
  return activeSessionId
}
