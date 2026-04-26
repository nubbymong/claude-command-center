import React from 'react'
import { useWebviewStore } from '../stores/webviewStore'

interface Props {
  sessionId: string
}

/**
 * Tool button that surfaces the webview state. Hidden when status='idle'
 * (no webview-enabled command has fired yet for this session). The pulse
 * colour communicates state without needing the user to click:
 *   pending   — neutral grey pulse, "polling for content"
 *   available — GREEN pulse, "ready to view"
 *   failed    — RED pulse, "URL gave us nothing"
 *
 * Click toggles the webview pane (handled at the App layout level —
 * we just flip the `isOpen` flag). Clicking when status='available'
 * also dims the pulse (stops bothering the user about new content
 * once they've acknowledged it).
 */
export default function WebviewButton({ sessionId }: Props) {
  const state = useWebviewStore((s) => s.bySessionId[sessionId])
  const togglePane = useWebviewStore((s) => s.togglePane)

  if (!state || state.status === 'idle') return null

  const isOpen = state.isOpen
  const status = state.status
  const isPending = status === 'pending'
  const isAvailable = status === 'available'
  const isFailed = status === 'failed'

  // Pulse colour scheme — keep neutrals matching Snap so the row reads
  // as a coherent set of monochrome chips, only highlighting on state.
  const pulseColor =
    isAvailable ? 'rgba(166, 227, 161, 0.55)' : // green
    isFailed ? 'rgba(243, 139, 168, 0.55)' :    // red
    'rgba(180, 190, 254, 0.35)'                  // neutral

  const titleParts = [
    isOpen ? 'Hide webview pane' : 'Show webview pane',
    state.currentUrl ? `\nURL: ${state.currentUrl}` : '',
    isPending ? '\nPolling for content…' : '',
    isFailed ? '\nURL did not respond within 30 s' : '',
  ]

  return (
    <button
      onClick={() => togglePane(sessionId)}
      className={`relative flex items-center gap-1.5 px-2 py-0.5 text-xs rounded border transition-colors whitespace-nowrap shrink-0 ${
        isOpen
          ? 'bg-surface1 border-surface1 text-text'
          : 'bg-surface0/60 border-surface1/80 hover:bg-surface1 text-overlay1 hover:text-text'
      }`}
      title={titleParts.join('').trim()}
    >
      {/* Pulse ring — absolutely positioned so it doesn't move the chip
          contents. animate-ping is Tailwind's built-in 1s pulse. */}
      {!isOpen && (isPending || isAvailable || isFailed) && (
        <span
          className="absolute inset-0 rounded animate-ping"
          style={{ backgroundColor: pulseColor }}
          aria-hidden
        />
      )}
      <svg
        width="12" height="12" viewBox="0 0 16 16"
        fill="none" stroke="currentColor" strokeWidth="1.4"
        strokeLinecap="round" strokeLinejoin="round"
        className="relative z-10"
      >
        {/* Browser-window glyph: rounded rect + dot row + content area */}
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
        <line x1="1.5" y1="6" x2="14.5" y2="6" />
        <circle cx="3.5" cy="4.25" r="0.5" fill="currentColor" />
        <circle cx="5.5" cy="4.25" r="0.5" fill="currentColor" />
      </svg>
      <span className="relative z-10">Web</span>
    </button>
  )
}
