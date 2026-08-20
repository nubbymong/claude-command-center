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
      await window.electronAPI.canvas.reclaim({
        sessionId,
        canvasId: notice.canvasId,
        openTileSessionIds: openSessionIds ? openSessionIds.split(',') : [],
      })
    } catch {
      /* the strip stays up; the library is the fallback route */
    } finally {
      setBusy(false)
      dismissFiled(sessionId)
    }
  }, [notice, sessionId, openSessionIds, dismissFiled])

  if (!notice) return null

  return (
    <div
      data-testid="canvas-filed-strip"
      className="flex-none flex items-center gap-2 px-3 py-1.5 text-[11.5px]"
      style={{
        background: 'color-mix(in srgb, var(--color-yellow) 10%, transparent)',
        borderBottom: '1px solid color-mix(in srgb, var(--color-yellow) 30%, transparent)',
        color: 'var(--text-secondary)',
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-yellow)' }} aria-hidden className="shrink-0">
        <path d="M4 4h5l2 3h9v13H4z" />
      </svg>
      <span className="min-w-0 truncate">
        <b style={{ color: 'var(--text-primary)', fontWeight: 620 }}>{notice.title || 'That canvas'}</b>
        {' was filed'}
        {describeLoss(notice.openNotes, notice.draftNotes)}
        {' — the agent started a different subject.'}
      </span>
      <button
        onClick={() => void goBack()}
        disabled={busy}
        data-testid="canvas-filed-back"
        className="ml-auto shrink-0 px-2 py-0.5 rounded-md text-[11px] font-semibold focus-ring disabled:opacity-50"
        style={{
          color: 'var(--color-yellow)',
          background: 'color-mix(in srgb, var(--color-yellow) 13%, transparent)',
          border: '1px solid color-mix(in srgb, var(--color-yellow) 42%, transparent)',
        }}
        title="Bring that canvas back into this session"
      >
        Go back
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

/** The unsubmitted notes lead when there are any: those are work the user has
 *  not handed over, and they are the reason this strip exists. */
function describeLoss(openNotes: number, draftNotes: number): string {
  if (draftNotes > 0 && openNotes > 0) {
    return ` — ${draftNotes} unsubmitted and ${openNotes} open note${openNotes === 1 ? '' : 's'} went with it`
  }
  if (draftNotes > 0) return ` — ${draftNotes} unsubmitted note${draftNotes === 1 ? '' : 's'} went with it`
  if (openNotes > 0) return ` — ${openNotes} open note${openNotes === 1 ? '' : 's'} went with it`
  return ''
}
