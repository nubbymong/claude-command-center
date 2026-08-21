import React, { useEffect, useRef } from 'react'

export type DockFeature = 'tips' | 'ask'

interface Props {
  feature: DockFeature
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirmation for hiding one of the sidebar dock's two features.
 *
 * This is a warning rather than a toggle because hiding here turns the FEATURE
 * off, not just its row: with tips hidden nothing is picked at launch and no tip
 * is ever raised, and with Ask Conductor hidden there is no way to start one.
 * Neither is discoverable again from the place it used to be -- the row it was
 * dismissed from is gone -- so the dialog's job is to name Settings before the
 * user loses the affordance, not after.
 *
 * No `onClick` on the backdrop (house rule): Ctrl+C fires click events, so a
 * dismiss-on-backdrop modal gets closed spuriously. Escape cancels.
 */
const COPY: Record<DockFeature, { title: string; body: string; note: string; confirm: string }> = {
  tips: {
    title: 'Hide tips?',
    body: 'Tips will be switched off completely, not just hidden from the sidebar. No tip will be chosen at launch and none will be shown anywhere in the app.',
    note: 'You can switch them back on in Settings → General → "Show intelligent tips".',
    confirm: 'Hide tips',
  },
  ask: {
    title: 'Hide Ask Conductor?',
    body: 'The Ask Conductor button will be removed from the sidebar, and that is the only way to start one. An Ask session you already have open will stay open and keep working.',
    note: 'You can bring the button back in Settings → General → "Show Ask Conductor".',
    confirm: 'Hide Ask Conductor',
  },
}

export default function HideDockFeatureDialog({ feature, onConfirm, onCancel }: Props) {
  const copy = COPY[feature]
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center"
      style={{ background: 'color-mix(in srgb, var(--color-base) 80%, transparent)' }}
      data-ux-id="hide-dock-feature-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hide-dock-feature-title"
        data-ux-id="hide-dock-feature-dialog"
        className="bg-surface0 border border-surface1 rounded-lg shadow-2xl p-6 max-w-sm w-full mx-4"
      >
        <h2 id="hide-dock-feature-title" className="text-lg font-semibold text-text mb-2">
          {copy.title}
        </h2>
        <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
          {copy.body}
        </p>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          {copy.note}
        </p>
        <div className="flex flex-col gap-2">
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            data-ux-id="hide-dock-feature-confirm"
            className="w-full py-2 px-4 text-sm font-medium rounded bg-surface1 hover:bg-surface2 text-text transition-colors focus-ring"
          >
            {copy.confirm}
          </button>
          <button
            type="button"
            onClick={onCancel}
            data-ux-id="hide-dock-feature-cancel"
            className="w-full py-1.5 px-4 text-xs text-overlay1 hover:text-text transition-colors focus-ring"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
