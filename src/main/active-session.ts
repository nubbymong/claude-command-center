// Tracks the renderer's currently-viewed (active) session id in the main
// process. The renderer already broadcasts this on every selection change via
// GITHUB_FOCUS_CHANGED (App.tsx -> notifyFocusChanged), so we piggyback on that
// signal. Used by diagnostics (e.g. the permission tray) that need to know
// whether an event belongs to the session the user is looking at.
let activeSessionId: string | null = null

export function setActiveSessionId(id: string | null): void {
  activeSessionId = id
}

export function getActiveSessionId(): string | null {
  return activeSessionId
}
