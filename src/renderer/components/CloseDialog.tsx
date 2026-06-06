import React from 'react'

interface CloseDialogProps {
  mode: 'close' | 'update'
  sessionCount: number
  /** A legacy-log import is in flight (user-approved quit-confirm): warn that
   *  quitting stops it safely and it resumes from Settings on the next run. */
  migrationRunning?: boolean
  onSaveAndClose: () => void
  onCloseWithoutSaving: () => void
  onCancel: () => void
}

export default function CloseDialog({ mode, sessionCount, migrationRunning, onSaveAndClose, onCloseWithoutSaving, onCancel }: CloseDialogProps) {
  // Import-only variant: nothing to save, but a log import is running — the
  // classic "save your sessions?" copy would be nonsense at sessionCount 0.
  const importOnly = migrationRunning === true && sessionCount === 0

  return (
    <div className="absolute inset-0 bg-base/80 z-50 flex items-center justify-center">
      <div className="bg-surface0 border border-surface1 rounded-lg shadow-2xl p-6 max-w-sm w-full mx-4">
        <h2 className="text-lg font-semibold text-text mb-2">
          {mode === 'update' ? 'Update & Restart' : 'Close App'}
        </h2>
        {!importOnly && (
          <p className="text-sm text-overlay1 mb-3">
            You have {sessionCount} active session{sessionCount !== 1 ? 's' : ''}.
            Would you like to save them for next launch?
          </p>
        )}
        {migrationRunning && (
          <p className="text-sm mb-5 text-yellow">
            A log import is running. If you quit now it stops safely and will continue
            from where it left off the next time you run it from Settings. Nothing is deleted.
          </p>
        )}
        <div className="flex flex-col gap-2">
          {!importOnly && (
            <button
              onClick={onSaveAndClose}
              className="w-full py-2 px-4 text-sm font-medium rounded bg-blue hover:bg-blue/80 text-crust transition-colors"
            >
              Save Sessions
            </button>
          )}
          <button
            onClick={onCloseWithoutSaving}
            className="w-full py-2 px-4 text-sm font-medium rounded bg-surface1 hover:bg-surface2 text-text transition-colors"
          >
            {importOnly ? 'Quit anyway' : 'Close Sessions'}
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
