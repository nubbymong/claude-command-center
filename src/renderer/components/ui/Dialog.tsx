import React from 'react'
import { isContextMenuGesture } from '../../lib/pointer'

/**
 * E5 dialog primitives (#360).
 *
 * The app had two looks: chrome on the semantic tokens (`--surface-*`,
 * `--border-*`, `--text-*`, `--brand`, `--status-*`) and dialogs still on the
 * Catppuccin palette classes from before the rename (`bg-mantle`,
 * `border-surface1`, `text-overlay0`, `bg-blue text-crust`...). These
 * primitives are the ONE place a dialog's frame, header, footer and buttons
 * get their colours, so the dialogs follow the theme the way the chrome does
 * and a restyle is a change here, not a sweep of thirty files.
 *
 * The look is the command dialog's (ADR-018 D12): a raised panel with a subtle
 * border, a 14px radius, an 18px gutter, a brand-filled primary button and an
 * overlay-surface secondary one.
 *
 * House rules baked in (AGENTS.md):
 *  - the modal overlay NEVER closes on click. Ctrl+C in a terminal fires click
 *    events, so a backdrop that closed on click ate the user's dialog. Escape,
 *    Cancel and the close glyph are the ways out. A light, informational dialog
 *    may opt into `onBackdropDismiss`, which is the MOUSEDOWN rule the bar's
 *    popovers use (#386) -- never a click handler. Anything holding unsaved
 *    input should not opt in at all.
 *  - colours are tokens only; no palette class on any element here.
 */

/* ---- shared field styling (the command dialog's, exported so forms match) -- */

export const DIALOG_INPUT_CLASS = 'w-full h-8 px-2.5 rounded-lg border text-[12.5px] outline-none focus-ring'
export const DIALOG_TEXTAREA_CLASS = 'w-full px-2.5 py-1.5 rounded-lg border text-[12.5px] outline-none focus-ring resize-none'
export const DIALOG_INPUT_STYLE: React.CSSProperties = { background: 'var(--surface-base)', borderColor: 'var(--border-strong)', color: 'var(--text-primary)' }
export const DIALOG_LABEL_CLASS = 'block text-[12.5px] font-medium mb-1.5'
export const DIALOG_LABEL_STYLE: React.CSSProperties = { color: 'var(--text-primary)' }
export const DIALOG_HINT_CLASS = 'text-[11px] mt-1 leading-snug'
export const DIALOG_HINT_STYLE: React.CSSProperties = { color: 'var(--text-muted)' }
/** A segmented chip (radio-like). Pair with `dialogSegStyle(selected, disabled)`. */
export const DIALOG_SEG_CHIP = 'h-[30px] px-3 rounded-md border text-xs inline-flex items-center gap-1.5 whitespace-nowrap focus-ring transition-colors'
export const dialogSegStyle = (selected: boolean, disabled?: boolean): React.CSSProperties => ({
  background: selected ? 'color-mix(in srgb, var(--brand) 14%, transparent)' : 'var(--surface-raised)',
  borderColor: selected ? 'color-mix(in srgb, var(--brand) 55%, transparent)' : 'var(--border-subtle)',
  color: selected ? 'var(--brand)' : 'var(--text-secondary)',
  opacity: disabled ? 0.5 : 1,
  cursor: disabled ? 'not-allowed' : 'pointer',
})

/* ---- overlay --------------------------------------------------------------- */

export interface DialogOverlayProps {
  children: React.ReactNode
  /** `fixed` covers the window (default); `absolute` covers the nearest positioned ancestor. */
  position?: 'fixed' | 'absolute'
  /** Tailwind z class. Default `z-50`; raise for a dialog that must sit above another. */
  z?: string
  /** Backdrop darkness 0..1. Default .6 — the command dialog's. */
  dim?: number
  className?: string
  style?: React.CSSProperties
  testId?: string
  /** When true the overlay is transparent to pointer events except the panel. */
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
  id?: string
  /**
   * Opt in to backdrop dismissal. Fires on MOUSEDOWN on the backdrop itself --
   * never on click (Ctrl+C in a terminal fires click), never from a mousedown
   * that started inside the panel, and never for a context-menu gesture (see
   * `lib/pointer.ts`). Omit it and the backdrop is inert, which stays the
   * default for anything holding user input.
   */
  onBackdropDismiss?: () => void
}

