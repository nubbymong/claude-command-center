import React, { useState } from 'react'
import type { LegacyImportCompletion } from '../stores/migrationStore'

/**
 * Persistent post-import reclaim entry (Settings -> Existing logs).
 *
 * The reclaim controls previously existed ONLY inside the in-memory post-run
 * report, so an app restart stranded a fully-armed reclaim with no UI door
 * (user-hit after the real 16 GB import). This section renders whenever the
 * PERSISTED completion marker says a clean import ran and the original folders
 * are still on disk. Two-step confirm; the server-side reclaim gates (frozen +
 * completion marker + DB-not-empty) still apply regardless.
 */
export default function ReclaimSpaceSection({
  sessionFolders,
  completion,
  onReclaim,
}: {
  sessionFolders: number
  completion: LegacyImportCompletion
  onReclaim: () => void
}) {
  const [armed, setArmed] = useState(false)

  const when = new Date(completion.completedAt).toLocaleString()

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] text-overlay0">
        Import complete ({when}): {completion.importedSessions.toLocaleString()} session
        {completion.importedSessions === 1 ? '' : 's'} ({completion.importedEvents.toLocaleString()} events)
        are safely in the log store. The {sessionFolders.toLocaleString()} original folder
        {sessionFolders === 1 ? '' : 's'} remain on disk and can now be removed to reclaim the space.
      </span>
      {!armed ? (
        <div>
          <button
            onClick={() => setArmed(true)}
            className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
            style={{ background: 'var(--surface-overlay, var(--color-surface1))', color: 'var(--text-primary, #fff)' }}
          >
            Reclaim disk space...
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-[11px]" style={{ color: 'var(--status-warning, #F9E2AF)' }}>
            This permanently deletes the original log folders. Your imported logs stay.
          </span>
          <button
            onClick={onReclaim}
            className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
            style={{ background: 'var(--status-danger, #F38BA8)', color: 'var(--color-crust, #11111B)' }}
          >
            Permanently delete original files
          </button>
          <button
            onClick={() => setArmed(false)}
            className="px-2.5 py-1.5 rounded-lg text-sm text-subtext0 transition-colors hover:text-text"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
