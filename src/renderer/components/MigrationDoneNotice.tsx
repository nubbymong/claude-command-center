import React, { useEffect, useState } from 'react'
import { useMigrationStore } from '../stores/migrationStore'

/**
 * Corner notice when a log import finishes — the user can leave Settings during
 * the (long) import, so completion must come to THEM. Surfaces exactly once per
 * run (gated on migrationStore.reportAcked): a success summary with a
 * "View report" deep-link, a warning variant when sessions failed (run
 * incomplete -> reclaim stays locked), and an error variant when the run itself
 * died. Reclaim errors are NOT its business (that flow lives in Settings).
 * Mouse-driven; no autofocus, no key traps. Mirrors the prompt house pattern.
 */
export default function MigrationDoneNotice({ onViewReport }: { onViewReport: () => void }) {
  const phase = useMigrationStore((s) => s.phase)
  const report = useMigrationStore((s) => s.report)
  const errorKind = useMigrationStore((s) => s.errorKind)
  const errorMessage = useMigrationStore((s) => s.errorMessage)
  const reportAcked = useMigrationStore((s) => s.reportAcked)
  const ackReport = useMigrationStore((s) => s.ackReport)

  const [entering, setEntering] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntering(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const isDone = phase === 'done' && report !== null
  const isRunError = phase === 'error' && errorKind === 'run'
  if (reportAcked || (!isDone && !isRunError)) return null

  const failed = isDone ? report.failedSessions : 0

  const cardClass = [
    'fixed bottom-4 right-4 z-40 w-80 rounded-xl shadow-2xl p-4',
    'transition-all duration-200 ease-out',
    entering ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2',
  ].join(' ')

  return (
    <div
      className={cardClass}
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
      role="status"
      aria-labelledby="migration-done-heading"
      tabIndex={-1}
    >
      <h2 id="migration-done-heading" className="text-sm font-semibold text-text mb-1">
        {isRunError ? 'Log import stopped' : failed > 0 ? 'Log import finished with problems' : 'Log import complete'}
      </h2>
      <p className="text-xs leading-relaxed mb-3" style={{ color: 'var(--text-secondary)' }}>
        {isRunError
          ? `${errorMessage ?? 'The import stopped unexpectedly.'} Re-run it from Settings; it continues from where it left off and nothing is deleted.`
          : failed > 0
            ? `${report!.importedSessions.toLocaleString()} session${report!.importedSessions === 1 ? '' : 's'} imported, but ${failed.toLocaleString()} failed. Re-run from Settings to finish; space reclaim stays locked and nothing is deleted until a clean run.`
            : `${report!.importedSessions.toLocaleString()} session${report!.importedSessions === 1 ? '' : 's'} imported. Review the reconciliation report before reclaiming any space.`}
      </p>
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={ackReport}
          className="px-3 py-1.5 rounded-lg text-sm text-subtext0 transition-colors hover:text-text"
          style={{ background: 'var(--surface-overlay, var(--color-surface1))' }}
        >
          Dismiss
        </button>
        <button
          onClick={() => {
            ackReport()
            onViewReport()
          }}
          className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
          style={{ background: 'var(--color-blue)', color: 'var(--color-crust)' }}
        >
          View report
        </button>
      </div>
    </div>
  )
}
