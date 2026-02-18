import React from 'react'

interface CloseDialogProps {
  mode: 'close' | 'update'
  sessionCount: number
  onSaveAndClose: () => void
  onCloseWithoutSaving: () => void
  onCancel: () => void
}

export default function CloseDialog({ mode, sessionCount, onSaveAndClose, onCloseWithoutSaving, onCancel }: CloseDialogProps) {
  return (
    <div className="absolute inset-0 bg-base/80 z-50 flex items-center justify-center">
      <div className="bg-surface0 border border-surface1 rounded-lg shadow-2xl p-6 max-w-sm w-full mx-4">
        <h2 className="text-lg font-semibold text-text mb-2">
          {mode === 'update' ? 'Update & Restart' : 'Close App'}
        </h2>
        <p className="text-sm text-overlay1 mb-5">
          You have {sessionCount} active session{sessionCount !== 1 ? 's' : ''}.
          Would you like to save them for next launch?
        </p>
        <div className="flex flex-col gap-2">
          <button
            onClick={onSaveAndClose}
            className="w-full py-2 px-4 text-sm font-medium rounded bg-blue hover:bg-blue/80 text-crust transition-colors"
          >
            Save Sessions
          </button>
          <button
            onClick={onCloseWithoutSaving}
            className="w-full py-2 px-4 text-sm font-medium rounded bg-surface1 hover:bg-surface2 text-text transition-colors"
          >
            Close Sessions
          </button>
          <button
            onClick={onCancel}
            className="w-full py-1.5 px-4 text-xs text-overlay0 hover:text-overlay1 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
