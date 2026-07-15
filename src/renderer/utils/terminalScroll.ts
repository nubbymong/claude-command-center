// Sticky-bottom scroll-follow decision for the xterm terminal viewport.
//
// Issue #73: while a session was producing output, dragging the scrollbar thumb
// (or scrolling with the keyboard) jumped the viewport straight back to the
// bottom. The old TerminalView logic gated auto-scroll on a "user scrolled up"
// latch that was set ONLY by the mouse-wheel handler. Scrollbar-thumb drags and
// PageUp/Up/Home emit `scroll`/`keydown` events, never `wheel`, so the latch
// stayed false and the next PTY output chunk's `scrollToBottom()` yanked the
// viewport down again.
//
// The fix is to stop trusting an input-set latch and instead read where the
// user ACTUALLY is, sampled from the live buffer position BEFORE each output
// chunk lays out — the same `viewportY >= baseY` check the wheel handler
// already relies on. That honors a scroll-up performed by ANY means. Sampling
// before the write is reliable because xterm `onData` chunks run atomically:
// `viewportY` reflects the user's most recent scroll by the time the next chunk
// arrives.

/** Live xterm viewport geometry, read from `terminal.buffer.active`. */
export interface ScrollViewport {
  /** Top visible buffer line (xterm `buffer.active.viewportY` / ydisp). */
  viewportY: number
  /** Top line when scrolled fully to the bottom (`buffer.active.baseY` / ybase). */
  baseY: number
}

export interface ScrollFollowDecision {
  /** Snap the viewport to the bottom after this chunk lays out. */
  scrollToBottom: boolean
  /**
   * The "user scrolled up" latch to apply — drives the scroll-to-bottom
   * button's visibility. True iff the viewport is currently above the bottom.
   */
  scrolledUp: boolean
}

/**
 * Decide whether to keep following the tail for an output chunk, from the
 * viewport position sampled BEFORE the chunk is written. Follow (and hide the
 * scroll-to-bottom button) exactly when the user is at the bottom; otherwise
 * preserve their position and surface the button.
 */
export function decideFollow(v: ScrollViewport): ScrollFollowDecision {
  const atBottom = v.viewportY >= v.baseY
  return { scrollToBottom: atBottom, scrolledUp: !atBottom }
}
