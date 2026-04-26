import React from 'react'
import { useWebviewStore } from '../stores/webviewStore'

interface Props {
  sessionId: string
}

/**
 * Tool button that surfaces the webview state. Hidden when status='idle'
 * (no webview-enabled command has fired yet for this session).
 *
 * Status communicated as a subtle border tint + small dot rather than
 * an expanding ring overlay (the ring read as visually aggressive and
 * fought with the rest of the magic-row chips for attention):
 *   pending   — neutral border, faint dot
 *   available — GREEN border + dot, gentle opacity pulse on the dot
 *   failed    — RED border + dot
 *
 * Click toggles the webview pane.
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

  // Cattppuccin-leaning accent palette — green for ready, red for
  // unreachable. Border colour does the heavy lifting; the dot is a
  // small punctuation that animates only for the success case (so a
  // failure isn't constantly nagging once acknowledged).
  let borderClass = 'border-surface1/80'
  let dotClass = 'bg-overlay1'
  let dotPulseClass = ''
  if (isAvailable) {
    borderClass = 'border-green/60'
    dotClass = 'bg-green'
    dotPulseClass = 'animate-pulse'
  } else if (isFailed) {
    borderClass = 'border-red/60'
    dotClass = 'bg-red'
  } else if (isPending) {
    borderClass = 'border-blue/40'
    dotClass = 'bg-blue/70'
    dotPulseClass = 'animate-pulse'
  }

  const titleParts = [
    isOpen ? 'Hide webview pane' : 'Show webview pane',
    state.currentUrl ? `\nURL: ${state.currentUrl}` : '',
    isPending ? '\nPolling for content…' : '',
    isFailed ? '\nURL did not respond within 30 s' : '',
  ]

  return (
    <button
      onClick={() => togglePane(sessionId)}
      className={`flex items-center gap-1.5 px-2 py-0.5 text-xs rounded border transition-colors whitespace-nowrap shrink-0 ${
        isOpen
          ? `bg-surface1 ${borderClass} text-text`
          : `bg-surface0/60 ${borderClass} hover:bg-surface1 text-overlay1 hover:text-text`
      }`}
      title={titleParts.join('').trim()}
    >
      <svg
        width="12" height="12" viewBox="0 0 16 16"
        fill="none" stroke="currentColor" strokeWidth="1.4"
        strokeLinecap="round" strokeLinejoin="round"
      >
        {/* Browser-window glyph: rounded rect + dot row + content area */}
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
        <line x1="1.5" y1="6" x2="14.5" y2="6" />
        <circle cx="3.5" cy="4.25" r="0.5" fill="currentColor" />
        <circle cx="5.5" cy="4.25" r="0.5" fill="currentColor" />
      </svg>
      <span>Web</span>
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dotClass} ${dotPulseClass}`}
        aria-hidden
      />
    </button>
  )
}
