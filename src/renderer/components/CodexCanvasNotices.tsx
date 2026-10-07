import React, { useEffect, useMemo, useState } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useCodexMarkerNoticeStore, setupCodexMarkerNoticeListener } from '../stores/codexMarkerNoticeStore'
import { DismissButton } from './ui/DismissButton'
import type { CanvasSessionGuidance, SubmitNotDeliveredReason } from '../../shared/types'

/**
 * The Agent Canvas page's one-line notices for a Codex session (WP2 PR 4,
 * P4.1, row 51). Nothing for any other session.
 *
 *  - A canvas skill that could not be put in the account's own skills folder
 *    (section 10 question 5, answered C), which and why, from main's own
 *    launch record (`canvas:sessionGuidance`). The skills there reach every
 *    session of that account however it is started, so nothing is said while
 *    all of them are in place.
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

type MissingSkills = Extract<CanvasSessionGuidance, { guidance: 'tools-only' }>

/** A skill's name as main sends it (the app's own skills): shown only when it
 *  is a plain name, at most three of them. */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** "a", "a and b", "a, b and c". */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The one line for skills that are not in place: which, and why. `own-skill`
 *  covers a folder without the app's mark and a link the user put at the
 *  skill's name (main's codexGuidanceFromStaging); a copy of the app's that
 *  could not be rebuilt is never said to be the user's. */
function missingSkillsLine(g: MissingSkills): string {
  const names = (Array.isArray(g.skills) ? g.skills : []).filter((n) => typeof n === 'string' && SKILL_NAME_RE.test(n)).slice(0, 3)
  const one = names.length === 1
  const which = names.length > 0 ? `the app's ${listed(names)} skill${one ? '' : 's'}` : 'the app\'s canvas skills'
  const why = g.reason === 'own-skill'
    ? (one ? 'a skill or link of that name in this account\'s Codex skills folder is not the app\'s, and the app never replaces it' : 'skills or links of those names in this account\'s Codex skills folder are not the app\'s, and the app never replaces them')
    : `the app could not put ${one ? 'it' : 'them'} in this account's Codex skills folder`
  return `This Codex session has the canvas tools without ${which}: ${why}.`
}

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
  const missing = guidance && guidance.guidance === 'tools-only' ? guidance : null
  const noTurnEvents = turnEvents === false
  if (!missing && !noTurnEvents && undelivered.length === 0) return null

  return (
    <div className="flex-none flex flex-col" data-testid="codex-canvas-notices">
      {missing && (
        <div data-testid="codex-canvas-guidance" className="px-3.5 py-1.5 text-[12px]" style={strip}>
          {missingSkillsLine(missing)}
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
