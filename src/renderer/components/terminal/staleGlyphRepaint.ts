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
 * Trigger coverage (#273 follow-up): the first cut repainted only while the user
 * was scrolled up or had just wheeled, so output streaming at the BOTTOM with no
 * scroll at all (a slicer's stderr, a build log) still ghosted and stayed
 * ghosted after the stream stopped. Every normal-buffer output chunk now
 * qualifies, at two paces: the original 4/sec while scrolled up / wheel-active
 * (where the artifact is worst), a gentler 1/sec for steady at-bottom streaming
 * (bounds a ghost to about a second while output flows), plus ONE "settle"
 * repaint once output has been quiet for a moment — the ghost the last chunk
 * left is what the user is otherwise left staring at.
 *
 * Everything here is pure and dependency-injected so the throttle boundaries and
 * the trigger predicate are unit-testable without a DOM or a GPU.
 */

/** At most one strong repaint per this interval while scrolled up / wheel-active
 *  — 4/sec under a firehose. Also the repainter's default interval. */
export const REPAINT_MIN_INTERVAL_MS = 250

/** Steady at-bottom streaming with no scroll: at most one strong repaint per
 *  second. clearTextureAtlas() rebuilds the glyph atlas (re-warms the ASCII set,
 *  re-rasters every viewport glyph), so a build log that streams for minutes
 *  should not pay 4 of those a second; a ghost lives at most ~1s while output
 *  flows and the settle repaint clears the final one when it stops. */
export const BOTTOM_STREAM_INTERVAL_MS = 1000

/** Output quiet for this long → one settle repaint. Long enough that a
 *  continuous stream keeps re-arming it (the periodic pace covers that), short
 *  enough that a ghost never sits on a finished stream for long. */
export const SETTLE_QUIET_MS = 300

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
 * Every NORMAL-buffer chunk qualifies — at the bottom too, since the ghost also
 * forms under steady at-bottom streaming with no scroll (#273 follow-up). The
 * alternate screen (a TUI, Claude's own UI) owns its full repaints and does not
 * accumulate these stale cells, so it is left alone. How OFTEN a qualifying
 * stream repaints is `outputRepaintIntervalMs`.
 */
export function shouldRepaintOnOutput(s: OutputRepaintState): boolean {
  return !s.alternateBuffer
}

/**
 * How closely to space repaints for a qualifying output stream: the original
 * 4/sec while the user is scrolled up or has wheeled recently (the conditions
 * where the artifact is worst and the user is looking at it), 1/sec for steady
 * at-bottom streaming.
 */
export function outputRepaintIntervalMs(s: OutputRepaintState): number {
  return s.scrolledUp || s.msSinceWheel < s.wheelActiveMs ? REPAINT_MIN_INTERVAL_MS : BOTTOM_STREAM_INTERVAL_MS
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
   *  at most one repaint per interval for the rest of a burst. `intervalMs`
   *  overrides the pace for this request (defaults to the repainter's). */
  schedule(intervalMs?: number): void
  /** Arm (or re-arm) ONE repaint for when requests go quiet: fires `quietMs`
   *  after the last settle() call, through the normal throttle. A continuous
   *  stream keeps pushing it out; the moment it stops, the last chunk's ghost is
   *  cleared. */
  settle(quietMs?: number): void
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
  /** When the armed trailing timer is due (deps.now() clock), so a faster-paced
   *  request can tell whether it would fire sooner and bring it forward. */
  let timerDueAt = Number.POSITIVE_INFINITY
  let settleTimer: ReturnType<typeof setTimeout> | null = null
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

  const schedule = (intervalMs: number = minInterval) => {
    if (disposed) return
    const since = deps.now() - lastPaintAt
    if (since >= intervalMs) {
      if (timer) { deps.clearTimer(timer); timer = null; timerDueAt = Number.POSITIVE_INFINITY }
      paint()
      return
    }
    // Inside the window: one trailing repaint at the edge of THIS request's
    // window (lastPaintAt + intervalMs). An armed timer that is due no later
    // stands (never push a repaint out — that would starve a steady stream); a
    // faster-paced request — a wheel landing mid at-bottom stream — brings an
    // armed slow timer FORWARD to its own edge rather than waiting up to the
    // slow interval on it (#292 review).
    const dueAt = lastPaintAt + intervalMs
    if (timer) {
      if (dueAt >= timerDueAt) return
      deps.clearTimer(timer)
      timer = null
    }
    timerDueAt = dueAt
    timer = deps.setTimer(() => {
      timer = null
      timerDueAt = Number.POSITIVE_INFINITY
      if (disposed) return
      paint()
    }, intervalMs - since)
  }

  const settle = (quietMs: number = SETTLE_QUIET_MS) => {
    if (disposed) return
    // Debounce: every call pushes the settle repaint out to quietMs from NOW.
    if (settleTimer) deps.clearTimer(settleTimer)
    settleTimer = deps.setTimer(() => {
      settleTimer = null
      if (disposed) return
      // Through the throttle (default pace) so a settle can never double up on a
      // repaint that just happened; the ghost the final chunk left is cleared
      // within one interval of the stream going quiet.
      schedule(minInterval)
    }, quietMs)
  }

  const dispose = () => {
    disposed = true
    if (timer) { deps.clearTimer(timer); timer = null; timerDueAt = Number.POSITIVE_INFINITY }
    if (settleTimer) { deps.clearTimer(settleTimer); settleTimer = null }
  }

  return { schedule, settle, dispose }
}