/**
 * The backdrop wash at `dim` strength, from the theme-aware `--scrim` token.
 * Hardcoding `rgba(0,0,0,…)` here regressed the light theme, whose dialogs
 * used to fade to a soft near-white (`bg-base/80`) rather than flash to black.
 */
export function scrim(dim: number): string {
  // Rounded because 0.6 * 100 is 60.00000000000001 in binary floating point.
  return `color-mix(in srgb, var(--scrim) ${Math.round(dim * 1000) / 10}%, transparent)`
}

/**
 * The dimmed full-window backdrop. It centres its child and never closes on
 * CLICK — deliberately no `onClick` prop exists on it. `onBackdropDismiss`
 * opts a dialog into the mousedown rule instead.
 */
export function DialogOverlay({ children, position = 'fixed', z = 'z-50', dim = 0.6, className = '', style, testId, onKeyDown, id, onBackdropDismiss }: DialogOverlayProps) {
  // `target === currentTarget` matters here in a way it does not for the bar's
  // popovers: their backdrop is an empty sibling of the surface, this one is the
  // PARENT of the panel. Without it a mousedown that begins on a button inside
  // the dialog bubbles up and dismisses the dialog under the user's finger.
  const onMouseDown = onBackdropDismiss
    ? (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return
        if (isContextMenuGesture(e)) return
        onBackdropDismiss()
      }
    : undefined
  // The inert dismiss: a right-click on the backdrop closes the dialog and the
  // contextmenu is swallowed, so the gesture cannot fall through to whatever is
  // underneath (the terminal, where right-click pastes).
  const onContextMenu = onBackdropDismiss
    ? (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        e.stopPropagation()
        onBackdropDismiss()
      }
    : undefined
  return (
    <div
      id={id}
      className={`${position} inset-0 ${z} flex items-center justify-center p-4 ${className}`}
      style={{ background: scrim(dim), ...style }}
      data-testid={testId}
      data-dialog-overlay=""
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
    >
      {children}
    </div>
  )
}

/* ---- panel ----------------------------------------------------------------- */

export interface DialogPanelProps {
  children: React.ReactNode
  /** id of the heading element (DialogHeader renders it with `titleId`). */
  labelledBy?: string
  /** Used instead of labelledBy when the dialog has no visible heading. */
  ariaLabel?: string
  describedBy?: string
  /** Tailwind width class. Default `w-[440px]` (a confirm); forms use `w-[560px]`. */
  width?: string
  className?: string
  style?: React.CSSProperties
  testId?: string
  role?: 'dialog' | 'alertdialog'
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
  /** Forwarded to the panel element (focus traps). */
  panelRef?: React.Ref<HTMLDivElement>
  tabIndex?: number
}

export function DialogPanel({ children, labelledBy, ariaLabel, describedBy, width = 'w-[440px]', className = '', style, testId, role = 'dialog', onKeyDown, panelRef, tabIndex }: DialogPanelProps) {
  return (
    <div
      ref={panelRef}
      role={role}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      tabIndex={tabIndex}
      className={`rounded-[14px] shadow-2xl ${width} max-w-[94vw] max-h-[88vh] flex flex-col min-h-0 outline-none ${className}`}
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)', ...style }}
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  )
}

/* ---- header / body / footer ------------------------------------------------ */

export interface DialogHeaderProps {
  title: React.ReactNode
  /** id for the h2 — pass the same string as the panel's `labelledBy`. */
  titleId?: string
  subtitle?: React.ReactNode
  /** A small glyph tile drawn left of the title (an SVG or a mark). */
  glyph?: React.ReactNode
  /** Accent for the glyph tile. Defaults to `var(--brand)`; a feature with its
   *  own identity passes its token (tips pass `var(--accent-tip)`) so the
   *  dialog matches the control that opened it. */
  glyphAccent?: string
  /** Something on the right of the title row (a chip, a secondary action). */
  right?: React.ReactNode
  /** Renders the close glyph (×) on the right; Escape/Cancel are the other exits. */
  onClose?: () => void
  closeLabel?: string
  closeTestId?: string
  className?: string
  children?: React.ReactNode
  /** `plain` drops the bottom rule (for a header that runs straight into the body). */
  plain?: boolean
}

