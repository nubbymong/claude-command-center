// Canvas -> agent marker delivery, queued across the agent's turn (#580).
//
// THE BUG. When the user files a verdict on the Agent Canvas the panel writes
// one line into the session's PTY -- "Approved v7 on the canvas ·
// canvas_version_verdict recorded", or "Review #3 — 5 notes · canvas_review R3"
// -- and that line is the ONLY thing that tells the agent anything happened.
// The skill (canvas-plugin.ts) triggers on the literal text.
//
// The write was unconditional and immediate: `pty.write(sessionId, line + '\r')`
// straight through `writePty`, which has no idle gate of its own. That is fine
// at a prompt and useless mid-turn -- Claude Code's TUI is not reading a user
// line while it is streaming a response, so a marker fired during an agent turn
// is swallowed by the terminal and never becomes a message. Two live
// occurrences on #580: a clean APPROVAL delivered nothing at all, because a
// clean approval creates NO review record either (submitReview refuses a round
// with no notes, by design) -- the marker IS the whole delivery. The same
// approval fired at an idle prompt arrived fine.
//
// THE FIX. Hold the line while the turn is open and flush it at the boundary.
// The boundary is not guessed from terminal text: CCC already runs a hooks
// gateway that receives Claude Code's own `UserPromptSubmit` / `PreToolUse` /
// `PostToolUse` / `Stop` events per session, so the turn is observed, not
// inferred.
//
// FAIL-OPEN BY CONSTRUCTION. The queue only ever engages on POSITIVE evidence
// that a turn is open. With hooks disabled (or a gateway that never binds) no
// turn-opening event arrives, `turnOpen` is false, and every marker is written
// immediately -- exactly today's behaviour, no new failure mode. A turn that
// opens and never closes (crash, kill, a Stop that never fires) is caught by a
// bounded fallback flush, so a marker is at worst late and never lost.

import { logInfo, logWarn } from '../debug-logger'

/** How long a queued marker may wait for a `Stop` that may never come. */
export const MARKER_FALLBACK_FLUSH_MS = 120_000

/** Nothing sane queues this many; the cap stops a stuck session growing. */
export const MARKER_QUEUE_MAX = 32

export interface MarkerQueueDeps {
  /** Deliver one line to the session's agent. */
  write: (sessionId: string, line: string) => void
  /** Arm the fallback flush. Returns its canceller. Injected for tests. */
  setTimer?: (fn: () => void, ms: number) => () => void
}

interface SessionState {
  turnOpen: boolean
  pending: string[]
  cancelFallback: (() => void) | null
}

/**
 * Which hook events say a turn is OPEN.
 *
 * Deliberately narrow. `Notification` is excluded because Claude Code fires it
 * for "waiting for your input", i.e. precisely when the turn is NOT open, and a
 * false "open" would park every marker until the next real turn ended.
 * `SubagentStop` does not close the main turn, and `SessionStart` /
 * `StopFailure` say nothing about one.
 */
const TURN_OPENING_EVENTS: ReadonlySet<string> = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
])

export class CanvasMarkerQueue {
  private readonly sessions = new Map<string, SessionState>()
  private readonly write: (sessionId: string, line: string) => void
  private readonly setTimer: (fn: () => void, ms: number) => () => void

  constructor(deps: MarkerQueueDeps) {
    this.write = deps.write
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms)
      // Never hold the process open for a marker.
      if (typeof (t as unknown as { unref?: () => void }).unref === 'function') {
        (t as unknown as { unref: () => void }).unref()
      }
      return () => clearTimeout(t)
    })
  }

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId)
    if (!s) {
      s = { turnOpen: false, pending: [], cancelFallback: null }
      this.sessions.set(sessionId, s)
    }
    return s
  }

  /**
   * Deliver a canvas marker line to the agent -- now if it can be read now,
   * otherwise at the end of the turn that is in flight.
   *
   * Returns 'sent' or 'queued' so the caller (and the tests) can tell which
   * happened without reaching into the state.
   */
  deliver(sessionId: string, line: string): 'sent' | 'queued' {
    const s = this.state(sessionId)
    if (!s.turnOpen) {
      this.write(sessionId, line)
      return 'sent'
    }
    if (s.pending.length >= MARKER_QUEUE_MAX) {
      // Drop the OLDEST: the newest verdict is the one that still describes
      // the canvas, and an unbounded queue on a wedged session is worse than a
      // dropped stale line. Loud, because it should never happen.
      const dropped = s.pending.shift()
      logWarn(`[canvas-marker] queue full for ${sessionId} — dropped the oldest marker: ${dropped}`)
    }
    s.pending.push(line)
    logInfo(`[canvas-marker] agent turn is open for ${sessionId} — queued marker (${s.pending.length} pending)`)
    this.armFallback(sessionId, s)
    return 'queued'
  }

  /** A hook event arrived for this session. */
  noteHookEvent(sessionId: string, event: string): void {
    if (event === 'Stop') {
      const s = this.sessions.get(sessionId)
      if (!s) return
      s.turnOpen = false
      this.flush(sessionId)
      return
    }
    // A restart (or a resume) is a fresh prompt: whatever turn we thought was
    // open belonged to the process that is gone, and anything still held has
    // been waiting for a Stop that will never come.
    if (event === 'SessionStart') {
      const s = this.sessions.get(sessionId)
      if (!s) return
      s.turnOpen = false
      this.flush(sessionId)
      return
    }
    if (!TURN_OPENING_EVENTS.has(event)) return
    const s = this.state(sessionId)
    if (!s.turnOpen) s.turnOpen = true
  }

  /**
   * Write everything held for this session, oldest first.
   *
   * ORDER IS THE POINT: two rounds filed in one turn must reach the agent in
   * the order the user filed them, or "Review #4" arrives describing notes the
   * agent has not been told about yet.
   */
  flush(sessionId: string): number {
    const s = this.sessions.get(sessionId)
    if (!s) return 0
    s.cancelFallback?.()
    s.cancelFallback = null
    if (s.pending.length === 0) return 0
    const lines = s.pending
    s.pending = []
    logInfo(`[canvas-marker] flushing ${lines.length} queued marker(s) for ${sessionId}`)
    for (const line of lines) this.write(sessionId, line)
    return lines.length
  }

  /** The session is gone: nothing left to deliver it to. */
  forget(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.cancelFallback?.()
    if (s.pending.length > 0) {
      logWarn(`[canvas-marker] session ${sessionId} ended with ${s.pending.length} undelivered marker(s)`)
    }
    this.sessions.delete(sessionId)
  }

  /** Test/diagnostic view. */
  pendingCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.pending.length ?? 0
  }

  /** Test/diagnostic view. */
  isTurnOpen(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.turnOpen ?? false
  }

  private armFallback(sessionId: string, s: SessionState): void {
    if (s.cancelFallback) return
    s.cancelFallback = this.setTimer(() => {
      const live = this.sessions.get(sessionId)
      if (!live) return
      live.cancelFallback = null
      if (live.pending.length === 0) return
      logWarn(
        `[canvas-marker] no Stop for ${sessionId} within ${MARKER_FALLBACK_FLUSH_MS}ms — ` +
        `flushing ${live.pending.length} marker(s) anyway (late beats lost)`,
      )
      // The turn is presumed over: a hook stream that went silent this long is
      // a crashed/killed turn, and holding for a boundary that will never
      // arrive is the loss this whole module exists to prevent.
      live.turnOpen = false
      this.flush(sessionId)
    }, MARKER_FALLBACK_FLUSH_MS)
  }
}
