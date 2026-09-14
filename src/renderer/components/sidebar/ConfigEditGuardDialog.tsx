import { DialogOverlay, DialogPanel, DialogHeader, DialogFooter, DialogButton, useDialogEscape } from '../ui/Dialog'

/**
 * Config-edit guard (plan P3, the #54 UX half).
 *
 * Editing a saved SSH config while a session it launched is LIVE -- or was LEFT
 * RUNNING for a later reattach -- can change where a later launch connects, and
 * editing the DESTINATION (host, port, user, path, container) can break resuming
 * the one that is running. The guard ADVISES against it; it does not block (the
 * owner's call: "advise against, not block"). It appears when such a config is
 * opened for edit; "Edit anyway" proceeds to the editor, Cancel backs out.
 *
 * Scoped to SSH configs with at least one live or left-running session -- the only
 * case where an edit carries the restart/resume consequence. Everything else opens
 * the editor directly (Sidebar.requestEditConfig).
 */
const WARN = 'var(--status-warning)'

const ALERT_GLYPH = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    <path d="M12 9v4" /><path d="M12 17h.01" />
  </svg>
)

/** "a session" / "N sessions". */
function countPhrase(n: number, noun: string): string {
  return n === 1 ? `a ${noun}` : `${n} ${noun}s`
}

export default function ConfigEditGuardDialog({ label, liveCount, leftRunningCount, onProceed, onCancel }: {
  label: string
  liveCount: number
  leftRunningCount: number
  onProceed: () => void
  onCancel: () => void
}) {
  useDialogEscape(onCancel)

  const parts: string[] = []
  if (liveCount > 0) parts.push(`${countPhrase(liveCount, 'session')} running now`)
  if (leftRunningCount > 0) parts.push(`${countPhrase(leftRunningCount, 'session')} left running`)
  const has = parts.join(' and ')

  return (
    <DialogOverlay testId="config-edit-guard">
      <DialogPanel labelledBy="cfg-guard-title" testId="config-edit-guard-panel" role="alertdialog" width="w-[420px]">
        <DialogHeader
          title={`Edit "${label}" while it is running?`}
          titleId="cfg-guard-title"
          glyph={ALERT_GLYPH}
          glyphAccent={WARN}
          onClose={onCancel}
          closeTestId="cfg-guard-close"
        />
        <div className="px-4 pb-1 pl-[58px] text-[12.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          This config has {has}. Your changes{' '}
          <span style={{ color: WARN }}>apply on the next launch</span>, not to the live session — and if you change{' '}
          <span style={{ color: WARN }}>where it connects</span> (host, port, user, path or container), resuming the running session may break.
          <div
            className="mt-2.5 mb-1 rounded-[9px] px-3 py-2 text-[11.5px]"
            style={{ border: '1px solid var(--border-subtle)', background: 'var(--surface-base)', color: 'var(--text-muted)' }}
            data-testid="cfg-guard-affected"
          >
            {liveCount > 0 && (
              <div className="flex items-center gap-2 py-0.5">
                <span className="w-1.5 h-1.5 rounded-[2px] shrink-0" style={{ background: 'var(--status-success)' }} />
                {countPhrase(liveCount, 'live session')}
              </div>
            )}
            {leftRunningCount > 0 && (
              <div className="flex items-center gap-2 py-0.5">
                <span className="w-1.5 h-1.5 rounded-[2px] shrink-0" style={{ background: 'var(--text-muted)' }} />
                {countPhrase(leftRunningCount, 'session')} left running · resumable
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <DialogButton onClick={onCancel} testId="cfg-guard-cancel">Cancel</DialogButton>
          <DialogButton
            onClick={onProceed}
            testId="cfg-guard-proceed"
            style={{ background: `color-mix(in srgb, ${WARN} 16%, transparent)`, color: WARN, border: `1px solid color-mix(in srgb, ${WARN} 40%, transparent)` }}
          >
            Edit anyway
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
