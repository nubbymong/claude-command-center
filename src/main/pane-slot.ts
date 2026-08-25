/**
 * pane-slot.ts — "one attached pane view per window", enforced in MAIN.
 *
 * A BrowserWindow shows exactly one pane rectangle (the browser pane) at a
 * time. Native WebContentsViews render above all HTML and cannot be safely
 * layered, so two pane views attached to one window at overlapping bounds are a
 * clickjack primitive: a renderer could stack a decoy over the signed-in
 * account view and flip the z-order (#439 adversarial review, MED-1). The
 * renderer's own visibility logic already keeps inactive panes detached, but a
 * COMPROMISED renderer is the threat model here — so the invariant is made a
 * main-owned property that does not depend on the renderer behaving.
 *
 * Both pane owners (the ordinary browser view in webview-manager and the
 * account view in account-web/account-pane) attach and detach through here
 * instead of touching `parent.contentView` directly. Attaching a new view
 * detaches whatever this window currently holds. This module imports nothing
 * from either owner, so it introduces no cycle.
 *
 * No default export (project convention).
 */
import type { BrowserWindow, WebContentsView } from 'electron'

interface Occupant {
  view: WebContentsView
}

const byWindowId = new Map<number, Occupant>()

/**
 * Attach `view` to `parent`, detaching whatever pane view the window currently
 * holds first. Idempotent for the same view (re-attaching the current occupant
 * is a no-op beyond the addChildView, which Electron tolerates).
 */
export function attachPaneView(parent: BrowserWindow, view: WebContentsView): void {
  const cur = byWindowId.get(parent.id)
  if (cur && cur.view !== view) {
    try { parent.contentView.removeChildView(cur.view) } catch { /* already gone */ }
    // Belt-and-braces: shrink the evicted view so a failed detach cannot leave
    // it covering the newcomer (the same guard setVisible uses).
    try { cur.view.setBounds({ x: 0, y: 0, width: 1, height: 1 }) } catch { /* noop */ }
  }
  parent.contentView.addChildView(view)
  byWindowId.set(parent.id, { view })
}

/** Detach `view` from `parent` and clear the slot if it held this view. */
export function detachPaneView(parent: BrowserWindow, view: WebContentsView): void {
  try { parent.contentView.removeChildView(view) } catch { /* already gone */ }
  const cur = byWindowId.get(parent.id)
  if (cur && cur.view === view) byWindowId.delete(parent.id)
}

/** Forget a window's slot entirely (the window itself is gone). */
export function forgetPaneWindow(windowId: number): void {
  byWindowId.delete(windowId)
}
