import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useClickOutside } from '../../hooks/useClickOutside'
import type { InsightsAccountChoice } from './insightsAccounts'

export interface CodexRunConfirmProps {
  /** The account the run is for: its wording depends on whether it is this
   *  computer's own sign-in (and its email, when known). */
  choice: InsightsAccountChoice
  /** The tick is given: run the report with this run's confirmation. */
  onRun: () => void
  /** Cancel, Escape or a click outside: nothing runs. */
  onCancel: () => void
  /** The Run button that opened it: Escape and Cancel give it focus back. */
  trigger: React.RefObject<HTMLButtonElement | null>
}

/**
 * P4.7 (mockup D12): a run on an account marked "confirm at launch" asks the
 * per-run confirmation a Codex cloud agent asks, in its words. Nothing is
 * kept: the tick counts for this run and this account only. A run that
 * starts closes it (the page's own Run buttons are off while one runs);
 * Escape or a click outside closes it, and the tick box takes focus. Escape
 * and Cancel give focus back to the Run button that opened it; a click
 * outside leaves focus where that click put it.
 *
 * Anchored under the Run button that opened it (the caller wraps that button
 * in a `relative` span), the way MultiSpawnPopover anchors to its control: a
 * small popover, no backdrop, closed by useClickOutside. Its own file so the
 * page around it is not read as a dialog, and on the dialog palette (#360):
 * tokens only. The run tint is the app teal, --accent.
 */
export default function CodexRunConfirm({ choice, onRun, onCancel, trigger }: CodexRunConfirmProps) {
  const [ticked, setTicked] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLInputElement>(null)
  const dismiss = useCallback(() => {
    onCancel()
    trigger.current?.focus()
  }, [onCancel, trigger])
  useClickOutside(ref, onCancel, dismiss)
  useEffect(() => { box.current?.focus() }, [])
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Confirm this report"
      data-testid="insights-codex-confirm"
      className="absolute right-0 top-full mt-1 z-30 w-[320px] rounded-lg border p-3 text-left shadow-lg"
      style={{ background: 'var(--surface-overlay)', borderColor: 'var(--border-strong)' }}
    >
      <label className="flex items-start gap-2 text-[11.5px] leading-snug cursor-pointer" style={{ color: 'var(--text-primary)' }}>
        <input
          ref={box}
          type="checkbox"
          checked={ticked}
          onChange={(e) => setTicked(e.target.checked)}
          className="mt-0.5 shrink-0 rounded focus-ring"
          data-testid="insights-codex-ack"
        />
        <span>
          {choice.external
            ? `Run this report with the Codex sign-in already on this computer${choice.email ? ` (${choice.email})` : ''}`
            : 'Run this report with this account although its sign-in is not verified'}
        </span>
      </label>
      <div className="flex justify-end gap-1.5 mt-2.5">
        <button
          onClick={onRun}
          disabled={!ticked}
          data-testid="insights-codex-confirm-run"
          className="text-xs px-2.5 py-0.5 rounded border font-medium bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] border-[color-mix(in_srgb,var(--accent)_30%,transparent)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] disabled:bg-[var(--surface-raised)] disabled:border-[var(--border-strong)] disabled:text-[var(--text-muted)] disabled:cursor-not-allowed focus-ring"
        >
          Run
        </button>
        <button
          onClick={dismiss}
          data-testid="insights-codex-confirm-cancel"
          className="text-xs px-2.5 py-0.5 rounded border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-ring"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
