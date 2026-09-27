import React, { useEffect, useState } from 'react'
import { DialogButton } from './ui/Dialog'
import { launchBlockedTabText, launchBlockedTag, useLaunchGateSettings, type LaunchGateConfig } from '../hooks/useLaunchConfig'

/** Who keeps the conversations of these sessions resumable, by provider (a
 *  session with none is Claude; a terminal-only one has no conversation). */
function resumeKeepsNote(sessions: ReadonlyArray<{ provider?: string; shellOnly?: boolean }>): string {
  const withAgent = sessions.filter((s) => !s.shellOnly)
  const claude = withAgent.some((s) => (s.provider ?? 'claude') === 'claude')
  const codex = withAgent.some((s) => s.provider === 'codex')
  const keeps = claude && codex
    ? 'your Claude and Codex conversations stay resumable from inside Claude and Codex'
    : codex ? 'your Codex conversations stay resumable from inside Codex'
      : claude ? 'your Claude conversations stay resumable from inside Claude' : null
  return `Saved from your last run. "Don't open" discards these cards${keeps ? `; ${keeps}` : ''}.`
}

/**
 * Startup gate for restoring saved sessions: previously every boot force-resumed
 * the whole saved set; this card lets the user decline ("Don't open").
 *
 * Props-driven — App owns the pending saved state and decides what each choice
 * does (Resume applies the restore; Don't open discards the saved cards; the
 * underlying conversations remain resumable from inside their own CLI, which
 * the note names by provider: resumeKeepsNote). Every saved session is
 * restored; one whose provider cannot launch now (the launch rule) wears the
 * launch surfaces' own tag (launchBlockedTag), titled with what its tab will
 * read, since it reopens as Not started.
 * Mouse-driven; it does not autofocus or trap keys (so it never interrupts
 * typing in a terminal).
 *
 * The list is a snapshot of the saved set loaded at boot, so a session restarted
 * after launch would otherwise be missing — `onRefresh` re-reads the saved set in
 * place so the newest sessions appear without relaunching (#130).
 */
export default function ResumeSessionsPrompt({
  sessions,
  onResume,
  onDontOpen,
  onRefresh,
}: {
  /** The saved sessions that would reopen. Rendered by work name so the user
   *  can see which named windows are coming back before choosing. */
  sessions: Array<{ id: string; label: string; customName?: string; provider?: string; shellOnly?: boolean }>
  onResume: () => void
  onDontOpen: () => void
  /** Re-pull the saved set (App re-calls session.load and updates the list). */
  onRefresh?: () => Promise<void> | void
}) {
  const [entering, setEntering] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const count = sessions.length
  const launchGate = useLaunchGateSettings()

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntering(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  const cardClass = [
    'fixed bottom-4 right-4 z-40 w-96 max-w-[calc(100vw-2rem)] rounded-xl shadow-2xl p-4',
    'transition-all duration-200 ease-out',
    entering ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2',
  ].join(' ')

  return (
    <div
      className={cardClass}
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
      role="dialog"
      aria-labelledby="resume-sessions-heading"
      tabIndex={-1}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <h2 id="resume-sessions-heading" className="min-w-0 flex-1 truncate text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Resume previous sessions?
        </h2>
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums"
          style={{ background: 'var(--surface-overlay)', color: 'var(--text-secondary)' }}
        >
          {count.toLocaleString()}
        </span>
        {onRefresh && (
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh — pick up sessions restarted since launch"
            aria-label="Refresh sessions"
            className="shrink-0 rounded-md p-1 transition-colors hover:text-[var(--text-primary)] disabled:opacity-60"
            style={{ color: 'var(--text-secondary)' }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={refreshing ? 'animate-spin' : ''}
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        )}
      </div>

      <p className="mb-2 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }} data-testid="resume-sessions-note">
        {resumeKeepsNote(sessions)}
      </p>

      {/* Named list so the user recognizes which windows will reopen. */}
      <ul
        className="mb-3 max-h-44 overflow-y-auto rounded-lg"
        style={{ background: 'var(--surface-overlay)' }}
      >
        {sessions.map((s) => {
          const name = s.customName?.trim() || s.label
          const sub = s.customName?.trim() ? s.label : ''
          const gate: LaunchGateConfig = { provider: (s.provider ?? 'claude') as LaunchGateConfig['provider'], shellOnly: s.shellOnly }
          const notStarted = launchBlockedTabText(gate, launchGate)
          return (
            <li
              key={s.id}
              className="px-2.5 py-1.5 transition-colors hover:bg-[var(--surface-raised)]"
              title={sub ? `${name} (${sub})` : name}
            >
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--text-primary)' }}>
                  {name}
                </div>
                {notStarted !== undefined && (
                  <span
                    className="text-[9px] text-[var(--text-muted)] border border-[var(--border-strong)] rounded-full px-1.5 py-px shrink-0"
                    title={notStarted}
                    data-testid="resume-session-launch-blocked"
                  >
                    {launchBlockedTag(gate, launchGate)}
                  </span>
                )}
              </div>
              {sub && (
                <div className="truncate text-[11px] leading-tight" style={{ color: 'var(--text-secondary)' }}>
                  {sub}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <div className="flex items-center justify-end gap-2">
        <DialogButton size="md" onClick={onDontOpen}>
          Don&apos;t open
        </DialogButton>
        <DialogButton size="md" variant="primary" onClick={onResume}>
          Resume
        </DialogButton>
      </div>
    </div>
  )
}
