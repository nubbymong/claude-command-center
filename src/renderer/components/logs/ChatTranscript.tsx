// src/renderer/components/logs/ChatTranscript.tsx
//
// Layout C: full-width chat transcript. The HOOK (`useWindowedTurns`) owns the
// data window (≤3 pages mounted, GB-safe); this component owns the scroll DOM:
//   - bottom-anchored initial render (opens at the tail),
//   - a top sentinel that loads the next OLDER page when scrolled near the top,
//   - scroll-position detection that toggles live-follow (at bottom = follow),
//   - scroll-position PRESERVATION when an older page prepends (no viewport jump),
//   - live auto-stick to the bottom while following.
//
// Rendering reuses the T12 components (MarkdownMessage / ToolCallRow); dividers
// and unknown rows are rendered inline here per the spec.
import { useEffect, useLayoutEffect, useRef } from 'react'
import MarkdownMessage from './MarkdownMessage'
import ToolCallRow from './ToolCallRow'
import {
  useWindowedTurns,
  type Logs2Scope,
  type Logs2Message,
  type WindowedTurns,
} from '../../hooks/useWindowedTurns'

// esbuild rejects `\u{...}` escapes in JSX (CLAUDE.md) — build the glyphs here.
const YOU_GLYPH = String.fromCodePoint(0x276f) // ❯ HEAVY RIGHT-POINTING ANGLE
const CLAUDE_GLYPH = String.fromCodePoint(0x2733) // ✳ EIGHT SPOKED ASTERISK

/** Within this many px of the bottom counts as "at the bottom" (follow on). */
const BOTTOM_THRESHOLD = 64
/** Within this many px of the top fires the older-page sentinel. */
const TOP_THRESHOLD = 96

export interface ChatTranscriptProps {
  scope: Logs2Scope
  /**
   * Optional external windowing instance (e.g. shared with a TimelineRail so the
   * rail's jumpTo drives this transcript). When omitted, the component owns one.
   */
  win?: WindowedTurns
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

export function ChatTranscript({ scope, win, className }: ChatTranscriptProps) {
  // Use the externally-supplied windowing instance if given, else own one.
  // (Hooks must run unconditionally — call ours always, prefer the prop.)
  const owned = useWindowedTurns(scope)
  const w = win ?? owned

  const { messages, follow, loading, loadingOlder, error, setFollow, loadOlder, prependToken } = w

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  // Snapshot of scrollHeight taken just before an older page prepends, used to
  // restore the viewport position after the prepended content lays out.
  const prependAnchor = useRef<{ token: number; prevHeight: number } | null>(null)
  // True until the first bottom-anchor has been applied for the current window.
  const didInitialAnchor = useRef(false)

  // Reset the initial-anchor latch when the scope changes (the window reloads).
  const scopeId = 'configId' in scope ? scope.configId : scope.sessionId
  useEffect(() => {
    didInitialAnchor.current = false
  }, [scopeId])

  // Bottom-anchor on initial load; auto-stick to the bottom while following.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (loading) return
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
    if (el.scrollTop <= TOP_THRESHOLD && !loadingOlder) {
      // Snapshot the height so the prepend layout-effect can preserve position.
      prependAnchor.current = { token: prependToken + 1, prevHeight: el.scrollHeight }
      void loadOlder()
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
        {messages.map((m) => (
          <TranscriptRow key={`${m.runId}:${m.idx}`} m={m} />
        ))}
      </div>
    </div>
  )
}

export default ChatTranscript
