import React from 'react'
import { DialogOverlay, DialogPanel, DialogHeader, DialogBody, DialogFooter, DialogButton, useDialogEscape } from './ui/Dialog'

interface CloseDialogProps {
  mode: 'close' | 'update'
  sessionCount: number
  onSaveAndClose: () => void
  onCloseWithoutSaving: () => void
  onCancel: () => void
}

export default function CloseDialog({ mode, sessionCount, onSaveAndClose, onCloseWithoutSaving, onCancel }: CloseDialogProps) {
  useDialogEscape(onCancel)
  return (
    <DialogOverlay position="absolute" testId="close-dialog">
      <DialogPanel width="w-[400px]" labelledBy="close-dialog-title">
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
