/**
 * Stale-glyph repaint scheduler (#273).
 *
 * The xterm WebGL renderer can leave STALE glyph cells painted over the live
 * viewport: a frozen fragment of recent output overlapping the current rows. The
 * cell BUFFER is correct — only the painted surface is stale — which is why a
 * window resize (a full GPU repaint) clears it instantly. It shows up during
 * continuous output combined with mouse-wheel scrolling, and is aggravated by a
 * nested console program that writes DIRECT to the console (CONOUT$): those
 * writes bypass any redirected stdout/stderr, reach the ConPTY transiently,
 * flash on screen, and the WebGL damage tracking freezes them as stale cells.
 *
 * The fix is to reproduce the resize's full repaint programmatically —
 * `WebglAddon.clearTextureAtlas()` (rebuild the glyph atlas + re-raster the
 * viewport) followed by `term.refresh()` — on the triggers that correlate with
 * the bug, THROTTLED so a firehose of output costs at most a few repaints a
 * second rather than one per chunk.
 *
 * Everything here is pure and dependency-injected so the throttle boundaries and
 * the trigger predicate are unit-testable without a DOM or a GPU.
 */

/** At most one strong repaint per this interval — 4/sec under a firehose. */
export const REPAINT_MIN_INTERVAL_MS = 250

/** After a wheel event, treat the user as "actively scrolling" for this long, so
 *  streaming output keeps busting ghosts until the scroll settles. */
export const WHEEL_ACTIVE_MS = 3000

export interface OutputRepaintState {
  /** term.buffer.active.type === 'alternate'. TUI apps (Claude's own UI) run in
   *  the alternate screen: no scrollback, they own their full repaints, and they
   *  do not accumulate the scroll-driven stale cells this targets. Skip them so
   *  the common case pays nothing. */
  alternateBuffer: boolean
  /** Viewport parked above the bottom (the user scrolled up). */
  scrolledUp: boolean
  /** Milliseconds since the last wheel event (Infinity if none yet). */
  msSinceWheel: number
  /** How long after a wheel a repaint stays warranted (WHEEL_ACTIVE_MS). */
  wheelActiveMs: number
}

/**
 * Should arriving output trigger a stale-glyph repaint?
 *
 * Only in the NORMAL buffer, and only when the user is either scrolled up or has
 * scrolled recently — the exact conditions under which #273 reproduces. Steady
 * at-bottom output with no recent scroll (an idle shell tailing a log, a TUI in
 * the alternate buffer) is left alone.
 */
export function shouldRepaintOnOutput(s: OutputRepaintState): boolean {
  if (s.alternateBuffer) return false
  return s.scrolledUp || s.msSinceWheel < s.wheelActiveMs
}

export interface RepainterDeps {
  /** Rebuild the WebGL glyph atlas. Returns true when WebGL was active and the
   *  atlas was actually cleared; false on the DOM-renderer fallback (or an
   *  unrecovered context loss) — nothing to clear, so nothing to repaint. */
  clearAtlas: () => boolean
  /** Mark the viewport dirty so it re-renders (term.refresh(0, rows-1)). */
  refresh: () => void
  now: () => number
  setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  /** Override the throttle interval (tests). Defaults to REPAINT_MIN_INTERVAL_MS. */
  minIntervalMs?: number
}

export interface StaleGlyphRepainter {
  /** Request a strong repaint soon. Leading-edge immediate, then coalesced into
   *  at most one repaint per interval for the rest of a burst. */
  schedule(): void
  /** Cancel any pending repaint and refuse further ones. */
  dispose(): void
}

/**
 * A leading-edge throttle around a "strong repaint".
 *
 *   - The first call after an idle gap repaints IMMEDIATELY (leading edge), so a
 *     ghost is cleared without waiting out the interval.
 *   - Calls inside the throttle window coalesce into a SINGLE trailing repaint at
 *     the window edge — a continuous firehose calling schedule() every frame
 *     still repaints only every `minIntervalMs`.
 */
export function createStaleGlyphRepainter(deps: RepainterDeps): StaleGlyphRepainter {
  const minInterval = deps.minIntervalMs ?? REPAINT_MIN_INTERVAL_MS
  let lastPaintAt = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const paint = () => {
    lastPaintAt = deps.now()
    // clearAtlas() rebuilds the WebGL glyph atlas; refresh() then re-rasters
    // against it (the programmatic equivalent of the window-move full repaint).
    // When WebGL isn't active clearAtlas() returns false — there is no atlas
    // ghost — so skip the full-viewport refresh rather than tax a DOM-renderer
    // session that never had the bug (#273 adversarial review). lastPaintAt is
    // still advanced above so the throttle keeps pacing the (now cheap) checks.
    if (deps.clearAtlas()) deps.refresh()
  }

  const schedule = () => {
    if (disposed) return
    const since = deps.now() - lastPaintAt
    if (since >= minInterval) {
      if (timer) { deps.clearTimer(timer); timer = null }
      paint()
      return
    }
    // Inside the window: one trailing repaint at the edge. Already-armed → let it
    // stand rather than pushing it later (that would starve a steady stream).
    if (timer) return
    timer = deps.setTimer(() => {
      timer = null
      if (disposed) return
      paint()
    }, minInterval - since)
  }

  const dispose = () => {
    disposed = true
    if (timer) { deps.clearTimer(timer); timer = null }
  }

  return { schedule, dispose }
}
