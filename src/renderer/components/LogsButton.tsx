import React from 'react'
import { useLogsStore } from '../stores/useLogsStore'
import { useSettingsStore } from '../stores/settingsStore'

interface Props {
  sessionId: string
}

/**
 * CommandBar toggle for the per-session Logs pane (sibling of Draw/Web).
 * Hidden entirely when session logging is disabled (precedent: the tab is
 * hidden, only the global nav entry stays greyed-but-visible).
 */
export default function LogsButton({ sessionId }: Props) {
  const loggingEnabled = useSettingsStore((s) => s.settings.loggingEnabled)
  const isOpen = useLogsStore((s) => !!s.bySessionId[sessionId]?.isOpen)
  const togglePane = useLogsStore((s) => s.togglePane)

  if (loggingEnabled === false) return null

  return (
    <button
      onClick={() => togglePane(sessionId)}
      className={`flex items-center gap-1.5 px-2 py-0.5 text-xs rounded border whitespace-nowrap shrink-0 transition-colors ${
        isOpen
          ? 'bg-surface1 border-surface1 text-text'
          : 'bg-surface0/60 border-surface1/80 hover:bg-surface1 text-overlay1 hover:text-text'
      }`}
      title={isOpen ? 'Hide session logs' : 'Open session logs'}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="16" y2="17" />
      </svg>
      Logs
    </button>
  )
}
