import React, { useRef } from 'react'
import { DialogOverlay, DialogPanel, DialogHeader, DialogBody, DialogFooter, DialogButton, useDialogEscape, WINDOW_CLOSE_Z } from './ui/Dialog'
import { useContainFocus } from '../onboarding/contain-focus'
import { useOccludesNativePanes } from '../stores/paneOcclusionStore'

interface CloseDialogProps {
  mode: 'close' | 'update'
  sessionCount: number
  onSaveAndClose: () => void
  onCloseWithoutSaving: () => void
  onCancel: () => void
}

/**
 * Closing (or updating) with sessions open: save them, close them, or cancel.
 * It paints on the top layer (WINDOW_CLOSE_Z), above the onboarding pages and
 * the introduction's takeover and replay, and keeps Tab inside itself while
 * it is open: it was once painted under those surfaces, invisible, with focus
 * on "Save sessions", and Tab walked out of it into the page behind.
 */
export default function CloseDialog({ mode, sessionCount, onSaveAndClose, onCloseWithoutSaving, onCancel }: CloseDialogProps) {
  useDialogEscape(onCancel)
  const panelRef = useRef<HTMLDivElement>(null)
  // "Save sessions" keeps the focus it opens with (autoFocus below); the trap
  // only keeps Tab and Shift+Tab inside.
  useContainFocus(panelRef, true, { topmost: true })
  // The native panes (the in-app browser, the claude.ai account view) paint
  // above all HTML, so they hide while this shows. The overlay is `absolute`,
  // and DialogOverlay holds that flag only for a `fixed` one.
  useOccludesNativePanes()
  return (
    <DialogOverlay position="absolute" z={WINDOW_CLOSE_Z} testId="close-dialog">
      <DialogPanel width="w-[400px]" labelledBy="close-dialog-title" panelRef={panelRef}>
        <DialogHeader
          titleId="close-dialog-title"
          title={mode === 'update' ? 'Update and restart' : 'Close the app'}
          subtitle={<>You have {sessionCount} active session{sessionCount !== 1 ? 's' : ''}.</>}
        />
        <DialogBody>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Save them and they come back at the next launch, in the same tabs; close them and they are gone.
          </p>
        </DialogBody>
        <DialogFooter>
          <DialogButton variant="ghost" onClick={onCancel} testId="close-dialog-cancel">Cancel</DialogButton>
          <DialogButton variant="secondary" onClick={onCloseWithoutSaving} testId="close-dialog-discard">Close sessions</DialogButton>
          <DialogButton variant="primary" onClick={onSaveAndClose} testId="close-dialog-save" autoFocus>Save sessions</DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
