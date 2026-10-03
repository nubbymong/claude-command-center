import React, { useEffect, useMemo, useState } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useCodexMarkerNoticeStore, setupCodexMarkerNoticeListener } from '../stores/codexMarkerNoticeStore'
import { DismissButton } from './ui/DismissButton'
import type { CanvasSessionGuidance, SubmitNotDeliveredReason } from '../../shared/types'

/**
 * The Agent Canvas page's one-line notices for a Codex session (WP2 PR 4,
 * P4.1, row 51). Nothing for any other session.
 *
 *  - The tools without their skills' guidance: the launch could not carry it
 *    (section 10 question 5, built as its default A), and why, from main's
 *    own launch record (`canvas:sessionGuidance`); or, for a launch through
 *    the resume picker, which conversations it reaches.
 *  - The live loop without turn events: until Codex's hooks are trusted for
 *    the account no turn event arrives, so a review filed mid-turn reaches
 *    Codex once its prompt reads ready on screen, not at the turn's end. Read
 *    from the hook stream (no event seen for this session), never from
 *    Codex's own trust record.
 *  - A filed review or verdict Codex did not get (the submit primitive's
 *    "not delivered"), with the line it was and why, shown with the canvas it
 *    was filed on, until dismissed. Kept in codexMarkerNoticeStore for the
 *    renderer's life, so one that fails while this page is closed is shown
 *    when the canvas is open again (review A-1).
 */

const GUIDANCE_WORDS: Record<Extract<CanvasSessionGuidance, { guidance: 'tools-only' }>['reason'], string> = {
  'npm-route': 'Codex was started through its npm command, which cannot take that guidance',
  'user-instructions': 'your Codex settings already set developer instructions, which the app never replaces',
  'unknown-settings': 'the app could not confirm where this Codex version reads its settings, so it passed nothing',
  'skills-not-staged': 'the skills could not be put in place for this Codex account',
}

/** A launch through the resume picker (review RVMFIX-3): the guidance rides
 *  only a new conversation the picker starts in the session's own folder. */
const PICKER_GUIDANCE_LINE = 'This Codex session was started through the resume picker: the canvas tools have their skills\' guidance only in a new conversation started in this session\'s folder (a resumed conversation keeps the instructions it started with).'

const UNDELIVERED_WORDS: Record<SubmitNotDeliveredReason, string> = {
  'busy-timeout': 'Codex stayed busy, or its prompt was not ready, for two minutes',
  'prompt-on-screen': 'Codex was showing a question or a prompt',
  'too-tall': 'the line is taller than the Codex prompt at this pane size',
  // Not confirmed on screen: most often taken back, but with no reading of
  // the screen nothing was taken back, so the line may still be in the prompt.
  'not-drawn': 'the app could not confirm it in Codex\'s prompt. If it is still there, send it or clear it in the session',
  'refused-text': 'the line holds characters the Codex prompt cannot take',
  'session-gone': 'the session ended or restarted first, or the line could not be typed into it',
}

/** What the user can do after the reason: typing the line again, except where
 *  it may still be in the prompt (the reason's own words say what to do). */
const undeliveredTail = (reason: SubmitNotDeliveredReason): string =>
  (reason === 'not-drawn' ? '' : ' You can type it into the session yourself.')

/** How often, and how many times, a missing launch record is asked again
 *  (the page can mount before the session's launch has finished). */
const GUIDANCE_RETRY_MS = 5_000
const GUIDANCE_RETRIES = 12

const strip: React.CSSProperties = {
  background: 'var(--surface-stage)',
  borderBottom: '1px solid var(--border-subtle)',
  color: 'var(--text-secondary)',
}

/** `canvasId`: the canvas the page has open, whose undelivered lines show. */
export default function CodexCanvasNotices({ sessionId, canvasId }: { sessionId: string; canvasId?: string | null }) {
  const isCodex = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.provider === 'codex')
  const runKey = useSessionStore((s) => {
    const x = s.sessions.find((y) => y.id === sessionId)
    return x ? `${x.createdAt}|${x.ptyExited ? 1 : 0}` : ''
  })
  const [guidance, setGuidance] = useState<CanvasSessionGuidance | null>(null)
  const [turnEvents, setTurnEvents] = useState<boolean | null>(null)
  const forCanvas = useCodexMarkerNoticeStore((s) => (canvasId ? s.byCanvasId[canvasId] : undefined))
  const dismissUndelivered = useCodexMarkerNoticeStore((s) => s.dismiss)
  const undelivered = useMemo(() => (forCanvas ?? []).filter((u) => u.sessionId === sessionId), [forCanvas, sessionId])

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

  // Started at app start (App.tsx); asked again here, idempotently, so the
  // page never depends on that order.
  useEffect(() => { setupCodexMarkerNoticeListener() }, [])

  if (!isCodex) return null
  const toolsOnly = guidance && guidance.guidance === 'tools-only' ? guidance : null
  const viaPicker = guidance?.guidance === 'picker'
  const noTurnEvents = turnEvents === false
  if (!toolsOnly && !viaPicker && !noTurnEvents && undelivered.length === 0) return null

  return (
    <div className="flex-none flex flex-col" data-testid="codex-canvas-notices">
      {toolsOnly && (
        <div data-testid="codex-canvas-guidance" className="px-3.5 py-1.5 text-[12px]" style={strip}>
          {`This Codex session has the canvas tools without their skills' guidance: ${GUIDANCE_WORDS[toolsOnly.reason] ?? 'the launch could not carry it'}.`}
        </div>
      )}
      {viaPicker && (
        <div data-testid="codex-canvas-guidance" className="px-3.5 py-1.5 text-[12px]" style={strip}>
          {PICKER_GUIDANCE_LINE}
        </div>
      )}
      {noTurnEvents && (
        <div data-testid="codex-canvas-no-turn-events" className="px-3.5 py-1.5 text-[12px]" style={strip}>
          Codex has sent this session no turn events yet (its hooks are not trusted for this account, or the app's Hooks gateway is off), so a review you file reaches it once its prompt is ready on screen.
        </div>
      )}
      {undelivered.map((u) => (
        <div key={u.line} data-testid="codex-canvas-undelivered" className="flex items-center gap-2 px-3.5 py-1.5 text-[12px]" style={strip}>
          <span className="min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>
            {`Codex did not get "${u.line}": ${UNDELIVERED_WORDS[u.reason] ?? 'it was not sent'}.${undeliveredTail(u.reason)}`}
          </span>
          <DismissButton
            className="ml-auto"
            onClick={() => dismissUndelivered(u)}
            label="Dismiss"
            data-testid="codex-canvas-undelivered-dismiss"
          />
        </div>
      ))}
    </div>
  )
}
