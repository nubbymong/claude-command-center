// Keyboard focus for the surfaces that cover the whole window: the onboarding
// pages, and the one-time introduction takeover and its replay, which are
// rendered in the same onboarding shell (OnboardingShell). While one is
// showing, Tab and Shift+Tab stay inside it: without this they walked out to
// the title bar and sidebar hidden underneath (VM audit, 2026-09-25). The app
// behind is also made inert (App.tsx); this is the keyboard half, and it holds
// wherever the surface is rendered.
//
// The window-close dialogs (CloseDialog, SshCloseDialog) use it too, as the
// top layer above all of those (`topmost`): Tab walked out of them into the
// page behind as well.
import { useEffect } from 'react'
import type { RefObject } from 'react'

/** Is the element actually rendered? Page tabs and sessions stay mounted
 *  while hidden (an ancestor with display: none, App.tsx), so a dialog left
 *  open in one is in the DOM but not on screen. Walks the ancestors rather
 *  than asking for client rects, which a test DOM cannot give. */
export function rendered(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if ((n as HTMLElement).hidden) return false
    const cs = window.getComputedStyle(n)
    if (cs.display === 'none' || cs.visibility === 'hidden') return false
  }
  return true
}

/** Is another dialog open, other than the one `own` belongs to? Any rendered
 *  dialog backdrop or modal that neither contains `own` nor sits inside it.
 *  Such a dialog was opened after this surface and paints above it (the
 *  close dialogs do, and so does the add-account dialog a setup page opens,
 *  which is portalled to the document body), so its keys are its own. One
 *  left open in a hidden page tab or session does not count. */
export function otherDialogOpen(own: Element | null): boolean {
  if (typeof document === 'undefined') return false
  return Array.from(document.querySelectorAll('[data-dialog-overlay], [aria-modal="true"]'))
    .some((el) => (!own || !(el === own || el.contains(own) || own.contains(el))) && rendered(el))
}

const CANDIDATES = 'button, a[href], input, select, textarea, [tabindex]'

/** The controls Tab stops at inside `root`, in document order: enabled, not
 *  taken out of the order (tabindex -1, as a radio group does for every
 *  choice but the selected one), not inert, and rendered. */
export function tabStops(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(CANDIDATES)).filter((el) => {
    if ((el as HTMLButtonElement).disabled) return false
    if (el.tabIndex < 0) return false
    if (el instanceof HTMLInputElement && el.type === 'hidden') return false
    if (el.closest('[inert]')) return false
    return rendered(el)
  })
}

/** Does `a` come before `b` in the document? */
const before = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

/** Marks the root of a `topmost` trap while it is active. */
export const TOPMOST_ATTR = 'data-topmost-focus'

/** Is another topmost surface open after `own` in the document? Topmost
 *  surfaces share one layer (WINDOW_CLOSE_Z), so the later one paints above
 *  and its keys are its own. */
function laterTopmostOpen(own: Element): boolean {
  return Array.from(document.querySelectorAll(`[${TOPMOST_ATTR}]`))
    .some((el) => el !== own && !el.contains(own) && !own.contains(el) && before(own, el) && rendered(el))
}

export interface ContainFocusOptions {
  /** The surface paints on the top layer (the window-close dialogs): it does
   *  not give way to the dialogs and covering surfaces below it, only to
   *  another topmost one rendered after it. */
  topmost?: boolean
}

/**
 * Keep Tab and Shift+Tab inside `ref` while `active`. From the last stop Tab
 * goes round to the first, from the first Shift+Tab goes to the last, and a
 * Tab pressed with focus outside (on the page body, after a control that had
 * it went away) comes back in. It moves no focus on its own: each surface
 * puts focus on its primary button when it opens.
 *
 * It gives way while another dialog is open above the surface (otherDialogOpen:
 * the close dialogs over the introduction takeover, the add-account dialog
 * over a setup page): that dialog traps its own keys. A `topmost` surface is
 * above all of those, so it gives way only to a later topmost one. It listens
 * in the bubble phase, so the introduction's key guard (capture phase, which
 * swallows every key while the takeover is arming) still comes first, and a
 * key a control has already handled (defaultPrevented) is left alone.
 */
export function useContainFocus(ref: RefObject<HTMLElement | null>, active: boolean, options: ContainFocusOptions = {}): void {
  const topmost = !!options.topmost
  useEffect(() => {
    if (!active) return
    const marked = topmost ? ref.current : null
    marked?.setAttribute(TOPMOST_ATTR, '')
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      const root = ref.current
      if (!root || (topmost ? laterTopmostOpen(root) : otherDialogOpen(root))) return
      // Rendered stops only: a surface that is not on screen has none, and
      // traps nothing.
      const stops = tabStops(root)
      if (stops.length === 0) return
      const first = stops[0]
      const last = stops[stops.length - 1]
      const at = document.activeElement
      let to: HTMLElement | null = null
      if (!at || !root.contains(at)) to = e.shiftKey ? last : first
      else if (e.shiftKey && !stops.some((s) => s !== at && before(s, at))) to = last
      else if (!e.shiftKey && !stops.some((s) => s !== at && before(at, s))) to = first
      if (!to) return
      e.preventDefault()
      to.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      marked?.removeAttribute(TOPMOST_ATTR)
    }
  }, [ref, active, topmost])
}
