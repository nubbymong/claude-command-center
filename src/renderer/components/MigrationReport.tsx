import React, { useState } from 'react'
import type { MigrationReportData } from '../stores/migrationStore'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  return `${v.toFixed(1)} ${units[i]}`
}

interface Props {
  report: MigrationReportData
  reclaiming: boolean
  onReclaim: () => void
  onDismiss: () => void
}

/**
 * Reconciliation report for a completed migration. Shows what was imported, what
 * was skipped, and every unparseable file (never hidden). The "Reclaim space"
 * action is a two-step PERMANENT confirm: the first click reveals an explicit
 * cannot-be-undone warning; only the second click invokes onReclaim.
 */
export function MigrationReport({ report, reclaiming, onReclaim, onDismiss }: Props) {
  const [confirming, setConfirming] = useState(false)
  // A failed import means that session's data did NOT reach the DB; reclaim is
  // blocked server-side (no completion marker is written), so we must not offer the
  // permanent-delete action here. Re-running the migration is the path forward.
  const hasFailures = report.failedSessions > 0

  const row = (label: string, value: string) => (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-subtext0">{label}</span>
      <span className="text-text tabular-nums">{value}</span>
    </div>
  )

  return (
    <div
      className="rounded-xl p-4 transition-all duration-200"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <h3 className="text-sm font-semibold text-text mb-2">
        {hasFailures ? 'Migration finished with errors' : 'Migration complete'}
      </h3>

      {row('Sessions imported', `${report.importedSessions.toLocaleString()} of ${report.totalSessions.toLocaleString()}`)}
      {row('Events imported', report.importedEvents.toLocaleString())}
      {row('Sessions skipped (already present)', report.skippedSessions.toLocaleString())}
      {hasFailures && (
        <div className="flex items-center justify-between py-1 text-sm">
          <span style={{ color: 'var(--color-red, #f38ba8)' }}>Sessions failed to import</span>
          <span className="tabular-nums" style={{ color: 'var(--color-red, #f38ba8)' }}>
            {report.failedSessions.toLocaleString()}
          </span>
        </div>
      )}
      {row('Database size', `${fmtBytes(report.dbBytesBefore)} -> ${fmtBytes(report.dbBytesAfter)}`)}

      <div
        className="mt-3 rounded-lg p-2 text-[11px] leading-relaxed text-subtext0"
        style={{ background: 'var(--color-mantle, rgba(0,0,0,0.25))' }}
      >
        Detected {report.detectedFolders.toLocaleString()} session folder(s):{' '}
        {report.importedSessions.toLocaleString()} imported,{' '}
        {report.skippedSessions.toLocaleString()} already in the database,{' '}
        {hasFailures ? `${report.failedSessions.toLocaleString()} failed to import, ` : ''}
        {report.foldedPartnerDirs.toLocaleString()} partner terminal(s) merged into their base session,{' '}
        {report.noEventDirs.toLocaleString()} with no readable events.
      </div>

      {report.unparseable.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium text-subtext0 mb-1">
            Files that could not be fully read ({report.unparseable.length})
          </div>
          <ul
            className="max-h-40 overflow-auto rounded-lg p-2 text-[11px] space-y-1"
            style={{ background: 'var(--color-mantle, rgba(0,0,0,0.25))' }}
          >
            {report.unparseable.map((u) => (
              <li key={u.path} className="text-overlay1 break-all">
                <span className="text-subtext0">{u.path}</span> {String.fromCodePoint(0x2014)} {u.reason}
                {u.skippedLines > 0 ? ` (${u.skippedLines} line(s))` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasFailures ? (
        <>
          <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--color-red, #f38ba8)' }}>
            {report.failedSessions.toLocaleString()} session(s) could not be imported, so the original log
            files were kept and cannot be reclaimed yet. Re-run the migration to finish importing them;
            once it completes with no failures you can reclaim the space.
          </p>
          <div className="mt-3 flex items-center justify-end">
            <button
              onClick={onDismiss}
              className="px-3 py-1.5 rounded-lg text-sm text-subtext0 transition-colors hover:text-text"
              style={{ background: 'var(--surface-overlay, var(--color-surface1))' }}
            >
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="mt-4 flex items-center justify-end gap-2">
            {!confirming ? (
              <>
                <button
                  onClick={onDismiss}
                  className="px-3 py-1.5 rounded-lg text-sm text-subtext0 transition-colors hover:text-text"
                  style={{ background: 'var(--surface-overlay, var(--color-surface1))' }}
                >
                  Close
                </button>
                <button
                  onClick={() => setConfirming(true)}
                  className="px-3 py-1.5 rounded-lg text-sm transition-colors"
                  style={{ background: 'var(--surface-overlay, var(--color-surface1))', color: 'var(--text-secondary)' }}
                >
                  Reclaim space
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setConfirming(false)}
                  className="px-3 py-1.5 rounded-lg text-sm text-subtext0 transition-colors hover:text-text"
                  style={{ background: 'var(--surface-overlay, var(--color-surface1))' }}
                >
                  Cancel
                </button>
                <button
                  onClick={onReclaim}
                  disabled={reclaiming}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
                  style={{ background: 'var(--color-red, #f38ba8)', color: 'var(--color-crust)' }}
                >
                  {reclaiming ? 'Deleting...' : 'Delete old logs permanently'}
                </button>
              </>
            )}
          </div>

          {confirming && (
            <p className="mt-2 text-[11px] text-right" style={{ color: 'var(--color-red, #f38ba8)' }}>
              This permanently deletes the old log files. It cannot be undone.
            </p>
          )}
        </>
      )}
    </div>
  )
}