export function DialogHeader({ title, titleId, subtitle, glyph, glyphAccent = 'var(--brand)', right, onClose, closeLabel = 'Close', closeTestId, className = '', children, plain }: DialogHeaderProps) {
  return (
    <div className={`px-[18px] pt-4 pb-3 shrink-0 ${className}`} style={plain ? undefined : { borderBottom: '1px solid var(--border-subtle)' }}>
      <div className="flex items-start gap-3">
        {glyph && (
          <div className="shrink-0 w-8 h-8 rounded-[9px] flex items-center justify-center mt-px" style={{ background: `color-mix(in srgb, ${glyphAccent} 14%, transparent)`, color: glyphAccent }} aria-hidden>
            {glyph}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h2 id={titleId} className="text-[15px] font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>{title}</h2>
          {subtitle && <p className="text-xs mt-0.5 leading-snug" style={{ color: 'var(--text-secondary)' }}>{subtitle}</p>}
        </div>
        {right}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 -mr-1.5 -mt-1 w-7 h-7 rounded-md inline-flex items-center justify-center focus-ring transition-colors hover:bg-[var(--surface-overlay)]"
            style={{ color: 'var(--text-muted)' }}
            aria-label={closeLabel}
            title={closeLabel}
            data-testid={closeTestId}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><path d="M2 2l8 8M10 2l-8 8" /></svg>
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

export function DialogBody({ children, className = '', style, testId, scroll = true }: { children: React.ReactNode; className?: string; style?: React.CSSProperties; testId?: string; scroll?: boolean }) {
  return (
    <div className={`px-[18px] py-3.5 min-h-0 ${scroll ? 'overflow-y-auto' : ''} ${className}`} style={style} data-testid={testId}>
      {children}
    </div>
  )
}

export function DialogFooter({ children, left, className = '', style, plain, testId }: { children: React.ReactNode; left?: React.ReactNode; className?: string; style?: React.CSSProperties; plain?: boolean; testId?: string }) {
  return (
    <div className={`px-[18px] pt-3 pb-3.5 flex items-center gap-2 shrink-0 ${className}`} style={{ ...(plain ? undefined : { borderTop: '1px solid var(--border-subtle)' }), ...style }} data-testid={testId}>
      {left}
      <div className="flex-1" />
      {children}
    </div>
  )
}

/* ---- buttons --------------------------------------------------------------- */

export type DialogButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid'

/** `color` of text sitting ON the brand fill. A token so the light theme (a
 *  darker brand blue) can flip it; `#0a0e13` is the dark-theme value. */
export const ON_BRAND = 'var(--text-on-brand, #0a0e13)'

export function dialogButtonStyle(variant: DialogButtonVariant): React.CSSProperties {
  switch (variant) {
    case 'primary': return { background: 'var(--brand)', color: ON_BRAND }
    case 'danger': return { background: 'color-mix(in srgb, var(--status-danger) 16%, transparent)', color: 'var(--status-danger)', border: '1px solid color-mix(in srgb, var(--status-danger) 40%, transparent)' }
    case 'danger-solid': return { background: 'var(--status-danger)', color: ON_BRAND }
    case 'ghost': return { background: 'transparent', color: 'var(--text-secondary)' }
    case 'secondary':
    default: return { background: 'var(--surface-overlay)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }
  }
}

export interface DialogButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  variant?: DialogButtonVariant
  /** `sm` is the footer size (h-7); `md` the tall stacked choice (h-9, full width). */
  size?: 'sm' | 'md'
  block?: boolean
  style?: React.CSSProperties
  testId?: string
}

export function DialogButton({ variant = 'secondary', size = 'sm', block, className = '', style, testId, children, type = 'button', ...rest }: DialogButtonProps) {
  const sizing = size === 'md' ? 'h-9 px-4 text-[12.5px] rounded-[9px]' : 'h-7 px-3 text-xs rounded-[7px]'
  const weight = variant === 'primary' || variant === 'danger-solid' ? 'font-semibold' : variant === 'danger' ? 'font-medium' : ''
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors focus-ring disabled:opacity-40 disabled:cursor-not-allowed ${sizing} ${weight} ${block ? 'w-full' : ''} ${className}`}
      style={{ ...dialogButtonStyle(variant), ...style }}
      data-testid={testId}
      {...rest}
    >
      {children}
    </button>
  )
}

/* ---- callout --------------------------------------------------------------- */

export type DialogCalloutTone = 'warning' | 'danger' | 'info' | 'success' | 'neutral' | 'tip'

const TONE_TOKEN: Record<DialogCalloutTone, string> = {
  warning: 'var(--status-warning)',
  danger: 'var(--status-danger)',
  info: 'var(--status-info)',
  success: 'var(--status-success)',
  neutral: 'var(--text-muted)',
  // Not a status: the tips feature's own accent, so the "where to look" note in
  // the tip dialog reads as part of tips rather than as a warning (#361).
  tip: 'var(--accent-tip)',
}

/** The bordered tinted note the command dialog uses for its review banner and
 *  secret callout: a status token at low alpha for the fill and border. */
export function DialogCallout({ tone = 'neutral', children, testId, className = '', role, icon, title }: { tone?: DialogCalloutTone; children: React.ReactNode; testId?: string; className?: string; role?: string; icon?: React.ReactNode; title?: React.ReactNode }) {
  const t = TONE_TOKEN[tone]
  return (
    <div
      className={`rounded-[9px] border px-3 py-2.5 text-xs leading-snug ${className}`}
      style={{ borderColor: `color-mix(in srgb, ${t} 40%, transparent)`, background: `color-mix(in srgb, ${t} 9%, transparent)`, color: 'var(--text-secondary)' }}
      data-testid={testId}
      data-tone={tone}
      role={role}
    >
      {title && (
        <div className="flex items-center gap-1.5 font-semibold mb-1" style={{ color: tone === 'neutral' ? 'var(--text-primary)' : t }}>
          {icon}
          {title}
        </div>
      )}
      {!title && icon ? <div className="flex items-start gap-2"><span className="shrink-0 mt-px" style={{ color: t }}>{icon}</span><div className="flex-1 min-w-0">{children}</div></div> : children}
    </div>
  )
}

/* ---- escape ---------------------------------------------------------------- */

/**
 * Escape closes the dialog. Registered on `window` in the capture phase so it
 * wins over the terminal's own key handling, and so the key does not also
 * reach the xterm underneath. `enabled=false` while a dialog is mid-work
 * (busy) keeps the user from abandoning it half-way.
 *
 * Two couplings worth knowing before you add this to a dialog:
 *
 *  - **It pre-empts `useFocusTrap`.** The trap listens on `document` in the
 *    BUBBLE phase (`hooks/useFocusTrap.ts`), and window-capture runs first, so
 *    a dialog using this hook swallows Escape before an enclosing trap sees
 *    it. When a trapped dialog renders a child that calls this hook, Escape
 *    closes the CHILD only. That is the behaviour we want (innermost wins),
 *    but it is a coupling, not an accident — see `AddProfileModal`, which is
 *    trapped and renders `OAuthDeviceFlow`.
 *  - **`stopImmediatePropagation`, not `stopPropagation`.** Both of these
 *    listeners sit on the same target (`window`), and `stopPropagation` does
 *    not stop other listeners on the same target — so two mounted dialogs
 *    would both close on one Escape. Effects run child-before-parent, so the
 *    innermost dialog registers first and wins.
 *
 * Do NOT add this to a dialog that holds unsaved user input unless the caller
 * gates it: a form that discards a half-typed config on one keypress, with no
 * confirm and no undo, is a worse bug than the missing shortcut.
 */
export function useDialogEscape(onClose: (() => void) | undefined, enabled = true) {
  React.useEffect(() => {
    if (!enabled || !onClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, enabled])
}
