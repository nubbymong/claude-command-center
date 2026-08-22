import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useConfigWriteLockStore } from '../../stores/configWriteLockStore'
import ConfigLoadFailedNotice from '../ConfigLoadFailedNotice'

/**
 * The collapsed rail's window onto ConfigLoadFailedNotice (#370).
 *
 * The notice itself lives in the expanded sidebar's session list, which is the
 * one place the collapsed rail does not render -- so with the sidebar
 * collapsed nothing on screen said the app was running on defaults with saving
 * latched off, and every save silently did nothing. The notice is deliberately
 * not dismissible for exactly that reason, and collapsing the sidebar was a
 * dismiss in all but name.
 *
 * This is a 32px danger glyph in the rail, the same footprint as the dock
 * pills so the rail does not grow. It has a tooltip naming the state, and a
 * click opens the SAME notice (reason text, "start fresh anyway") in a popover
 * beside the rail, so the failure text and the way out are reachable without
 * expanding the sidebar. The popover can be closed -- the glyph cannot: it
 * stays until the lock clears (start fresh, or a relaunch with the file
 * readable), which is the non-dismissibility the notice relies on.
 *
 * Popover dismissal is Escape or a backdrop MOUSEDOWN (the TerminalContextMenu
 * pattern), never click: Ctrl+C in a terminal fires click events.
 */

const POPOVER_W = 304

const TOOLTIP = 'Your configuration could not be loaded -- saving is paused. Click for details.'

export default function ConfigLoadFailedRailIndicator() {
  const locked = useConfigWriteLockStore((s) => s.lockedReason !== null)
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Anchor beside the glyph after first paint, clamped into the window (the
  // rail can be taller than the notice, or the glyph near the bottom edge).
  useLayoutEffect(() => {
    if (!open) return
    const el = popoverRef.current
    const anchor = buttonRef.current?.getBoundingClientRect()
    if (!el || !anchor) return
    const rect = el.getBoundingClientRect()
    let left = anchor.right + 8
    let top = anchor.top
    if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8
    if (top < 8) top = 8
    if (left < 8) left = 8
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.opacity = '1'
  }, [open])

  // Escape closes the popover only. Capture phase + stopPropagation so a
  // keybinding behind it does not also act on the same keystroke.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      setOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open])

  // Lock cleared (start fresh, from here or anywhere): nothing to show, and
  // nothing to keep open.
  useEffect(() => {
    if (!locked) setOpen(false)
  }, [locked])

  if (!locked) return null

  return (
    <div className="flex flex-col items-center py-1.5 shrink-0">
      <button
        ref={buttonRef}
        type="button"
        data-ux-id="config-load-failed-rail-indicator"
        onClick={() => setOpen((v) => !v)}
        aria-label={TOOLTIP}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="group w-8 h-8 flex items-center justify-center rounded-lg transition-colors focus-ring relative"
        style={{
          color: 'var(--status-danger)',
          background: 'color-mix(in srgb, var(--status-danger) 14%, transparent)',
          border: '1px solid color-mix(in srgb, var(--status-danger) 48%, transparent)',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        {/* Instant inline tooltip, the rail's own pattern (SidebarNav); sits to
            the right of the glyph so it never clips off the window edge. */}
        <span
          className="pointer-events-none absolute z-40 left-full ml-2 top-1/2 -translate-y-1/2 px-2 py-0.5 text-[11px] rounded bg-surface1 text-text border border-surface2 shadow-md whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-100"
          aria-hidden="true"
        >
          {TOOLTIP}
        </span>
      </button>

      {open && (
        // mousedown (not click) dismisses: a synthetic click must not close it,
        // and the popover is gone before any mouseup reaches a terminal.
        <div
          data-ux-id="config-load-failed-popover-backdrop"
          className="fixed inset-0 z-50"
          onMouseDown={() => setOpen(false)}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false) }}
        >
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Configuration could not be loaded"
            data-ux-id="config-load-failed-popover"
            className="fixed rounded-xl border shadow-xl pt-2"
            style={{
              width: POPOVER_W,
              opacity: 0,
              background: 'var(--surface-overlay)',
              borderColor: 'var(--border-strong)',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* The notice, unchanged: same copy, same reason line, same "start
                fresh" button -- so the two surfaces can never drift apart. */}
            <ConfigLoadFailedNotice />
          </div>
        </div>
      )}
    </div>
  )
}
