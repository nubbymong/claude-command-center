// The live wiring for the canvas marker queue (#580).
//
// Kept apart from `canvas-marker-queue.ts` on purpose: the queue is the RULE
// (pure, no Electron, no PTY, unit-testable flat) and this is the singleton
// around it.
//
// Nothing heavy is imported HERE either, and that is deliberate rather than
// tidy: the IPC handler that calls `deliverCanvasMarker` lives in
// canvas-handlers.ts, and a static import of pty-manager (or the hooks gateway)
// from there drags `electron.app` into every canvas handler test that mocks
// Electron minimally. So both ends are INJECTED at boot from src/main/index.ts,
// where those modules already live.

import { CanvasMarkerQueue } from './canvas-marker-queue'
import { logInfo } from '../debug-logger'

export interface CanvasMarkerWiring {
  /** Deliver one line to the session's agent (main appends the submit key). */
  write: (sessionId: string, line: string) => void
  /**
   * Subscribe to Claude Code's own hook stream — the turn boundary. Optional:
   * with hooks disabled there is no boundary to observe, no turn ever reads as
   * open, and every marker is written immediately. That is the pre-#580
   * behaviour, so the failure mode of this feature is "no feature", never "no
   * marker".
   */
  subscribe?: (cb: (sessionId: string, event: string) => void) => void
}

let queue: CanvasMarkerQueue | null = null

/** Wire the queue to the PTY and the hook stream. Called once, at boot. */
export function startCanvasMarkerQueue(wiring: CanvasMarkerWiring): void {
  if (queue) return
  queue = new CanvasMarkerQueue({ write: wiring.write })
  if (wiring.subscribe) {
    wiring.subscribe((sessionId, event) => queue?.noteHookEvent(sessionId, event))
    logInfo('[canvas-marker] watching the hook stream for agent turn boundaries')
  } else {
    logInfo('[canvas-marker] no hook stream — markers deliver immediately (pre-#580 behaviour)')
  }
}

/**
 * Deliver one canvas marker line to a session's agent, now or at the end of the
 * turn in flight. The renderer reaches this through `canvas:agentMarker`.
 *
 * Before boot wiring (and in tests that never wire it) there is nothing to
 * deliver to; say so rather than pretending it went out.
 */
export function deliverCanvasMarker(sessionId: string, line: string): 'sent' | 'queued' | 'unwired' {
  if (!queue) return 'unwired'
  return queue.deliver(sessionId, line)
}

/** A session's PTY is gone; drop anything still held for it. */
export function forgetCanvasMarkers(sessionId: string): void {
  queue?.forget(sessionId)
}

/** Test seam. */
export function _resetCanvasMarkerQueueForTest(): void {
  queue = null
}
