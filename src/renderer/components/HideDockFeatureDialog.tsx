import React, { useEffect, useRef } from 'react'
import { dialogButtonStyle, scrim } from './ui/Dialog'

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
 *
 * The backdrop is `fixed`, not `absolute`, like every other modal here. It is
 * rendered from inside the sidebar dock, and the sidebar root is `relative`, so
 * an absolutely-positioned backdrop covers the 256px rail instead of the window
 * -- the dialog then renders as a squeezed column with its title wrapped. jsdom
 * has no layout, so only a desktop run shows it.
 *
 * Frame and buttons are hand-rolled rather than `DialogOverlay`/`DialogPanel`/
 * `DialogButton` because the dock's UX-id contract (`data-ux-id` on the
 * backdrop, the panel and both buttons, asserted by sidebar-dock-tips.test.tsx)
 * has no pass-through on those primitives -- they render only the attributes
 * they declare. Colours still come from the same tokens, and the buttons reuse
 * `dialogButtonStyle`, so the look is the shared one.
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
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: scrim(0.6) }}
      data-ux-id="hide-dock-feature-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hide-dock-feature-title"
        data-ux-id="hide-dock-feature-dialog"
        className="rounded-[14px] shadow-2xl p-6 max-w-sm w-full mx-4"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
      >
        <h2 id="hide-dock-feature-title" className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
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
            className="w-full py-2 px-4 text-sm font-medium rounded-[9px] transition-colors focus-ring"
            style={dialogButtonStyle('secondary')}
          >
            {copy.confirm}
          </button>
          <button
            type="button"
            onClick={onCancel}
            data-ux-id="hide-dock-feature-cancel"
            className="w-full py-1.5 px-4 text-xs transition-colors focus-ring"
            style={dialogButtonStyle('ghost')}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
