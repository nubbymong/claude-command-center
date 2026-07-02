// src/renderer/components/logs/ChatTranscriptView.tsx
//
// Layout C: PRESENTATIONAL full-width chat transcript. This component owns the
// scroll DOM and rendering; it holds NO `useWindowedTurns` hook of its own —
// the windowing outputs are passed in as props. That lets a caller (the
// container ChatTranscript, or T14/T15) instantiate ONE `useWindowedTurns`
// instance and share it across the rail + transcript without double-mounting
// the hook (which would issue a second `readMessages('tail')` + a second
// `onNewMessages` subscription + a divergent window).
//
// Responsibilities:
//   - bottom-anchored initial render (opens at the tail),
//   - a top sentinel that fires `loadOlder()` when scrolled near the top,
//   - scroll-position detection that toggles live-follow (at bottom = follow),
//   - scroll-position PRESERVATION when an older page prepends (no viewport jump),
//   - live auto-stick to the bottom while following.
//
// Rendering reuses the T12 components (MarkdownMessage / ToolCallRow); dividers
// and unknown rows are rendered inline here per the spec.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import MarkdownMessage from './MarkdownMessage'
import ToolCallRow from './ToolCallRow'
import type { Logs2Message } from '../../hooks/useWindowedTurns'

// esbuild rejects `\u{...}` escapes in JSX (CLAUDE.md) — build the glyphs here.
const YOU_GLYPH = String.fromCodePoint(0x276f) // ❯ HEAVY RIGHT-POINTING ANGLE
const CLAUDE_GLYPH = String.fromCodePoint(0x2733) // ✳ EIGHT SPOKED ASTERISK

/** Within this many px of the bottom counts as "at the bottom" (follow on). */
const BOTTOM_THRESHOLD = 64
/** Within this many px of the top fires the older-page sentinel. */
const TOP_THRESHOLD = 96

/** The windowing outputs the view needs (a subset of WindowedTurns). */
export interface ChatTranscriptViewProps {
  messages: Logs2Message[]
  follow: boolean
  setFollow: (v: boolean) => void
  loading: boolean
  loadingOlder: boolean
  error: Error | null
  loadOlder: () => Promise<void>
  prependToken: number
  /**
   * A search-hit / timeline-rail jump target surfaced by useWindowedTurns. When
   * its `nonce` changes the view scrolls that message into view (centered) and
   * briefly flashes it. Optional/absent for the in-session transcript, which
   * never jumps (it lives at the tail).
   */
  jumpTarget?: { runId: number; idx: number; nonce: number } | null
  className?: string
}

function roleLabel(role: string): { glyph: string; label: string; tone: string } | null {
  if (role === 'user') {
    return { glyph: YOU_GLYPH, label: 'you', tone: 'text-[var(--color-blue)]' }
  }
  if (role === 'assistant') {
    return { glyph: CLAUDE_GLYPH, label: 'claude', tone: 'text-[var(--color-mauve)]' }
  }
  return null
}

/** A labeled divider row for /clear and synthesized relaunch boundaries. */
function DividerRow({ kind, content }: { kind: 'clear' | 'relaunch'; content: string }) {
  const label =
    kind === 'relaunch'
      ? content || 'session relaunched'
      : content || 'new conversation'
  return (
    <div
      data-divider={kind}
      role="separator"
      className="my-3 flex items-center gap-3 px-2 text-[11px] uppercase tracking-wide text-[var(--text-muted)] select-none"
    >
      <span className="h-px flex-1 bg-[var(--surface-overlay)]" />
      <span className="shrink-0 font-medium">{label}</span>
      <span className="h-px flex-1 bg-[var(--surface-overlay)]" />
    </div>
  )
}

/** A muted, collapsed diagnostic row for genuinely unsupported entries. */
function UnknownRow({ content }: { content: string }) {
  return (
    <div
      data-unknown="true"
      className="my-1 rounded px-2 py-1 text-xs italic text-[var(--text-muted)] bg-[var(--surface-sunken)]/40"
      title={content}
    >
      unsupported entry
    </div>
  )
}

