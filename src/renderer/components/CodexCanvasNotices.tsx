import React, { useEffect, useState } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { DismissButton } from './ui/DismissButton'
import type { CanvasMarkerUndelivered, CanvasSessionGuidance, SubmitNotDeliveredReason } from '../../shared/types'

/**
 * The Agent Canvas page's one-line notices for a Codex session (WP2 PR 4,
 * P4.1, row 51). Nothing for any other session.
 *
 *  - The tools without their skills' guidance: the launch could not carry it
 *    (section 10 question 5, built as its default A), and why, from main's
 *    own launch record (`canvas:sessionGuidance`).
 *  - The live loop without turn events: until Codex's hooks are trusted for
 *    the account no turn event arrives, so a review filed mid-turn reaches
 *    Codex once its prompt reads ready on screen, not at the turn's end. Read
 *    from the hook stream (no event seen for this session), never from
 *    Codex's own trust record.
 *  - A filed review or verdict Codex did not get (the submit primitive's
 *    "not delivered"), with the line it was and why, until dismissed.
 */

const GUIDANCE_WORDS: Record<Extract<CanvasSessionGuidance, { guidance: 'tools-only' }>['reason'], string> = {
  'npm-route': 'Codex was started through its npm command, which cannot take that guidance',
  'user-instructions': 'your Codex settings already set developer instructions, which the app never replaces',
  'unknown-settings': 'the app could not confirm where this Codex version reads its settings, so it passed nothing',
  'skills-not-staged': 'the skills could not be put in place for this Codex account',
}

const UNDELIVERED_WORDS: Record<SubmitNotDeliveredReason, string> = {
  'busy-timeout': 'Codex stayed busy, or its prompt was not ready, for two minutes',
  'prompt-on-screen': 'Codex was showing a question or a prompt',
  'too-tall': 'the line is taller than the Codex prompt at this pane size',
  'not-drawn': 'Codex did not show the line once it was typed, so it was taken back',
  'refused-text': 'the line holds characters the Codex prompt cannot take',
  'session-gone': 'the session ended or restarted first',
}

/** At most this many undelivered lines are kept on the page. */
const MAX_UNDELIVERED = 5
/** How often, and how many times, a missing launch record is asked again
 *  (the page can mount before the session's launch has finished). */
const GUIDANCE_RETRY_MS = 5_000
const GUIDANCE_RETRIES = 12

const strip: React.CSSProperties = {
  background: 'var(--surface-stage)',
  borderBottom: '1px solid var(--border-subtle)',
  color: 'var(--text-secondary)',
}

export default function CodexCanvasNotices({ sessionId }: { sessionId: string }) {
  const isCodex = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.provider === 'codex')
  const runKey = useSessionStore((s) => {
    const x = s.sessions.find((y) => y.id === sessionId)
    return x ? `${x.createdAt}|${x.ptyExited ? 1 : 0}` : ''
  })
  const [guidance, setGuidance] = useState<CanvasSessionGuidance | null>(null)
  const [turnEvents, setTurnEvents] = useState<boolean | null>(null)
  const [undelivered, setUndelivered] = useState<CanvasMarkerUndelivered[]>([])

  useEffect(() => {
    setGuidance(null)
    if (!isCodex) return
    let live = true
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const ask = (): void => {
      void Promise.resolve(window.electronAPI?.canvas?.sessionGuidance?.({ sessionId }))
        .then((g) => {
          if (!live) return
          if (g) { setGuidance(g); return }
          if (++tries < GUIDANCE_RETRIES) timer = setTimeout(ask, GUIDANCE_RETRY_MS)
        })
        .catch(() => { /* no record: no line */ })
    }
    ask()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, isCodex, runKey])

  useEffect(() => {
    setTurnEvents(null)
    if (!isCodex) return
    let live = true
    const hooks = window.electronAPI?.hooks
    void Promise.resolve(hooks?.getBuffer?.(sessionId))
      .then((events) => { if (live) setTurnEvents((seen) => seen === true || (Array.isArray(events) && events.length > 0)) })
      .catch(() => { if (live) setTurnEvents((seen) => seen === true) })
    const off = hooks?.onEvent?.((e) => { if (e?.sessionId === sessionId) setTurnEvents(true) })
    return () => {
      live = false
      try { off?.() } catch { /* already gone */ }
    }
  }, [sessionId, isCodex, runKey])

  useEffect(() => {
    if (!isCodex) return
    const off = window.electronAPI?.canvas?.onAgentMarkerUndelivered?.((u) => {
      if (!u || u.sessionId !== sessionId) return
      setUndelivered((list) => [...list.filter((x) => x.line !== u.line), u].slice(-MAX_UNDELIVERED))
    })
    return () => { try { off?.() } catch { /* already gone */ } }
  }, [sessionId, isCodex])

  if (!isCodex) return null
  const toolsOnly = guidance && guidance.guidance === 'tools-only' ? guidance : null
  const noTurnEvents = turnEvents === false
  if (!toolsOnly && !noTurnEvents && undelivered.length === 0) return null

  return (
    <div className="flex-none flex flex-col" data-testid="codex-canvas-notices">
      {toolsOnly && (
        <div data-testid="codex-canvas-guidance" className="px-3.5 py-1.5 text-[12px]" style={strip}>
          {`This Codex session has the canvas tools without their skills' guidance: ${GUIDANCE_WORDS[toolsOnly.reason] ?? 'the launch could not carry it'}.`}
        </div>
      )}
      {noTurnEvents && (
        <div data-testid="codex-canvas-no-turn-events" className="px-3.5 py-1.5 text-[12px]" style={strip}>
          Codex has sent this session no turn events yet (its hooks are not trusted for this account), so a review you file reaches it once its prompt is ready on screen.
        </div>
      )}
      {undelivered.map((u) => (
        <div key={u.line} data-testid="codex-canvas-undelivered" className="flex items-center gap-2 px-3.5 py-1.5 text-[12px]" style={strip}>
          <span className="min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>
            {`Codex did not get "${u.line}": ${UNDELIVERED_WORDS[u.reason] ?? 'it was not sent'}. You can type it into the session yourself.`}
          </span>
          <DismissButton
            className="ml-auto"
            onClick={() => setUndelivered((list) => list.filter((x) => x !== u))}
            label="Dismiss"
            data-testid="codex-canvas-undelivered-dismiss"
          />
        </div>
      ))}
    </div>
  )
}
