import React, { useRef } from 'react'
import { useClickOutside } from '../../hooks/useClickOutside'

interface Props {
  x: number
  y: number
  /** What the single item offers to hide, e.g. "Tips" or "Ask Conductor". */
  label: string
  onHide: () => void
  onClose: () => void
}

/** Width used to keep the menu inside the window when opened near the right
 *  edge. The dock sits at the very bottom of a narrow rail, so both axes need
 *  clamping -- a menu opened on the last row would otherwise hang below the
 *  viewport, where the app has no scroll. */
const MENU_W = 170
const MENU_H = 40

/**
 * The dock rows' right-click menu: one item, "Hide <label>".
 *
 * Deliberately not a shared context menu -- the two dock rows offer exactly one
 * action and nothing else, and folding them into the config/session menus would
 * mean carrying their move/pin/delete vocabulary into a place none of it
 * applies. Confirmation lives in HideDockFeatureDialog, not here.
 */
export default function DockRowMenu({ x, y, label, onHide, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, onClose)

  const left = Math.max(4, Math.min(x, window.innerWidth - MENU_W - 4))
  const top = Math.max(4, Math.min(y, window.innerHeight - MENU_H - 4))

  return (
    <div
      ref={ref}
      role="menu"
      data-ux-id="dock-row-menu"
      className="fixed z-50 rounded-lg shadow-xl py-1"
      style={{ left, top, minWidth: MENU_W, background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={onHide}
        data-ux-id="dock-row-menu-hide"
        className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors flex items-center gap-2"
        style={{ color: 'var(--text-primary)' }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden>
          <path d="M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6z" />
          <circle cx="6" cy="6" r="1.4" />
          <line x1="1.6" y1="10.4" x2="10.4" y2="1.6" />
        </svg>
        Hide {label}
      </button>
    </div>
  )
}
