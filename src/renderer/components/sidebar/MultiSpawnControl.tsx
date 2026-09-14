import React from 'react'
import { MULTI_SPAWN_MAX_COUNT, resolveMultiSpawnCount, stepMultiSpawnCount } from '../../utils/multiSpawn'

interface MultiSpawnControlProps {
  /** Config label — only for the accessible names. */
  label: string
  /** Stored per-config copy count (clamped/defaulted here, never by the caller). */
  count: number | undefined
  /** Launch exactly `n` copies. */
  onLaunch: (n: number) => void
  /** Persist the stepped count on the config. */
  onCountChange: (n: number) => void
  /** Codex-off and friends: the whole control goes inert. */
  disabled?: boolean
  disabledReason?: string
  testId?: string
}

/**
 * The ×N spawn control (approved mockup, columns 1 and 3): it REPLACES the
 * plain launch/start button on a config whose Allow Multi Spawn is on.
 *
 * play+× launches N copies, the number shows N, and ▾ steps it 1 → 9 → 1 and
 * persists — so the row remembers how many copies this config usually wants.
 * Never rendered for a one-at-a-time config: there the surfaces show the
 * blocked affordance instead.
 */
export default function MultiSpawnControl({
  label,
  count,
  onLaunch,
  onCountChange,
  disabled,
  disabledReason,
  testId = 'multi-spawn-control',
}: MultiSpawnControlProps) {
  const n = resolveMultiSpawnCount(count)
  const copies = n === 1 ? '1 copy' : `${n} copies`
  return (
    <span
      className="inline-flex items-stretch h-5 shrink-0 overflow-hidden rounded-md border border-[color-mix(in_srgb,var(--brand)_42%,transparent)]"
      title={disabled ? disabledReason : 'Multi Spawn — start several at once'}
      data-testid={testId}
    >
      <button
        type="button"
        onClick={disabled ? undefined : (e) => { e.stopPropagation(); onLaunch(n) }}
        disabled={disabled}
        aria-disabled={disabled}
        aria-label={disabled ? disabledReason : `Launch ${copies} of ${label}`}
        title={disabled ? disabledReason : `Launch ${copies}`}
        data-testid={`${testId}-launch`}
        className={
          disabled
            ? 'border-0 px-[7px] text-[10px] font-bold flex items-center gap-[3px] bg-[var(--surface-raised)] text-[var(--text-muted)] cursor-not-allowed'
            : 'border-0 px-[7px] text-[10px] font-bold flex items-center gap-[3px] bg-[color-mix(in_srgb,var(--brand)_15%,transparent)] text-[var(--brand)] hover:bg-[color-mix(in_srgb,var(--brand)_25%,transparent)] transition-colors focus-ring'
        }
      >
        <svg width="9" height="9" viewBox="0 0 12 12" fill="currentColor" aria-hidden><polygon points="3,1 10,6 3,11" /></svg>
        <span aria-hidden>×</span>
      </button>
      <span
        className={`text-[11px] font-bold px-1 min-w-[15px] flex items-center justify-center ${disabled ? 'text-[var(--text-muted)]' : 'text-[var(--brand)]'}`}
        data-testid={`${testId}-count`}
        aria-hidden
      >
        {n}
      </span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onCountChange(stepMultiSpawnCount(n)) }}
        aria-label={`Change copy count for ${label} — now ${n} of ${MULTI_SPAWN_MAX_COUNT}`}
        title="Change how many copies to start"
        data-testid={`${testId}-step`}
        className={`border-0 border-l border-[color-mix(in_srgb,var(--brand)_28%,transparent)] bg-transparent w-[18px] text-[8px] flex items-center justify-center focus-ring ${disabled ? 'text-[var(--text-muted)]' : 'text-[var(--brand)] hover:bg-[color-mix(in_srgb,var(--brand)_15%,transparent)]'}`}
      >
        <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor" aria-hidden><polygon points="2,3 8,3 5,8" /></svg>
      </button>
    </span>
  )
}
