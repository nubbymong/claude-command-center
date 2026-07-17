import React, { useEffect, useState } from 'react'

/**
 * Startup gate for restoring saved sessions: previously every boot force-resumed
 * the whole saved set; this card lets the user decline ("Don't open").
 *
 * Props-driven — App owns the pending saved state and decides what each choice
 * does (Resume applies the restore; Don't open discards the saved cards; the
 * underlying Claude conversations remain resumable from inside Claude itself).
 * Mouse-driven; it does not autofocus or trap keys (so it never interrupts
 * typing in a terminal).
 */
export default function ResumeSessionsPrompt({
  sessions,
  onResume,
  onDontOpen,
}: {
  /** The saved sessions that would reopen. Rendered by work name so the user
   *  can see which named windows are coming back before choosing. */
  sessions: Array<{ id: string; label: string; customName?: string }>
  onResume: () => void
  onDontOpen: () => void
}) {
  const [entering, setEntering] = useState(false)
  const count = sessions.length

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntering(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const cardClass = [
    'fixed bottom-4 right-4 z-40 w-80 rounded-xl shadow-2xl p-4',
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
      <h2 id="resume-sessions-heading" className="text-sm font-semibold text-text mb-1">
        Resume previous sessions?
      </h2>
      <p className="text-xs leading-relaxed mb-2" style={{ color: 'var(--text-secondary)' }}>
        {count.toLocaleString()} saved session{count === 1 ? '' : 's'} from your last run
        {count === 1 ? ' is' : ' are'} ready to reopen. Choosing &quot;Don&apos;t open&quot; discards
        the saved cards; your Claude conversations stay resumable from inside Claude.
      </p>
      {/* Named list so the user recognizes which windows will reopen. */}
      <ul className="mb-3 max-h-40 overflow-y-auto rounded-lg" style={{ background: 'var(--surface-overlay, var(--color-surface1))' }}>
        {sessions.map((s) => (
          <li
            key={s.id}
            className="truncate px-2.5 py-1 text-xs"
            style={{ color: 'var(--text-primary)' }}
            title={s.customName?.trim() ? `${s.customName.trim()} (${s.label})` : s.label}
          >
            {s.customName?.trim() || s.label}
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onDontOpen}
          className="px-3 py-1.5 rounded-lg text-sm text-subtext0 transition-colors hover:text-text"
          style={{ background: 'var(--surface-overlay, var(--color-surface1))' }}
        >
          Don&apos;t open
        </button>
        <button
          onClick={onResume}
          className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
          style={{ background: 'var(--color-blue)', color: 'var(--color-crust)' }}
        >
          Resume
        </button>
      </div>
    </div>
  )
}
