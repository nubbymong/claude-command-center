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

/**
 * Output quiet for this long → one STRONG (atlas-rebuilding) settle repaint, at
 * most once per STRONG_SETTLE_INTERVAL_MS.
 *
 * This is the answer to "can it just not happen". The glyph atlas goes stale on
 * its own (#273) — new glyph variety in the stream is enough, which is why a
 * fresh piece of Claude Code UI can trigger it — and only an atlas rebuild
 * fixes it, which is what a window resize does by hand. beta.13 rebuilt it
 * DURING the stream and flashed constantly; beta.14 stopped, and the staleness
 * became visible until the user scrolled.
 *
 * Rebuilding when output has gone QUIET gets both: nothing is moving on screen,
 * so the rebuild is not competing with a stream of new frames, and the stale
 * text the user is about to sit and read is corrected without them touching
 * anything. A chatty stream with sub-second gaps keeps pushing it out, and the
 * interval floor stops a stream that pauses constantly from turning back into
 * beta.13.
 */
export const STRONG_SETTLE_QUIET_MS = 800

/** Floor between STRONG settle repaints, so a stream that pauses every second
 *  cannot drag the atlas rebuild back up to the beta.13 rate. */
export const STRONG_SETTLE_INTERVAL_MS = 3000

/**
 * Hard ceiling on atlas staleness: rebuild after this long even if output never
 * goes quiet.
 *
 * `settleStrong` puts the rebuild in the GAP, which is the right place — but it
 * is DEBOUNCED, so a stream whose chunks are consistently closer together than
 * STRONG_SETTLE_QUIET_MS pushes it out indefinitely and the rebuild never
 * happens at all. A build log, a long Claude Code response, a test runner —
 * anything that streams steadily for minutes is exactly that stream, and the
 * user watches the viewport degrade with no way out but the mouse wheel. That
 * is the reported symptom, and it is why the gap has to be the PREFERRED moment
 * rather than the only one.
 *
 * At 5s this is ~20x gentler than the per-chunk rebuild that made beta.13
 * flash, and it only ever fires on a stream that has denied the scheduler a gap
 * for that long.
 */
