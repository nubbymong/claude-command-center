// Agent Canvas zoom (#368) — the ladder and the arithmetic, pure.
//
// Ctrl+wheel (and Ctrl+= / Ctrl+- / Ctrl+0) zoom the RENDERED PAGE, the way a
// browser tab zooms: the iframe carries CSS `zoom` with its layout size
// compensated (width = 100/zoom %), so the content lays out to a narrower or
// wider CSS viewport and paints scaled — 1 content px = `zoom` stage px. The
// pane folds the factor into every content↔stage conversion and into the glass
// binding, which is what keeps notes anchored in page space at any zoom.
//
// The ladder is Chrome's own zoom ladder clipped to the issue's 50–200 % range,
// so the steps feel like the browser's.

export const CANVAS_ZOOM_LADDER = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const

export const CANVAS_ZOOM_MIN = CANVAS_ZOOM_LADDER[0]
export const CANVAS_ZOOM_MAX = CANVAS_ZOOM_LADDER[CANVAS_ZOOM_LADDER.length - 1]

/** Index of the ladder entry nearest to `zoom` (ties resolve downward). */
function nearestRungIndex(zoom: number): number {
  if (!Number.isFinite(zoom)) return CANVAS_ZOOM_LADDER.indexOf(1)
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < CANVAS_ZOOM_LADDER.length; i++) {
    const distance = Math.abs(CANVAS_ZOOM_LADDER[i] - zoom)
    if (distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best
}

/**
 * Walk `steps` rungs from `current` (+in / −out), clamped to the ladder's ends.
 * A `current` off the ladder snaps to its nearest rung first, so the walk is
 * always rung-to-rung and repeated steps cannot drift.
 */
export function stepCanvasZoom(current: number, steps: number): number {
  const walked = nearestRungIndex(current) + (Number.isFinite(steps) ? Math.trunc(steps) : 0)
  const clamped = Math.max(0, Math.min(CANVAS_ZOOM_LADDER.length - 1, walked))
  return CANVAS_ZOOM_LADDER[clamped]
}

/** "150%" — whole percent, for the chrome chip. */
export function formatCanvasZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`
}
