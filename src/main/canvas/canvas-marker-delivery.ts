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
//
// WP2 PR 4, P4.1: a Codex session's markers go through the submit primitive
// (src/main/providers/codex/composer-submit.ts), whose answer comes later and
// may be "not delivered" (no ready prompt within the queue's own bound, a
// prompt on screen, a write never drawn). The wiring's `write` may therefore
// answer with a promise of that result, and a marker that was not delivered
// is handed to `onUndelivered` with the canvas it was filed on, so the canvas
// can show it on the review it belongs to. Claude's markers keep their
// synchronous write and answer nothing.

import { CanvasMarkerQueue } from './canvas-marker-queue'
import { logInfo, logWarn } from '../debug-logger'
import type { CanvasMarkerUndelivered, SubmitTextResult } from '../../shared/types'

export interface CanvasMarkerWiring {
  /** Deliver one line to the session's agent (main appends the submit key).
   *  A Codex session's write answers later, with whether it was delivered. */
  write: (sessionId: string, line: string) => void | Promise<SubmitTextResult>
  /**
   * Subscribe to Claude Code's own hook stream — the turn boundary. Optional:
   * with hooks disabled there is no boundary to observe, no turn ever reads as
   * open, and every marker is written immediately. That is the pre-#580
   * behaviour, so the failure mode of this feature is "no feature", never "no
   * marker".
   */
  subscribe?: (cb: (sessionId: string, event: string) => void) => void
  /** P4.1: a marker the submit primitive did not deliver, with the canvas it
   *  was filed on. Never called for a delivered one, nor for Claude's. */
  onUndelivered?: (u: CanvasMarkerUndelivered) => void
}

let queue: CanvasMarkerQueue | null = null

/** The marker writes still awaiting an answer, per session. The canvas a
 *  marker was filed on travels with its own write (ADR-009 round 1: never
 *  looked up by the line, which two canvases of one session can share); this
 *  only says the session has not ended since, so a late answer for a session
 *  that ended tells no canvas. Each entry goes with its answer. */
const awaiting = new Map<string, Set<object>>()

/** The queue's write: the wiring's, with a later answer followed up. */
function writeThrough(wiring: CanvasMarkerWiring, sessionId: string, line: string, canvasId: string | undefined): void {
  const answer = wiring.write(sessionId, line)
  if (!answer || typeof (answer as Promise<SubmitTextResult>).then !== 'function') return
  const token = {}
  let tokens = awaiting.get(sessionId)
  if (!tokens) {
    tokens = new Set()
    awaiting.set(sessionId, tokens)
  }
  tokens.add(token)
  const settle = (): boolean => {
    const current = awaiting.get(sessionId)
    const held = !!current?.delete(token)
    if (current && current.size === 0) awaiting.delete(sessionId)
    return held
  }
  void (answer as Promise<SubmitTextResult>).then(
    (result) => {
      const stillHeld = settle()
      if (!result || result.delivered !== false) return
      if (!canvasId || !stillHeld) {
        logWarn(`[canvas-marker] a marker for ${sessionId} was not delivered (${result.reason}); ${canvasId ? 'the session ended or its markers were cleared since' : 'no canvas was named for it'}, so no canvas is told`)
        return
      }
      logInfo(`[canvas-marker] a marker for ${sessionId} was not delivered (${result.reason})`)
      try { wiring.onUndelivered?.({ sessionId, canvasId, line, reason: result.reason }) } catch { /* the window is gone */ }
    },
    () => { settle() },
  )
}

/** Wire the queue to the PTY and the hook stream. Called once, at boot. */
export function startCanvasMarkerQueue(wiring: CanvasMarkerWiring): void {
  if (queue) return
  queue = new CanvasMarkerQueue({ write: (sessionId, line, canvasId) => writeThrough(wiring, sessionId, line, canvasId) })
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
 * `canvasId` (P4.1): the canvas the marker was filed on, for the notice when
 * a Codex session's marker is not delivered.
 *
 * Before boot wiring (and in tests that never wire it) there is nothing to
 * deliver to; say so rather than pretending it went out.
 */
export function deliverCanvasMarker(sessionId: string, line: string, canvasId?: string): 'sent' | 'queued' | 'unwired' {
  if (!queue) return 'unwired'
  return queue.deliver(sessionId, line, typeof canvasId === 'string' && canvasId ? canvasId : undefined)
}

/** A session's PTY is gone; drop anything still held for it. */
export function forgetCanvasMarkers(sessionId: string): void {
  queue?.forget(sessionId)
  awaiting.delete(sessionId)
}

/** Test seam. */
export function _resetCanvasMarkerQueueForTest(): void {
  queue = null
  awaiting.clear()
}
