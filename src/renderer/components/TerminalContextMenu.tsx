import React, { useEffect, useLayoutEffect, useRef } from 'react'

// Explicit right-click menu for terminals — the fail-safe half of the
// right-click fix. It appears exactly when a blind action would be wrong:
// while a mouse-tracking program owns the mouse (xterm's selection service is
// off, so "no selection" proves nothing about the user's intent), when classic
// copy/paste is disabled (the old code blind-pasted on a false copy-on-select
// premise), or when a blind classic paste would submit multi-line clipboard at
// a raw prompt. Copy/Paste here are explicit clicks, so nothing reaches the
// PTY unasked.
interface Props {
  x: number
  y: number
  hasSelection: boolean
  onCopy: () => void
  onPaste: () => void
  /** Repaint + geometry re-sync (#503) — the rescue for a pane something wrote
   *  over (an ssh host-key prompt, a console-attached tool). */
  onRepaint: () => void
  onClose: () => void
}

export default function TerminalContextMenu({ x, y, hasSelection, onCopy, onPaste, onRepaint, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)

  // Clamp into the viewport after first paint (below-right of the pointer when
  // it fits; flipped/pinned otherwise). Rendered transparent until positioned.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let left = x
    let top = y
    if (left + rect.width > window.innerWidth - 4) left = window.innerWidth - rect.width - 4
    if (top + rect.height > window.innerHeight - 4) top = y - rect.height - 4
    if (left < 4) left = 4
    if (top < 4) top = 4
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.opacity = '1'
  }, [x, y])

  // Escape dismisses. Capture phase + stopPropagation so a modal / keybinding
  // behind the menu does not also act on the same keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const itemClass =
    'w-full flex items-center justify-between gap-6 px-3 py-1.5 text-xs text-[var(--text-primary)] text-left ' +
    'hover:bg-[var(--surface-overlay)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent'

  return (
    // mousedown (not click) so the dismiss cannot be triggered by a synthetic
    // click event, and so the menu is gone before any mouseup reaches xterm.
    <div
      className="fixed inset-0 z-50"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
    >
      <div
        ref={menuRef}
        className="fixed rounded-lg shadow-xl py-1 w-56"
        style={{ left: x, top: y, opacity: 0, background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button type="button" className={itemClass} onClick={onCopy} disabled={!hasSelection}>
          <span>Copy</span>
          <span style={{ color: 'var(--text-muted)' }}>Ctrl+Shift+C</span>
        </button>
        {!hasSelection && (
          <div className="px-3 pb-1.5 pt-0.5 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
            To copy, select text first — hold Shift while dragging if the app is
            tracking the mouse (full-screen apps like Claude Code&apos;s login).
          </div>
        )}
        <button type="button" className={itemClass} onClick={onPaste}>
          <span>Paste</span>
          <span style={{ color: 'var(--text-muted)' }}>Ctrl+V</span>
        </button>
        <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
        <button
          type="button"
          className={itemClass}
          onClick={onRepaint}
          title="Re-confirms the terminal size and redraws — stops NEW garbling after something printed over the pane. Lines already written stay as they arrived."
          data-testid="terminal-ctx-repaint"
        >
          <span>Repaint terminal</span>
          <span style={{ color: 'var(--text-muted)' }}>Ctrl+Alt+R</span>
        </button>
      </div>
    </div>
  )
}
