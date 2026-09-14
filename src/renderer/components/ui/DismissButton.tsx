// The ONE dismiss control for canvas strips, notices, panels and headers.
//
// Before the rework every surface drew its own ✕ — `&times;` in the filed strip,
// a text ✕ in the completed notice, an inline SVG in the pane header — at three
// sizes, three weights and three hit areas (owner screenshot, 2026-08-29). A
// close control is the most-repeated affordance in the pane, so it is drawn
// exactly once here: a stroked SVG mark (no glyph, no emoji — the repo's rule),
// a 24px hit target, muted at rest and text-coloured on hover/focus, and an
// accessible name that says what it closes.

import React from 'react'

export interface DismissButtonProps {
  onClick: () => void
  /** Accessible name — what this closes: "Dismiss", "Hide the review panel", "Close the canvas". */
  label: string
  /** Optional visible word beside the mark ("hide"), for controls that are more than a corner ✕. */
  text?: string
  /** Mark size in px (the hit target stays 24px). Default 10. */
  size?: number
  disabled?: boolean
  className?: string
  'data-testid'?: string
  title?: string
}

export function DismissButton({ onClick, label, text, size = 10, disabled, className, title, ...rest }: DismissButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title ?? label}
      className={`inline-flex items-center justify-center gap-1 shrink-0 min-w-[24px] h-[24px] px-1 rounded focus-ring transition-colors disabled:opacity-40 disabled:cursor-default ${className ?? ''}`}
      style={{ color: 'var(--text-muted)' }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.color = 'var(--text-primary)' }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)' }}
      data-testid={rest['data-testid'] ?? 'dismiss-button'}
    >
      {text && <span className="text-[11px] leading-none">{text}</span>}
      <svg width={size} height={size} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
        <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
      </svg>
    </button>
  )
}
