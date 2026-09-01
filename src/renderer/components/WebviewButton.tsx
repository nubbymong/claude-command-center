import React from 'react'
import { useWebviewStore } from '../stores/webviewStore'
import { trackUsage } from '../stores/tipsStore'
import { ReservedLabel } from './command-bar/chips'

interface Props {
  sessionId: string
  /**
   * Kept for call-site compatibility; no longer gates rendering. The browser
   * is a pane of its own (item 26) and the button is always there, like
   * Canvas. It drives nothing now -- a watch being configured shows through
   * `status`, not through whether the button exists.
   * @deprecated
   */
  hasWebviewCommand?: boolean
}

/**
 * Tool button for the session's browser pane. Sibling of Snap / Canvas /
 * Logs; always rendered.
 *
 * The tint reports a page WATCH when one is live (a command that watches
 * for a page to respond):
 *   idle      — plain; nothing is being watched
 *   pending   — blue border, faint pulsing dot (polling)
 *   available — GREEN border + pulsing dot (the page answered)
 *   failed    — RED border + dot (no answer within 30 s)
 *
 * Click toggles the pane. With nothing loaded yet the pane opens on its start
 * page (address bar, favourites, home) -- clicking is never a dead end.
 */
export default function WebviewButton({ sessionId }: Props) {
  const state = useWebviewStore((s) => s.bySessionId[sessionId])
  const togglePane = useWebviewStore((s) => s.togglePane)
  const navigate = useWebviewStore((s) => s.navigate)
  const consumeAgentPush = useWebviewStore((s) => s.consumeAgentPush)

  const status = state?.status ?? 'idle'
  const isOpen = state?.isOpen ?? false
  const isPending = status === 'pending'
  const isAvailable = status === 'available'
  const isFailed = status === 'failed'
  const watching = isPending || isAvailable || isFailed
  // The agent left a page for the user (open_in_app_browser). A notification
  // pill, separate from the watch dot; consumed when the button is clicked.
  const unread = state?.unread ?? false

  // Catppuccin-leaning accent palette — green for ready, red for
  // unreachable. Border colour does the heavy lifting; the dot is a
  // small punctuation that animates only while something is happening
  // (so a failure isn't constantly nagging once acknowledged).
  let borderClass = 'border-surface1/80'
  let dotClass = 'bg-overlay0/50'
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
    // isOpen decides first: while the pane is open the button CLOSES it, so it
    // must not promise "click to view" — a click here goes back to the
    // terminal and leaves the pushed page waiting. The pending URL still
    // surfaces on the line below so the user knows a page is queued.
    isOpen
      ? 'Back to the terminal (closes the browser pane)'
      : (unread ? 'A page is waiting for you — click to view it' : 'Open the browser pane'),
    // Label the queued page: with the pane open the tooltip otherwise stacks
    // two bare URLs (pending + current) with nothing saying which is which.
    unread && state?.pendingAgentUrl ? `\nWaiting: ${state.pendingAgentUrl}` : '',
    state?.currentUrl ? `\n${state.currentUrl}` : '',
    isPending && state?.watchUrl ? `\nWatching ${state.watchUrl}…` : '',
    isAvailable && state?.watchUrl ? `\n${state.watchUrl} is responding` : '',
    isFailed && state?.watchUrl ? `\n${state.watchUrl} did not respond within 30 s` : '',
  ]

  // Open = accent-tinted and labelled with the DESTINATION, matching the
  // Partner toggle and the Agent Canvas button. The browser REPLACES the
  // terminal, and a button that still read "Browser" left new users with no
  // visible way back.
  const classes = isOpen
    ? 'bg-blue/20 border-blue/70 text-blue hover:bg-blue/30'
    : `bg-surface0/60 ${borderClass} hover:bg-surface1 text-overlay1 hover:text-text`

  return (
    <button
      onClick={() => {
        // Click precedence is deliberate. An unread agent push is answered
        // ONLY from a CLOSED pane: a click on the shut Browser button
        // unambiguously means "show me the page the agent left", so consume
        // the pill, open the pane and point it at that page. This is the
        // user's explicit action, so it is not a "yank" — the page never
        // loaded on its own. Consume clears the pill; navigate opens the pane
        // and points it at the page.
        //
        // When the pane is already OPEN this same button is the CLOSE
        // affordance (it reads "Terminal"), and a click means "put the
        // terminal back" — it must NOT navigate the open pane to the agent's
        // URL. Consuming the pill on a close would overload the affordance
        // into a surprise navigation and break the never-yank promise on the
        // close gesture. So the pill is left raised for the next time the
        // pane is opened; only an open-from-closed answers it.
        if (unread && !isOpen) {
          const url = consumeAgentPush(sessionId)
          if (url) {
            trackUsage('webview.opened')
            navigate(sessionId, url)
            return
          }
        }
        // tips-library gates the freeze/annotate tip on `webview.opened`.
        // Recorded on open only: closing the pane is not discovering it.
        if (!isOpen) trackUsage('webview.opened')
        togglePane(sessionId)
      }}
      className={`relative flex items-center gap-1.5 px-2 h-7 text-xs rounded border transition-colors whitespace-nowrap shrink-0 focus-ring ${classes}`}
      title={titleParts.join('').trim()}
      data-testid="browser-toggle"
      data-watch-status={status}
      data-agent-unread={unread ? '1' : undefined}
    >
      {isOpen ? (
        <svg
          width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M19 12H5M11 18l-6-6 6-6" />
        </svg>
      ) : (
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
      )}
      <ReservedLabel current={isOpen ? 'Terminal' : 'Browser'} />
      {/* The dot only appears while a watch has something to say. A plain
          grey dot on an idle button was a status indicator for no status. */}
      {watching && (
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dotClass} ${dotPulseClass}`}
          aria-hidden
        />
      )}
      {/* Agent-push notification pill (open_in_app_browser): a mauve corner
          badge, deliberately distinct from the green/red/blue WATCH dot, that
          says the agent left a page to look at. Clicking the button consumes
          it. Rendered only while unread, so an idle button stays clean. */}
      {unread && (
        <span
          className="absolute -top-1 -right-1 inline-flex"
          data-testid="browser-agent-pill"
          aria-label="A page is waiting for you in the browser"
        >
          <span className="absolute inline-flex h-2.5 w-2.5 rounded-full bg-mauve/60 animate-ping" aria-hidden />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-mauve ring-2 ring-[var(--surface-chrome)]" aria-hidden />
        </span>
      )}
    </button>
  )
}
