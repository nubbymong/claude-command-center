// WP2 commit 6: small building blocks the Accounts surface shares between
// its provider sections (Claude's existing profile panel and the managed
// provider sections). Semantic tokens only.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProviderId } from '../../../../shared/providers'
import { useProviderAccountsStore, reviewerLine, reviewerNotice, providerView, type StatusTone } from '../../../stores/providerAccountsStore'
import { DialogCallout, DialogOverlay, DialogPanel } from '../../ui/Dialog'
import { useFocusTrap } from '../../../hooks/useFocusTrap'

export type PillTone = 'default' | 'reviewer' | 'warn' | 'beta' | 'muted'

const PILL_TOKEN: Record<PillTone, string> = {
  default: 'var(--brand)',
  reviewer: 'var(--status-info)',
  warn: 'var(--status-warning)',
  beta: 'var(--brand)',
  muted: 'var(--text-muted)',
}

/** A rounded badge ("Default", "Reviewer", "Beta", "Confirm each launch"). */
export function Pill({ tone, children, testId, title }: { tone: PillTone; children: React.ReactNode; testId?: string; title?: string }) {
  const t = PILL_TOKEN[tone]
  return (
    <span
      className="inline-flex items-center rounded-full border px-[7px] py-px text-[10.5px] font-medium whitespace-nowrap shrink-0"
      style={{ borderColor: `color-mix(in srgb, ${t} 50%, transparent)`, color: t, background: `color-mix(in srgb, ${t} 10%, transparent)` }}
      data-testid={testId}
      title={title}
    >
      {children}
    </span>
  )
}

const TONE_TOKEN: Record<StatusTone, string> = {
  ok: 'var(--status-success)',
  warn: 'var(--status-warning)',
  muted: 'var(--text-muted)',
}

/** A status dot and its sentence ("Signed in", "Codex 0.155.1 - ready"). */
export function StatusText({ tone, children, testId }: { tone: StatusTone; children: React.ReactNode; testId?: string }) {
  const t = TONE_TOKEN[tone]
  return (
    <span className="inline-flex items-start gap-1.5 text-xs" style={{ color: tone === 'ok' ? 'var(--text-secondary)' : t }} data-testid={testId} data-tone={tone}>
      <span className="w-[7px] h-[7px] rounded-full shrink-0 mt-[5px]" style={{ background: t }} aria-hidden />
      <span>{children}</span>
    </span>
  )
}

export function MutedLine({ children, testId, className = '' }: { children: React.ReactNode; testId?: string; className?: string }) {
  return <div className={`text-[11.5px] leading-snug ${className}`} style={{ color: 'var(--text-muted)' }} data-testid={testId}>{children}</div>
}

export function ErrorLine({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return <div className="text-[11.5px] leading-snug mt-1" style={{ color: 'var(--status-danger)' }} role="alert" data-testid={testId}>{children}</div>
}

/** A small secondary button for row-level actions. */
export function RowButton({ children, onClick, disabled, testId, title }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; testId?: string; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center rounded-[6px] border px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap focus-ring transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--surface-overlay)]"
      style={{ borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}
      data-testid={testId}
    >
      {children}
    </button>
  )
}

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
export function RowMenu({ items, label, testId, itemTestId, disabled }: {
  items: MenuItem[]
  /** Names both the trigger and the menu for assistive technology. */
  label: string
  testId?: string
  /** data-testid for each item, from its key. */
  itemTestId?: (key: string) => string
  disabled?: boolean
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
        className="w-7 h-6 rounded-[6px] border inline-flex items-center justify-center text-xs font-bold tracking-[1px] focus-ring disabled:opacity-40"
        style={{
          borderColor: open ? 'var(--border-strong)' : 'transparent',
          background: open ? 'var(--surface-overlay)' : 'transparent',
          color: open ? 'var(--text-primary)' : 'var(--text-muted)',
        }}
        data-testid={testId}
      >
        ...
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

/**
 * The reviewer line under a provider's section header: which account this
 * provider's code reviews use, and why, plus a cleared-reviewer notice when
 * the app had to drop an earlier choice. Nothing when the provider does not
 * review here.
 */
export function ReviewerLineBlock({ providerId }: { providerId: ProviderId }) {
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const line = reviewerLine(snapshot, providerId)
  if (!line) return null
  const platform = typeof window !== 'undefined' ? window.electronPlatform : ''
  const notice = reviewerNotice(snapshot, providerId, platform)
  const macClaude = providerId === 'claude' && platform === 'darwin' && !!providerView(snapshot, 'claude')?.review
  return (
    <div className="text-[12.5px] leading-snug space-y-1" data-testid={`reviewer-line-${providerId}`}>
      {line.kind === 'no-account' ? (
        <div style={{ color: 'var(--text-secondary)' }}>No account can run code reviews yet.</div>
      ) : (
        <div style={{ color: 'var(--text-secondary)' }}>
          Code reviews use:{' '}
          <b className="font-semibold" style={{ color: 'var(--text-primary)' }} data-testid={`reviewer-line-${providerId}-account`}>
            {line.name}{line.label ? ` (${line.label})` : ''}
          </b>
        </div>
      )}
      <MutedLine>When none is set, reviews use the default account.</MutedLine>
      {line.kind === 'account' && !line.ready && (
        <div className="text-[11.5px]" style={{ color: 'var(--status-warning)' }} data-testid={`reviewer-not-ready-${providerId}`}>
          Reviews can't run on it right now.
        </div>
      )}
      {notice && <MutedLine testId={`reviewer-notice-${providerId}`}>{notice}</MutedLine>}
      {macClaude && (
        <DialogCallout tone="info" className="mt-2" testId="reviewer-mac-callout">
          Claude reviews on macOS use your normal Claude sign-in.
        </DialogCallout>
      )}
    </div>
  )
}

/**
 * The Accounts surface's modal frame: portalled to document.body (no card
 * clips or stacks over it), with focus trapped inside. On open, and again
 * whenever `focusKey` changes (a dialog's step), focus goes to the element
 * marked `data-autofocus`, else to the first control.
 */
export function AccountsModal({ labelledBy, testId, overlayTestId, width, role = 'dialog', focusKey, children }: {
  labelledBy: string
  testId?: string
  overlayTestId?: string
  width?: string
  role?: 'dialog' | 'alertdialog'
  focusKey?: string
  children: React.ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [focusKey])
  return createPortal(
    <DialogOverlay testId={overlayTestId}>
      <DialogPanel panelRef={panelRef} labelledBy={labelledBy} width={width} role={role} testId={testId}>
        {children}
      </DialogPanel>
    </DialogOverlay>,
    document.body,
  )
}
