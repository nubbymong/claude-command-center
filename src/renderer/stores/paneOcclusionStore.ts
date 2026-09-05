import { useEffect } from 'react'
import { create } from 'zustand'
import type { ViewType } from '../types/views'

/**
 * When may a NATIVE pane paint?
 *
 * The browser pane and the claude.ai account pane are WebContentsViews: the
 * main process paints them above every pixel of HTML, so no CSS stacking can
 * put anything over them -- not a page tab, not a dialog, not the guided tour.
 * The renderer therefore hides the view (main detaches it) whenever something
 * must sit on top, and this store is the ONE place that says when that is:
 *
 *  - `activeView` is the active tab in the strip. 'sessions' means a session
 *    tab is showing; any page (Settings, Tokenomics, the Feature Guide, ...)
 *    means a native pane must not paint, or it covers the page. That was the
 *    2026-09-05 report: artifacts opened in the pane, then Settings opened as
 *    a tab, and the artifacts view sat in front of it.
 *  - `overlays` counts the window-level overlays mounted right now -- the
 *    shared dialog backdrop, the guided tour -- each held for exactly as long
 *    as it is mounted. Zero means nothing is on top.
 *
 * A pane is OCCLUDED when either says so. WebviewPane reads the answer through
 * `useNativePanesOccluded()` and folds it into the visibility it sends main,
 * the same flag that parks an open until the pane may show. Anything new that
 * takes the whole window registers with `useOccludesNativePanes()` and is
 * covered without touching the pane. Session-switching is NOT this store's
 * job: that stays on the `isActive` prop, per session.
 */
interface PaneOcclusionState {
  activeView: ViewType
  overlays: number
  setActiveView: (view: ViewType) => void
  /** Hold the overlay count up by one; returns the release. Releasing twice is a no-op. */
  acquireOverlay: () => () => void
}

export const usePaneOcclusionStore = create<PaneOcclusionState>((set) => ({
  activeView: 'sessions',
  overlays: 0,
  setActiveView: (activeView) => set({ activeView }),
  acquireOverlay: () => {
    let released = false
    set((s) => ({ overlays: s.overlays + 1 }))
    return () => {
      if (released) return
      released = true
      set((s) => ({ overlays: Math.max(0, s.overlays - 1) }))
    }
  },
}))

/** Pure: true when a native pane must not paint. */
export function isNativePaneOccluded(s: Pick<PaneOcclusionState, 'activeView' | 'overlays'>): boolean {
  return s.activeView !== 'sessions' || s.overlays > 0
}

/** True while a native pane must not paint (a page tab is active, or an overlay is up). */
export function useNativePanesOccluded(): boolean {
  return usePaneOcclusionStore((s) => isNativePaneOccluded(s))
}

/**
 * Hold the "something is on top of the session area" flag for as long as this
 * component is mounted and `active` is true. Register from the overlay's own
 * component so the flag can never outlive it.
 */
export function useOccludesNativePanes(active = true): void {
  useEffect(() => {
    if (!active) return
    return usePaneOcclusionStore.getState().acquireOverlay()
  }, [active])
}
