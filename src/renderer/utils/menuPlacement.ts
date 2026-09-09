/**
 * Viewport-aware placement for the `position: fixed` context menus.
 *
 * Those menus render at the raw pointer coordinates. That is fine until the
 * menu is taller than the space below the click -- then its lower items sit off
 * the bottom of the window and are simply unreachable, with nothing to scroll.
 * The session menu hit this first because it is the tallest and keeps growing
 * (#605 added a Watchdog auto-retry block, and the Switch Account list expands
 * inline to one row per account).
 *
 * Two things have to happen, and BOTH are needed: reposition so the menu fits
 * where it can, and cap its height so that when it cannot fit anywhere it
 * scrolls instead of overflowing. Repositioning alone still loses items on a
 * short window; a cap alone leaves the menu pinned to a click near the bottom
 * with only a sliver of room.
 */

export interface MenuPlacementInput {
  /** Pointer coordinates the menu was opened at. */
  x: number
  y: number
  /** The menu's natural size. Height should be scrollHeight -- the FULL content
   *  height -- so a menu already capped by a previous pass is not measured at
   *  its capped size and then progressively shrunk. */
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  /** Gap kept between the menu and the window edge. */
  margin?: number
  /** Never cap below this: a menu squeezed into a few pixels is worse than one
   *  that slightly overhangs, and it can always scroll. */
  minHeight?: number
}

export interface MenuPlacement {
  left: number
  top: number
  /** Apply with `overflow-y: auto` so a capped menu scrolls. */
  maxHeight: number
}

export function placeMenu({
  x,
  y,
  width,
  height,
  viewportWidth,
  viewportHeight,
  margin = 8,
  minHeight = 120,
}: MenuPlacementInput): MenuPlacement {
  // --- horizontal: prefer the click point, flip to its left, then clamp ---
  let left = x
  if (x + width > viewportWidth - margin) {
    const flipped = x - width
    left = flipped >= margin ? flipped : viewportWidth - margin - width
  }
  if (left < margin) left = margin

  // --- vertical: below the click, else above it, else the roomier side ---
  const spaceBelow = viewportHeight - margin - y
  const spaceAbove = y - margin

  if (height <= spaceBelow) {
    return { left, top: y, maxHeight: Math.max(spaceBelow, minHeight) }
  }
  if (height <= spaceAbove) {
    // Opens upward, bottom edge landing on the click point.
    return { left, top: y - height, maxHeight: Math.max(spaceAbove, minHeight) }
  }
  // Taller than both sides: take the roomier one and let it scroll.
  if (spaceBelow >= spaceAbove) {
    return { left, top: y, maxHeight: Math.max(spaceBelow, minHeight) }
  }
  return { left, top: margin, maxHeight: Math.max(spaceAbove, minHeight) }
}