function MessageRow({ m }: { m: Logs2Message }) {
  const r = roleLabel(m.role)
  return (
    <div data-role={m.role} className="px-2 py-1.5">
      {r && (
        <div className={`mb-1 flex items-center gap-2 text-xs font-semibold ${r.tone}`}>
          <span aria-hidden="true">{r.glyph}</span>
          <span>{r.label}</span>
        </div>
      )}
      <MarkdownMessage content={m.content} />
    </div>
  )
}

function TranscriptRow({ m }: { m: Logs2Message }) {
  switch (m.kind) {
    case 'message':
      return <MessageRow m={m} />
    case 'tool_call':
      return <ToolCallRow toolName={m.toolName ?? 'tool'} toolMeta={m.toolMeta} kind="tool_call" />
    case 'sidechain':
      return <ToolCallRow toolName={m.toolName ?? 'tool'} toolMeta={m.toolMeta} kind="sidechain" />
    case 'clear':
      return <DividerRow kind="clear" content={m.content} />
    case 'relaunch':
      return <DividerRow kind="relaunch" content={m.content} />
    case 'unknown':
    default:
      return <UnknownRow content={m.content} />
  }
}

export function ChatTranscriptView({
  messages,
  follow,
  setFollow,
  loading,
  loadingOlder,
  error,
  loadOlder,
  prependToken,
  jumpTarget,
  className,
}: ChatTranscriptViewProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  // Snapshot of scrollHeight taken just before an older page prepends, used to
  // restore the viewport position after the prepended content lays out.
  const prependAnchor = useRef<{ token: number; prevHeight: number } | null>(null)
  // Live mirror of prependToken so async callbacks see the current value (the
  // onScroll closure captures a stale prependToken).
  const prependTokenRef = useRef(prependToken)
  prependTokenRef.current = prependToken
  // Synchronous in-flight guard. The `loadingOlder` prop lags React state, so two
  // scroll events near the top can both pass its check before it flips; the 2nd
  // (re-entrant) loadOlder returns an already-resolved promise whose .finally
  // nulls prependAnchor before the 1st real fetch lands → the scroll-position
  // preservation effect skips its correction → viewport jumps. This ref gates the
  // coalesced 2nd event out entirely.
  const inFlightOlderRef = useRef(false)
  // True until the first bottom-anchor has been applied for the current window.
  const didInitialAnchor = useRef(false)

  // ---- Jump-to-result (search hit / timeline-rail click) -------------------
  // The flash currently shown ({ message key, jump nonce }) or null. Cleared on
  // a timer so the highlight fades and the UI never stays stuck on an old hit.
  const [highlight, setHighlight] = useState<{ key: string; nonce: number } | null>(null)
  // Nonce of a jump whose scroll-into-view this view still owes. Set when a new
  // jumpTarget arrives, consumed by the scroll-to-target effect. While it is
  // set, the bottom-anchor effect yields so it can't yank the view to the tail
  // over the jump.
  const pendingJumpRef = useRef<number | null>(null)
  const jumpNonce = jumpTarget?.nonce ?? null

  // Mark a brand-new jump pending. Declared BEFORE the bottom-anchor effect so
  // pendingJumpRef is set first within the commit and the anchor effect yields.
  useLayoutEffect(() => {
    if (jumpNonce !== null) pendingJumpRef.current = jumpNonce
  }, [jumpNonce])

  // Reset the initial-anchor latch when the window reloads (loading flips true).
  // The container reloads the hook on scope change, which sets loading=true; we
  // re-anchor to the bottom on the next non-loading commit.
  useLayoutEffect(() => {
    if (loading) didInitialAnchor.current = false
  }, [loading])

  // Bottom-anchor on initial load; auto-stick to the bottom while following.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (loading) return
    if (pendingJumpRef.current !== null) {
      // A jump is pending: the scroll-to-target effect below owns the scroll for
      // this window. Mark the initial anchor satisfied so we don't slam to the
      // tail once the centered jump window settles.
      didInitialAnchor.current = true
      return
    }
    if (!didInitialAnchor.current && messages.length > 0) {
      // Initial render: jump (no animation) to the bottom.
      el.scrollTop = el.scrollHeight
      didInitialAnchor.current = true
      return
    }
    if (follow) {
      // New tail content while following: keep pinned to the bottom (smooth).
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
    // `messages` drives this: any window change re-evaluates the anchor.
  }, [messages, loading, follow])

  // Jump-to-result: once the centered window has settled, scroll the target
  // message into view and flash it. Declared AFTER the bottom-anchor effect so
  // it wins the scroll position for a jump.
  useLayoutEffect(() => {
    if (loading) return
    const nonce = pendingJumpRef.current
    if (nonce === null) return
    // Consume the latch BEFORE any other guard: even if jumpTarget was wiped by a
    // scope re-init (leaving a stale pending), we must release the bottom-anchor
    // yield so the new window isn't wedged. jumpTo loads a window that BEGINS at
    // the target, so when jumpTarget is present its row should be mounted.
    pendingJumpRef.current = null
    if (!jumpTarget) return
    const el = scrollerRef.current
    if (!el) return
    const key = `${jumpTarget.runId}:${jumpTarget.idx}`
    const node = el.querySelector<HTMLElement>(`[data-msgkey="${key}"]`)
    if (!node) return
    node.scrollIntoView({ block: 'center' })
    setHighlight({ key, nonce })
  }, [jumpNonce, messages, loading]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fade the jump flash after it has played so the highlight doesn't linger.
  useEffect(() => {
    if (!highlight) return
    const t = setTimeout(() => setHighlight(null), 1800)
    return () => clearTimeout(t)
  }, [highlight?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  // Preserve scroll position when an OLDER page prepends: before paint, add the
  // height the new content introduced so the user's viewport doesn't jump.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const anchor = prependAnchor.current
    if (anchor && anchor.token === prependToken) {
      const delta = el.scrollHeight - anchor.prevHeight
      if (delta > 0) el.scrollTop += delta
      prependAnchor.current = null
    }
  }, [prependToken, messages])

  // Scroll handler: toggle follow + fire the top sentinel.
  const onScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distanceFromBottom <= BOTTOM_THRESHOLD
    if (atBottom !== follow) setFollow(atBottom)
    if (el.scrollTop <= TOP_THRESHOLD && !loadingOlder && !inFlightOlderRef.current) {
      inFlightOlderRef.current = true
      // Snapshot the height so the prepend layout-effect can preserve position.
      const expectedToken = prependTokenRef.current + 1
      prependAnchor.current = { token: expectedToken, prevHeight: el.scrollHeight }
      // FIX: when loadOlder resolves WITHOUT prepending (empty page = start
      // reached, prependToken NOT bumped), clear our pending snapshot so a stale
      // height can't be applied on a much-later successful prepend. If the token
      // never reached expectedToken AND our snapshot is still the latest pending
      // one, no older page landed for THIS request — drop the stale latch.
      void loadOlder().finally(() => {
        inFlightOlderRef.current = false
        const pending = prependAnchor.current
        if (pending && pending.token === expectedToken && prependTokenRef.current < expectedToken) {
          prependAnchor.current = null
        }
      })
    }
  }

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      data-testid="chat-transcript"
      className={`relative h-full overflow-y-auto overflow-x-hidden ${className ?? ''}`}
    >
      {/* Top sentinel — also surfaces the older-load spinner. */}
      <div data-sentinel="top" className="h-2 w-full">
        {loadingOlder && (
          <div className="py-1 text-center text-[11px] text-[var(--text-muted)]">loading earlier…</div>
        )}
      </div>

      {loading && messages.length === 0 && (
        <div className="py-6 text-center text-sm text-[var(--text-muted)]">loading…</div>
      )}
      {error && !loading && messages.length === 0 && (
        <div className="py-6 text-center text-sm text-[var(--text-muted)]">
          couldn’t load this transcript
        </div>
      )}

      <div className="flex flex-col gap-0.5 pb-4">
        {messages.map((m) => {
          const k = `${m.runId}:${m.idx}`
          return (
            <div key={k} data-msgkey={k} className={highlight?.key === k ? 'cct-jump-flash' : undefined}>
              <TranscriptRow m={m} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default ChatTranscriptView
