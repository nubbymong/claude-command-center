import React, { useRef } from 'react'
import { useClickOutside } from '../../hooks/useClickOutside'
import { MULTI_SPAWN_POPOVER_WIDTH, placeMultiSpawnPopover, type PopoverAnchor } from '../../utils/multiSpawn'

export interface MultiSpawnPopoverProps {
  /** The blocked control's viewport rect (getBoundingClientRect). */
  anchor: PopoverAnchor
  headline: string
  body: string
  /** "Enable Multi Spawn & launch" on a launch surface, "Enable Multi Spawn" in select mode. */
  actionLabel: string
  onAction: () => void
  onClose: () => void
  /** Hover grace: the pointer travelling from the anchor into the popover must
   *  not close it. The owner of the close timer cancels/reschedules here. */
  onPointerEnter?: () => void
  onPointerLeave?: () => void
  testId?: string
}

/**
 * The needs-Multi-Spawn popover — the ONE explanation a refused launch or a
 * refused selection gets, plus the one-click way out of it.
 *
 * `position: fixed` at a placement computed from the anchor rect, exactly like
 * ConfigContextMenu: the Saved list and the session list are both
 * `overflow-y-auto`, so anything absolutely positioned inside a row is clipped
 * at the scroller's edge. Fixed positioning escapes that without a portal.
 */
export default function MultiSpawnPopover({
  anchor,
  headline,
  body,
  actionLabel,
  onAction,
  onClose,
  onPointerEnter,
  onPointerLeave,
  testId = 'multi-spawn-popover',
}: MultiSpawnPopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, onClose)
  const { left, top, above } = placeMultiSpawnPopover(anchor, {
    width: typeof window === 'undefined' ? 1024 : window.innerWidth,
    height: typeof window === 'undefined' ? 768 : window.innerHeight,
  })

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`${headline} ${body}`}
      data-testid={testId}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      className="fixed z-50 rounded-lg px-3 py-2.5 text-[11px] leading-[1.45]"
      style={{
        left,
        top,
        width: MULTI_SPAWN_POPOVER_WIDTH,
        background: 'var(--surface-overlay)',
        border: '1px solid var(--border-strong)',
        boxShadow: '0 16px 32px -14px #000',
        color: 'var(--text-secondary)',
      }}
    >
      {/* The little tail, on whichever edge faces the anchor. */}
      <span
        aria-hidden
        className="absolute w-[9px] h-[9px] rotate-45"
        style={{
          right: 20,
          [above ? 'bottom' : 'top']: -5,
          background: 'var(--surface-overlay)',
          borderLeft: above ? 'none' : '1px solid var(--border-strong)',
          borderTop: above ? 'none' : '1px solid var(--border-strong)',
          borderRight: above ? '1px solid var(--border-strong)' : 'none',
          borderBottom: above ? '1px solid var(--border-strong)' : 'none',
        }}
      />
      <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{headline}</span>{' '}
      {body}
      <div>
        <button
          type="button"
          onClick={onAction}
          data-testid={`${testId}-enable`}
          className="mt-2 inline-flex rounded-md px-[9px] py-1.5 text-[9.5px] font-bold border border-[color-mix(in_srgb,var(--brand)_45%,transparent)] bg-[color-mix(in_srgb,var(--brand)_15%,transparent)] text-[var(--brand)] hover:bg-[color-mix(in_srgb,var(--brand)_25%,transparent)] transition-colors focus-ring"
        >
          {actionLabel}
        </button>
      </div>
    </div>
  )
}
