// A small row-level menu: a trigger ("..." or a labelled one) and a menu
// portalled onto document.body. Moved here from the Accounts surface
// (settings/accounts/accounts-ui.tsx) so the session header can share it.
// Semantic tokens only.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  key: string
  label: string
  onSelect: () => void
  /** Draw a rule above this item. */
  separated?: boolean
}

const MENU_GAP = 4
const MENU_MIN_WIDTH = 188

/**
 * The "..." row menu. It renders in a portal on document.body, fixed to the
 * trigger's position (right-aligned, below it, or above it when there is no
 * room below), so no card's `overflow-hidden` can clip it. Keyboard: the
 * first item takes focus on open, arrows move, Home/End jump, Escape closes
 * and returns focus to the trigger. The document listeners exist only while
 * it is open; scrolling or resizing closes it rather than leaving it
 * floating away from its row.
 */
export function RowMenu({ items, label, testId, itemTestId, disabled, trigger }: {
  items: MenuItem[]
  /** Names both the trigger and the menu for assistive technology. */
  label: string
  testId?: string
  /** data-testid for each item, from its key. */
  itemTestId?: (key: string) => string
  disabled?: boolean
  /** A labelled trigger ("Restart" and a caret) in place of the "...". The
   *  menu, its placement and its keyboard handling are the same. */
  trigger?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    setPos(null)
    if (refocus) triggerRef.current?.focus()
  }, [])

  // Place it from the trigger once it has rendered (its height decides
  // whether it fits below). Measured while hidden; shown by the placement.
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return
    const t = trigger.getBoundingClientRect()
    const h = menu.getBoundingClientRect().height
    const below = t.bottom + MENU_GAP
    const fitsBelow = below + h <= window.innerHeight
    const top = fitsBelow || t.top - MENU_GAP - h < 0 ? below : t.top - MENU_GAP - h
    setPos({ top, right: Math.max(0, window.innerWidth - t.right) })
  }, [open])

  // Focus the first item only once the placed, VISIBLE menu is committed:
  // a browser ignores focus() on a `visibility: hidden` element, and with
  // every item at tabIndex -1 the keyboard would then never reach the menu.
  useLayoutEffect(() => {
    if (!open || !pos) return
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open, pos])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      close(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
    }
    const onMove = () => close(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open, close])

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const list = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    if (list.length === 0) return
    const at = list.indexOf(document.activeElement as HTMLElement)
    let next: number | null = null
    if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % list.length
    else if (e.key === 'ArrowUp') next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = list.length - 1
    // Tab leaves the menu the way Escape does: closed, focus on the trigger.
    else if (e.key === 'Tab') { e.preventDefault(); close(true); return }
    if (next === null) return
    e.preventDefault()
    list[next].focus()
  }

  if (items.length === 0) return <span className="w-7 shrink-0" aria-hidden />
  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close(false) : setOpen(true))}
        className={trigger
          ? 'h-6 px-2 rounded-[6px] border inline-flex items-center gap-1.5 text-[11.5px] font-medium whitespace-nowrap focus-ring transition-colors disabled:opacity-40'
          : 'w-7 h-6 rounded-[6px] border inline-flex items-center justify-center text-xs font-bold tracking-[1px] focus-ring disabled:opacity-40'}
        style={trigger
          ? {
              borderColor: open ? 'var(--brand)' : 'var(--border-strong)',
              background: open ? 'var(--surface-overlay)' : 'transparent',
              color: open ? 'var(--text-primary)' : 'var(--text-secondary)',
            }
          : {
              borderColor: open ? 'var(--border-strong)' : 'transparent',
              background: open ? 'var(--surface-overlay)' : 'transparent',
              color: open ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
        data-testid={testId}
      >
        {trigger ?? '...'}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          className="fixed z-[60] rounded-[9px] border p-1 shadow-xl"
          style={{
            minWidth: MENU_MIN_WIDTH,
            top: pos?.top ?? 0,
            right: pos?.right ?? 0,
            // Measured before it is shown: invisible until placed.
            visibility: pos ? 'visible' : 'hidden',
            background: 'var(--surface-overlay)',
            borderColor: 'var(--border-strong)',
          }}
          data-testid={testId ? `${testId}-menu` : undefined}
        >
          {items.map((item) => (
            <React.Fragment key={item.key}>
              {item.separated && <div className="h-px my-1 mx-0.5" style={{ background: 'var(--border-subtle)' }} role="separator" />}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  // Focus goes back to the trigger first, so a dialog the
                  // item opens returns focus there when it closes.
                  close(true)
                  item.onSelect()
                }}
                className="w-full text-left px-2.5 py-1.5 rounded-[6px] text-[12.5px] transition-colors hover:bg-[var(--surface-raised)] focus:bg-[var(--surface-raised)] focus:outline-none"
                style={{ color: 'var(--text-primary)' }}
                data-testid={itemTestId?.(item.key)}
              >
                {item.label}
              </button>
            </React.Fragment>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
