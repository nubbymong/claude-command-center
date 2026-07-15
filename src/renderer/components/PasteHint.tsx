import React from 'react'
import { usePasteHintStore } from '../stores/pasteHintStore'

/**
 * Transient inline hint shown just above the command bar — Alt+V paste feedback
 * (Unit 5 W2). Renders nothing unless there's an active hint for this session.
 */
export default function PasteHint({ sessionId }: { sessionId: string }) {
  const hint = usePasteHintStore((s) => s.hints[sessionId])
  if (!hint) return null
  return (
    <div
      className="px-2 py-1 text-[11px] text-yellow flex items-center gap-1.5 border-t"
      style={{ background: 'var(--surface-chrome)', borderColor: 'var(--border-subtle)' }}
      role="status"
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="shrink-0" aria-hidden>
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 5v3.5M8 11h.01" strokeLinecap="round" />
      </svg>
      <span>{hint}</span>
    </div>
  )
}
