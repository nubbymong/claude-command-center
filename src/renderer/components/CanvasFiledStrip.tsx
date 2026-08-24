import React, { useCallback, useState } from 'react'
import { useCanvasStore } from '../stores/canvasStore'
import { useSessionStore } from '../stores/sessionStore'

/**
 * "That canvas was filed."
 *
 * A canvas holds one subject. When the agent renders a DIFFERENT subject, the
 * canvas you were reviewing is moved aside and a new one takes the pane —
 * correct behaviour (notes anchored to a login screen have no business showing
 * over a checkout flow), but until now it happened in silence. Any open notes
 * went with it, and the only clue was that the version list had reset.
 *
 * One line, with what went with it and the way back. Dismissable, because
 * having read it is the end of it.
 */
export default function CanvasFiledStrip({ sessionId }: { sessionId: string }) {
  const notice = useCanvasStore((s) => s.bySessionId[sessionId]?.filedNotice ?? null)
  const dismissFiled = useCanvasStore((s) => s.dismissFiled)
  const [busy, setBusy] = useState(false)
  const openSessionIds = useSessionStore((s) => s.sessions.map((x) => x.id).join(','))

  const goBack = useCallback(async () => {
    if (!notice) return
    setBusy(true)
    useCanvasStore.getState().expectSwitch(sessionId)
    try {
      const res = await window.electronAPI.canvas.reclaim({
        sessionId,
        canvasId: notice.canvasId,
        openTileSessionIds: openSessionIds ? openSessionIds.split(',') : [],
      })
      // Only on success. Dismissing unconditionally took the strip away on a
      // refusal too, and the strip IS the offer of a way back — losing it means
      // the user cannot retry the one action they asked for. The comment below
      // said the strip stays up; the `finally` it sat next to made that false.
      if (res?.ok) dismissFiled(sessionId)
      else useCanvasStore.getState().cancelExpectedSwitch(sessionId)
    } catch {
      /* the strip stays up; the library is the fallback route */
      useCanvasStore.getState().cancelExpectedSwitch(sessionId)
    } finally {
      setBusy(false)
    }
  }, [notice, sessionId, openSessionIds, dismissFiled])

  if (!notice) return null

  // The provenance sentence (item C): one line, on the app's own surface, that
  // says what was filed and offers the way back — not a coloured banner. The
  // filed canvas KEEPS its notes; Reopen brings the whole thing back, so the
  // line says "still there", not "gone".
  return (
    <div
      data-testid="canvas-filed-strip"
      className="flex-none flex items-center gap-2 px-3.5 py-1.5 text-[12px]"
      style={{
        background: 'var(--surface-stage)',
        borderBottom: '1px solid var(--border-subtle)',
        color: 'var(--text-secondary)',
      }}
    >
      <span className="shrink-0" style={{ color: 'var(--text-muted)' }} aria-hidden>▣</span>
      <span className="min-w-0 truncate">
        {'I filed '}
        <b style={{ color: 'var(--text-primary)', fontWeight: 620 }}>{notice.title || 'that canvas'}</b>
        {' to the Library when the agent started a different subject'}
        {describeLoss(notice.openNotes, notice.draftNotes)}
        {'.'}
      </span>
      <button
        onClick={() => void goBack()}
        disabled={busy}
        data-testid="canvas-filed-back"
        className="ml-auto shrink-0 text-[11.5px] font-semibold focus-ring rounded px-1 disabled:opacity-50"
        style={{ color: 'var(--brand)' }}
        title="Bring that canvas back into this session"
      >
        Reopen it
      </button>
      <button
        onClick={() => dismissFiled(sessionId)}
        aria-label="Dismiss"
        title="Dismiss"
        className="shrink-0 px-1 focus-ring rounded"
        style={{ color: 'var(--text-muted)' }}
      >
        &times;
      </button>
    </div>
  )
}

/** What went with the filing, in the "still there" framing — the notes are
 *  preserved on the filed canvas and Reopen brings them back. Unsubmitted notes
 *  lead when there are any: those are work the user has not handed over. */
function describeLoss(openNotes: number, draftNotes: number): string {
  if (draftNotes > 0 && openNotes > 0) {
    return ` — its ${draftNotes} unsubmitted and ${openNotes} open note${openNotes === 1 ? '' : 's'} are still there`
  }
  if (draftNotes > 0) return ` — its ${draftNotes} unsubmitted note${draftNotes === 1 ? '' : 's'} ${draftNotes === 1 ? 'is' : 'are'} still there`
  if (openNotes > 0) return ` — its ${openNotes} open note${openNotes === 1 ? '' : 's'} ${openNotes === 1 ? 'is' : 'are'} still there`
  return ''
}
