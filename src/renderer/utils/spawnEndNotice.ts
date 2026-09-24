// src/renderer/utils/spawnEndNotice.ts
//
// WP2 commit 6: tell the terminal view that is showing a session that the
// start it did not make itself has ended.
//
// A view can be remounted without a Restart (a partner-terminal restart
// re-keys the main view) while its pty:spawn is still in flight. The new view
// mounts onto that spawn with nothing to hold or settle, and the old view is
// torn down. When the old view's spawn then settles with nothing started (a
// refusal, a cancelled preparation), it is the only one that knows -- and it
// has no terminal left to say so in. It reports here instead, while its
// spawn is still the session's current one (ptyTracker.isCurrentSpawn), and
// the view listening for the session says it and marks the session ended.
//
// The new view may not be listening yet: a view whose pane is hidden (the
// partner pane showing) starts only when it is first shown. So a report
// nobody hears is KEPT, one per session (a newer one replaces it), and handed
// to the view when it starts listening; a session that goes (closed, or a
// Restart that starts it afresh) drops it (forgetSpawnEnd, from ptyTracker).

type Listener = (line: string | null) => void

const listeners = new Map<string, Listener>()
/** Reports nobody has heard yet, by session. */
const kept = new Map<string, string | null>()

/** The view showing `sessionId` listens; a report kept for the session is
 *  handed over at once. Returns the unsubscribe. */
export function listenForSpawnEnd(sessionId: string, listener: Listener): () => void {
  listeners.set(sessionId, listener)
  if (kept.has(sessionId)) {
    const line = kept.get(sessionId) ?? null
    kept.delete(sessionId)
    listener(line)
  }
  return () => { if (listeners.get(sessionId) === listener) listeners.delete(sessionId) }
}

/** Report that the session's start ended with no PTY, with the line the
 *  terminal should show (null: none). True when a view heard it now; false
 *  when it was kept for the view that listens next. */
export function reportSpawnEnd(sessionId: string, line: string | null): boolean {
  const listener = listeners.get(sessionId)
  if (listener) { listener(line); return true }
  kept.set(sessionId, line)
  return false
}

/** The session is gone, or is being started afresh: drop a kept report. */
export function forgetSpawnEnd(sessionId: string): void {
  kept.delete(sessionId)
}