export const STRONG_MAX_STALE_MS = 5000

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
 * Should arriving output trigger the STRONG repaint (atlas rebuild + refresh)?
 *
 * beta.14 regression fix: #292 widened this to every normal-buffer chunk, so an
 * atlas rebuild ran 1-4 times a second for as long as output flowed. Claude Code
 * renders in the NORMAL buffer, not the alternate screen, so the exemption below
 * never applied to this app's main use case: sessions flashed continuously and
 * drew frames against a half-rebuilt atlas. The strong repaint is back to the
 * conditions that actually corrupt the atlas (scrolled up, or wheeling); steady
 * at-bottom streaming takes the cheap path instead (shouldSoftRepaintOnOutput).
 *
 * Superseded text kept for context: every NORMAL-buffer chunk qualified — at the bottom too, since the ghost also
 * forms under steady at-bottom streaming with no scroll (#273 follow-up). The
 * alternate screen (a TUI, Claude's own UI) owns its full repaints and does not
 * accumulate these stale cells, so it is left alone. How OFTEN a qualifying
 * stream repaints is `outputRepaintIntervalMs`.
 */
export function shouldRepaintOnOutput(s: OutputRepaintState): boolean {
  if (s.alternateBuffer) return false
  return s.scrolledUp || s.msSinceWheel < s.wheelActiveMs
}

/**
 * Should arriving output trigger the CHEAP repaint (refresh only, no atlas
 * rebuild)?
 *
 * This is the at-bottom coverage #292 added, minus the part that made beta.13
 * unusable. A merely-stale viewport is fixed by marking it dirty and
 * re-rendering from the atlas already in memory; rebuilding the atlas was never
 * what fixed that, and doing so on a schedule is what caused the flashing.
 */
export function shouldSoftRepaintOnOutput(s: OutputRepaintState): boolean {
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
  /** True when the WebGL renderer is live, WITHOUT rebuilding anything. Gates
   *  the cheap repaint so a DOM-renderer session (which never had the artifact)
   *  pays nothing — the same reasoning that gates the strong path on
   *  clearAtlas()'s return value. */
  atlasActive: () => boolean
  /** Mark the viewport dirty so it re-renders (term.refresh(0, rows-1)). */
  refresh: () => void
  now: () => number
  setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  /** Override the throttle interval (tests). Defaults to REPAINT_MIN_INTERVAL_MS. */
  minIntervalMs?: number
}

export interface StaleGlyphRepainter {
  /** Request a repaint soon. Leading-edge immediate, then coalesced into at most
   *  one repaint per interval for the rest of a burst. `intervalMs` overrides
   *  the pace for this request (defaults to the repainter's). `strong` (default
   *  true) rebuilds the glyph atlas; pass false for the cheap refresh-only
   *  repaint. If ANY request coalesced into a window was strong, the single
   *  repaint that window produces is strong. */
  schedule(intervalMs?: number, strong?: boolean): void
  /** Arm (or re-arm) ONE repaint for when requests go quiet: fires `quietMs`
   *  after the last settle() call, through the normal throttle at `intervalMs`
   *  (default the repainter's). A continuous stream keeps pushing it out; the
   *  moment it stops, the last chunk's ghost is cleared. Pass the stream's own
   *  pace so a settle firing mid-stream cannot repaint faster than the stream. */
  settle(quietMs?: number, intervalMs?: number, strong?: boolean): void
  /** Arm (or re-arm) ONE STRONG (atlas-rebuilding) repaint for when output goes
   *  quiet. Its own debounce timer, independent of `settle`, so the cheap
   *  during-stream settle and this cannot clobber each other. See
   *  STRONG_SETTLE_QUIET_MS for why the rebuild belongs in the gap rather than
   *  in the stream. */
  settleStrong(quietMs?: number, intervalMs?: number): void
  /** Rebuild the atlas NOW if it has not been rebuilt for `maxStaleMs`, whether
   *  or not output ever went quiet. The backstop for a stream that never leaves
   *  a gap for `settleStrong` to land in; see STRONG_MAX_STALE_MS. */
  strongIfStale(maxStaleMs?: number): void
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
  /** Whether the repaint this throttle window will produce must rebuild the atlas. */
  let pendingStrong = false
  /** When the atlas was last actually REBUILT. Tracked separately from
   *  lastPaintAt because the two are throttled for different reasons: cheap
   *  refreshes are paced so they do not spam the renderer, the rebuild is paced
   *  because it is the thing that can flash. Sharing one clock let a steady
   *  stream of cheap refreshes defer the rebuild indefinitely (it never ran),
   *  and let a stream that paused constantly run one on every pause. */
  let lastStrongPaintAt = Number.NEGATIVE_INFINITY
  /** When the atlas was last known-good: a rebuild, or the moment this repainter
   *  was created (a fresh terminal starts with a fresh atlas). Separate from
   *  lastStrongPaintAt, which stays at -Infinity so the FIRST settleStrong is
   *  never held off by its own floor. */
  let atlasFreshAt = deps.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  /** When the armed trailing timer is due (deps.now() clock), so a faster-paced
   *  request can tell whether it would fire sooner and bring it forward. */
  let timerDueAt = Number.POSITIVE_INFINITY
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let strongSettleTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const paint = (strong: boolean) => {
    lastPaintAt = deps.now()
    if (strong) {
      lastStrongPaintAt = lastPaintAt
      atlasFreshAt = lastPaintAt
    }
    if (!strong) {
      // Cheap path (#292 at-bottom coverage): re-render the viewport from the
      // atlas ALREADY in memory. Fixes a stale painted cell without the rebuild
      // that made beta.13 flash. Gated on WebGL being live for the same reason
      // the strong path is.
      if (deps.atlasActive()) deps.refresh()
      return
    }
    // clearAtlas() rebuilds the WebGL glyph atlas; refresh() then re-rasters
    // against it (the programmatic equivalent of the window-move full repaint).
    // When WebGL isn't active clearAtlas() returns false — there is no atlas
    // ghost — so skip the full-viewport refresh rather than tax a DOM-renderer
    // session that never had the bug (#273 adversarial review). lastPaintAt is
    // still advanced above so the throttle keeps pacing the (now cheap) checks.
    if (deps.clearAtlas()) deps.refresh()
  }

  const schedule = (intervalMs: number = minInterval, strong: boolean = true) => {
    if (disposed) return
    const since = deps.now() - lastPaintAt
    if (since >= intervalMs) {
      if (timer) { deps.clearTimer(timer); timer = null; timerDueAt = Number.POSITIVE_INFINITY }
      const wasStrong = strong || pendingStrong
      pendingStrong = false
      paint(wasStrong)
      return
    }
    // A strong request anywhere in the window wins: a wheel landing mid at-bottom
    // stream must still get its atlas rebuild, not be swallowed by the cheap
    // repaint that happened to be scheduled first.
    pendingStrong = pendingStrong || strong
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
      const wasStrong = pendingStrong
      pendingStrong = false
      paint(wasStrong)
    }, intervalMs - since)
  }

  const settle = (quietMs: number = SETTLE_QUIET_MS, intervalMs: number = minInterval, strong: boolean = true) => {
    if (disposed) return
    // Debounce: every call pushes the settle repaint out to quietMs from NOW.
    if (settleTimer) deps.clearTimer(settleTimer)
    settleTimer = deps.setTimer(() => {
      settleTimer = null
      if (disposed) return
      // Through the throttle AT THE STREAM'S PACE (not always the fast default):
      // a log line every ~350ms leaves a >SETTLE_QUIET_MS gap between chunks, so
      // the settle fires between them EVERY time. Routed through schedule(1000)
      // that just re-arms the 1/sec trailing timer (it coalesces) so a steady
      // at-bottom stream stays at its 1/sec pace instead of the settle dragging
      // it up to the chunk rate; when the stream truly stops, the final ghost is
      // still cleared within one interval. See BOTTOM_STREAM_INTERVAL_MS.
      schedule(intervalMs, strong)
    }, quietMs)
  }

  const settleStrong = (quietMs: number = STRONG_SETTLE_QUIET_MS, intervalMs: number = STRONG_SETTLE_INTERVAL_MS) => {
    if (disposed) return
    // Debounced on its OWN timer: every chunk pushes the rebuild out, so it only
    // lands in a real gap in the output. Routed through the shared throttle at
    // the strong interval, which is what stops a stream that pauses every second
    // from rebuilding the atlas every second.
    if (strongSettleTimer) deps.clearTimer(strongSettleTimer)
    strongSettleTimer = deps.setTimer(() => {
      strongSettleTimer = null
      if (disposed) return
      // Against its OWN floor, and SKIPPED rather than deferred when inside it:
      // the next chunk of output re-arms this anyway, so there is nothing to
      // queue up, and queueing was what let a rebuild land in the middle of the
      // next burst instead of in a gap.
      if (deps.now() - lastStrongPaintAt < intervalMs) return
      if (timer) { deps.clearTimer(timer); timer = null; timerDueAt = Number.POSITIVE_INFINITY }
      pendingStrong = false
      paint(true)
    }, quietMs)
  }

  const strongIfStale = (maxStaleMs: number = STRONG_MAX_STALE_MS) => {
    if (disposed) return
    if (deps.now() - atlasFreshAt < maxStaleMs) return
    // Take over any pending trailing repaint rather than letting it fire a
    // second time straight after this one.
    if (timer) { deps.clearTimer(timer); timer = null; timerDueAt = Number.POSITIVE_INFINITY }
    pendingStrong = false
    paint(true)
  }

  const dispose = () => {
    disposed = true
    if (timer) { deps.clearTimer(timer); timer = null; timerDueAt = Number.POSITIVE_INFINITY }
    if (settleTimer) { deps.clearTimer(settleTimer); settleTimer = null }
    if (strongSettleTimer) { deps.clearTimer(strongSettleTimer); strongSettleTimer = null }
  }

  return { schedule, settle, settleStrong, strongIfStale, dispose }
}
