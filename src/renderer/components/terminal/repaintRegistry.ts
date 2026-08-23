/**
 * A tiny per-session registry of terminal repainters (#379, fix E).
 *
 * When a GUI-subsystem tool is run IN the pty — because the user chose to, or
 * because we could not tell what the program was — its log is written straight
 * into the console screen buffer, over whatever TUI is drawing there. Nothing on
 * our side can stop that: the write does not pass through the pty stream, so
 * xterm never sees the bytes and never marks those cells dirty. The damage is
 * therefore INVISIBLE to us — the screen and xterm's model disagree, and xterm
 * believes it is right.
 *
 * The only repair is to repaint everything, which is what
 * `createStaleGlyphRepainter().settleStrong()` already does for the WebGL atlas
 * case: wait for output to go quiet, then clear the atlas and refresh every row.
 * It cannot restore what the TUI would have drawn (only the TUI can, on its next
 * frame) but it clears our own stale cells and takes the terminal back to a
 * consistent state instead of a smeared one.
 *
 * This module exists because the requester (CommandBar) and the owner
 * (TerminalView) have no component relationship — the bar belongs to a session,
 * the terminal is somewhere else in the tree. A module-level map keyed by
 * session id is the smallest thing that connects them without threading a prop
 * through everything in between.
 */

export interface SessionRepainter {
  /** Wait for output to go quiet, then clear the atlas and repaint every row. */
  settleStrong: (quietMs?: number, intervalMs?: number) => void
}

const repainters = new Map<string, SessionRepainter>()

/**
 * Register a terminal's repainter. Returns the unregister function, which is
 * safe to call twice and only removes THIS registration — a remount that
 * registered a newer repainter for the same session is not clobbered by the old
 * one's cleanup.
 */
export function registerRepainter(sessionId: string, repainter: SessionRepainter): () => void {
  repainters.set(sessionId, repainter)
  return () => {
    if (repainters.get(sessionId) === repainter) repainters.delete(sessionId)
  }
}

/**
 * Ask a session's terminal to repaint once its output settles. A no-op when
 * that session has no live terminal — the caller does not need to know, and
 * there is nothing to repair when there is nothing on screen.
 */
export function requestSettleRepaint(sessionId: string): boolean {
  const repainter = repainters.get(sessionId)
  if (!repainter) return false
  try {
    repainter.settleStrong()
    return true
  } catch {
    // A terminal disposed between the lookup and the call. Nothing to repair.
    return false
  }
}

/**
 * When to re-arm the repaint after typing a line we expect to bleed.
 *
 * `settleStrong` fires one repaint a short quiet-window after it is called, and
 * TerminalView re-arms it on every pty chunk. A bleeding child sends NO pty
 * chunks — that is the whole problem — so a single arm at t=0 fires long before
 * the tool has finished writing over the pane. There is no exit signal to wait
 * for either: the pty's shell is still alive, and only the shell knows its child
 * ended.
 *
 * So this sweeps instead: repaint now (catches a tool that printed immediately),
 * again after a couple of seconds, and once more late enough to cover a slow
 * start. Each is throttled and coalesced by the repainter, so the whole sweep
 * costs at most three refreshes and usually fewer. It is a mitigation, not a
 * cure — see the fix-E note in CONTEXT.d — but it is the honest limit of what
 * the renderer can know.
 */
export const BLEED_REPAINT_DELAYS_MS = [0, 2000, 8000] as const

export interface BleedRepaintDeps {
  setTimer?: (cb: () => void, ms: number) => unknown
  delays?: readonly number[]
}

/**
 * Arm the sweep above for a session. Returns the number of repaints scheduled
 * (the immediate one included) so a caller — and a test — can tell whether a
 * terminal was there at all.
 */
export function scheduleBleedRepaints(sessionId: string, deps: BleedRepaintDeps = {}): number {
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  const delays = deps.delays ?? BLEED_REPAINT_DELAYS_MS
  if (!repainters.has(sessionId)) return 0
  let armed = 0
  for (const ms of delays) {
    if (ms <= 0) requestSettleRepaint(sessionId)
    else setTimer(() => { requestSettleRepaint(sessionId) }, ms)
    armed += 1
  }
  return armed
}

/** Test seam. */
export function __clearRepaintRegistry(): void {
  repainters.clear()
}
