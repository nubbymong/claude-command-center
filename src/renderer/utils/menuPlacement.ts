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
  /** A menu opened with almost no room below is LIFTED so at least this much
   *  fits, rather than capped to a sliver. Gives way on a window shorter than
   *  itself -- a floor that can overflow the screen would be this module's own
   *  bug. */
  minHeight?: number
}

export interface MenuPlacement {
  left: number
  top: number
  /** Room from `top` down to the bottom margin. Apply with `overflow-y: auto`:
   *  where the menu is shorter than this it simply does not scroll. */
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

  // --- vertical: choose `top` first; the cap then follows from it ---
  const spaceBelow = viewportHeight - margin - y
  const spaceAbove = y - margin

  let top: number
  if (height <= spaceBelow) top = y // fits below the pointer
  else if (height <= spaceAbove) top = y - height // fits above, bottom edge on the pointer
  else if (spaceBelow >= spaceAbove) top = y // fits neither: take the roomier side
  else top = margin

  // Room from `top` to the bottom margin IS the cap, so `top + maxHeight` can
  // never leave the window whatever the branch above chose.
  const roomFrom = (t: number) => viewportHeight - margin - t
  // Too little room to be usable? Lift the menu instead of capping it to a
  // sliver -- but never above the top margin, and never past what the window
  // can hold at all.
  const floor = Math.min(minHeight, Math.max(0, viewportHeight - margin * 2))
  if (roomFrom(top) < floor) top = viewportHeight - margin - floor
  top = Math.max(margin, top)

  return { left, top, maxHeight: Math.max(0, roomFrom(top)) }
}
