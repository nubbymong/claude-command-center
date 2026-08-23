import React from 'react'
import { useLogsStore } from '../stores/useLogsStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { LogsEmptyReason } from '../lib/session-capabilities'

interface Props {
  sessionId: string
  /**
   * The structural reason this session can never have a transcript (from
   * sessionCapabilities). The button stays on the row but DIMMED with the
   * reason in its tooltip -- the pane already explains, and a Core tool that
   * vanished per session type would change the bar's shape with no
   * explanation (ADR-018 D3). Absent = live.
   */
  structuralReason?: LogsEmptyReason | null
  /** The SSH host, so the reason names the machine (ADR-018 D3: "lives on <host>"). */
  remoteHost?: string
}

const reasonCopy = (reason: LogsEmptyReason, remoteHost?: string): string => {
  switch (reason) {
    case 'shell-only': return 'a shell has no transcript'
    case 'ssh': return `the transcript lives on ${remoteHost || 'the remote host'}`
    case 'codex': return "Codex transcripts aren't indexed"
  }
}

/**
 * CommandBar toggle for the per-session Logs pane (sibling of Canvas/Browser).
 * Hidden entirely when session logging is disabled (precedent: the tab is
 * hidden, only the global nav entry stays greyed-but-visible) -- the privacy
 * setting wins over any hide/dim state.
 */
export default function LogsButton({ sessionId, structuralReason = null, remoteHost }: Props) {
  const loggingEnabled = useSettingsStore((s) => s.settings.loggingEnabled)
  const isOpen = useLogsStore((s) => !!s.bySessionId[sessionId]?.isOpen)
  const togglePane = useLogsStore((s) => s.togglePane)

  if (loggingEnabled === false) return null
  const dim = !!structuralReason && !isOpen

  return (
    <button
      onClick={() => togglePane(sessionId)}
      className={`flex items-center gap-1.5 px-2 py-0.5 text-xs rounded border whitespace-nowrap shrink-0 transition-colors ${
        isOpen
          ? 'bg-surface1 border-surface1 text-text'
          : 'bg-surface0/60 border-surface1/80 hover:bg-surface1 text-overlay1 hover:text-text'
      }`}
      style={dim ? { opacity: 0.5 } : undefined}
      title={isOpen ? 'Hide session logs' : dim ? `Logs — nothing to show here: ${reasonCopy(structuralReason!, remoteHost)}` : 'Open session logs'}
      data-testid="logs-toggle"
      data-dimmed={dim ? 'true' : undefined}
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
