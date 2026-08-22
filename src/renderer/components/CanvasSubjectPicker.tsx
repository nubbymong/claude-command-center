import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { CanvasLibraryEntry } from '../../shared/canvas'
import { useSessionStore } from '../stores/sessionStore'
import { useCanvasStore } from '../stores/canvasStore'

/**
 * Which canvas am I on, and what else have I got?
 *
 * A canvas holds one SUBJECT; a session authors as many as it is asked for and
 * points at exactly one. Until now the pane exposed a version picker and a
 * Library button, so "which version" was answerable and "which canvas" was not,
 * and the others were invisible.
 *
 * A MENU, not tabs. Only one canvas can be mounted at a time — the snapshot host
 * keeps one frame per session — and a session may hold up to fifty, so a tab
 * strip would either lie about that or eat the toolbar. The menu lists only THIS
 * session's own canvases, which is the bounded, actionable set; everything else
 * in the project stays in the library, one line down.
 *
 * Switching between canvases this session already owns is an index repoint, not
 * an adoption: no ownership moves, and it is allowed even while another canvas
 * is held. Taking a canvas from a DIFFERENT session is a real adoption with real
 * guards, and it stays in the library where those guards live.
 */

interface Props {
  sessionId: string
  /** The canvas on screen right now. */
  canvasId: string
  /** Its subject, or undefined for a canvas rendered before titles existed. */
  title?: string
  /** Open the full library (every canvas in the project). */
  onOpenLibrary: () => void
}

export default function CanvasSubjectPicker({ sessionId, canvasId, title, onOpenLibrary }: Props) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<CanvasLibraryEntry[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const openSessionIds = useSessionStore((s) => s.sessions.map((x) => x.id).join(','))

  const load = useCallback(async () => {
    try {
      const list = await window.electronAPI.canvas.listAll({
        openTileSessionIds: openSessionIds ? openSessionIds.split(',') : [],
        sessionId,
      })
      setEntries(Array.isArray(list) ? list : [])
      setError(null)
    } catch {
      setEntries([])
      setError('The canvas list could not be read.')
    }
  }, [openSessionIds, sessionId])

  // Loaded on OPEN, not on mount. The count in the button is the only thing
  // needed while it is shut, and a per-render sweep of the store is not worth
  // a number nobody is looking at.
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  // Dismiss on any outside interaction, the same way the tab context menu does.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => { setConfirmDelete(null) }, [open])

  const mine = (entries ?? []).filter((e) => e.ownedByThisSession || e.canvasId === canvasId)
  const others = mine.filter((e) => e.canvasId !== canvasId).length

  const switchTo = useCallback(async (target: string) => {
    setBusy(target)
    setError(null)
    // Announce it BEFORE the round-trip: the change lands as the same push a
    // filing does, and a switch the user asked for is not news to them.
    useCanvasStore.getState().expectSwitch(sessionId)
    try {
      const res = await window.electronAPI.canvas.reclaim({
        sessionId,
        canvasId: target,
        openTileSessionIds: openSessionIds ? openSessionIds.split(',') : [],
      })
      // The pane follows the canvas:changed push; nothing to do here but close.
      if (res?.ok) setOpen(false)
      else {
        // No switch, so no push, so nothing consumes the announcement above —
        // and a stale one silences the next genuine filing notice for this
        // session. Refusals are ordinary here (a canvas from another account is
        // one), so this is the common path, not the exceptional one.
        useCanvasStore.getState().cancelExpectedSwitch(sessionId)
        setError('That canvas could not be opened here.')
      }
    } catch {
      useCanvasStore.getState().cancelExpectedSwitch(sessionId)
      setError('That canvas could not be opened here.')
    } finally {
      setBusy(null)
    }
  }, [sessionId, openSessionIds])

  const remove = useCallback(async (target: string) => {
    setBusy(target)
    setError(null)
    try {
      const res = await window.electronAPI.canvas.deleteCanvas({ canvasId: target })
      if (res?.ok) {
        setEntries((list) => (list ?? []).filter((e) => e.canvasId !== target))
        await load()
      } else {
        setError('That canvas could not be deleted.')
      }
    } catch {
      setError('That canvas could not be deleted.')
    } finally {
      setBusy(null)
      setConfirmDelete(null)
    }
  }, [load])

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="canvas-subject-picker"
        className="flex items-center gap-1.5 max-w-[260px] px-2 py-0.5 rounded-md text-[12px] font-semibold tracking-[-0.01em] transition-colors focus-ring"
        style={{
          color: 'var(--text-primary)',
          background: 'color-mix(in srgb, var(--brand) 11%, transparent)',
          border: '1px solid color-mix(in srgb, var(--brand) 34%, transparent)',
        }}
        title={title ? `Canvas subject: ${title}` : 'This canvas has no subject recorded'}
      >
        <span className="truncate">{title || 'Agent Canvas'}</span>
        {others > 0 && (
          <span className="shrink-0 text-[10px] font-normal tabular-nums" style={{ color: 'var(--text-muted)' }}>
            +{others}
          </span>
        )}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden className="shrink-0" style={{ color: 'var(--text-muted)' }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          data-testid="canvas-subject-menu"
          className="absolute left-0 top-full mt-1 z-30 w-[320px] rounded-lg overflow-hidden"
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-subtle)',
            boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
          }}
        >
          <div className="px-3 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.09em]" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
            In this session
          </div>
          {error && <div className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--status-danger)' }}>{error}</div>}
          {entries === null && <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>Reading…</div>}
          {entries !== null && mine.length === 0 && (
            <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>Nothing else here yet.</div>
          )}
          <div className="max-h-[280px] overflow-y-auto">
            {mine.map((e) => {
              const isCurrent = e.canvasId === canvasId
              const confirming = confirmDelete === e.canvasId
              return (
                <div
                  key={e.canvasId}
                  data-testid="canvas-subject-row"
                  className="flex items-center gap-2 px-3 py-2"
                  style={{
                    borderBottom: '1px solid color-mix(in srgb, var(--border-subtle) 55%, transparent)',
                    background: isCurrent ? 'color-mix(in srgb, var(--brand) 13%, transparent)' : undefined,
                  }}
                >
                  <span
                    className="w-[5px] h-[5px] rounded-full shrink-0"
                    style={{ background: isCurrent ? 'var(--brand)' : 'var(--text-muted)' }}
                    aria-hidden
                  />
                  <button
                    type="button"
                    onClick={() => { if (!isCurrent) void switchTo(e.canvasId) }}
                    disabled={isCurrent || busy !== null}
                    className="min-w-0 flex-1 text-left disabled:cursor-default focus-ring rounded"
                  >
                    <span className="block text-[11.5px] truncate" style={{ color: 'var(--text-primary)' }}>
                      {e.title || 'Untitled canvas'}
                    </span>
                    <span className="block text-[9.5px] truncate" style={{ color: 'var(--text-muted)' }}>
                      {e.latestMode === 'uat' ? 'Live site' : 'Mockup'} · {e.versionCount} version{e.versionCount === 1 ? '' : 's'}
                      {describeOutstanding(e)}
                    </span>
                  </button>
                  {confirming ? (
                    <button
                      type="button"
                      onClick={() => void remove(e.canvasId)}
                      disabled={busy === e.canvasId}
                      data-testid="canvas-subject-delete-confirm"
                      className="shrink-0 text-[10px] rounded px-1.5 py-0.5 disabled:opacity-50 focus-ring"
                      style={{ color: 'var(--status-danger)', background: 'color-mix(in srgb, var(--status-danger) 15%, transparent)', border: '1px solid color-mix(in srgb, var(--status-danger) 50%, transparent)' }}
                      title={deleteWarning(e)}
                    >
                      {deleteConfirmLabel(e)}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setConfirmDelete(e.canvasId); setError(null) }}
                      data-testid="canvas-subject-delete"
                      className="shrink-0 text-[10px] rounded px-1.5 py-0.5 focus-ring"
                      style={{ color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
                      title={deleteWarning(e)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <button
            type="button"
            onClick={() => { setOpen(false); onOpenLibrary() }}
            className="w-full text-left px-3 py-2 text-[11px] focus-ring"
            style={{ color: 'var(--brand)', borderTop: '1px solid var(--border-subtle)' }}
          >
            All canvases in this project…
          </button>
        </div>
      )}
    </div>
  )
}

/** " · 2 open, 3 unsubmitted" — or nothing. Counts are undefined, never zero,
 *  when the review store could not be read, so an unreadable store shows no
 *  claim at all rather than a confident "clear". */
function describeOutstanding(e: CanvasLibraryEntry): string {
  const bits: string[] = []
  if (e.openReviewCount) bits.push(`${e.openReviewCount} review${e.openReviewCount === 1 ? '' : 's'} open`)
  if (e.draftNoteCount) bits.push(`${e.draftNoteCount} unsubmitted`)
  return bits.length > 0 ? ` · ${bits.join(', ')}` : ''
}

/** The confirm button says what goes, because this is the one canvas control
 *  that cannot be undone — and unsubmitted notes are work the user has not
 *  handed over and cannot get back. */
function deleteConfirmLabel(e: CanvasLibraryEntry): string {
  if (e.draftNoteCount) return `Delete + lose ${e.draftNoteCount} unsubmitted`
  if (e.openReviewCount) return `Delete + ${e.openReviewCount} open review${e.openReviewCount === 1 ? '' : 's'}`
  return `Delete ${e.versionCount} version${e.versionCount === 1 ? '' : 's'}`
}

function deleteWarning(e: CanvasLibraryEntry): string {
  const parts = [`${e.versionCount} version${e.versionCount === 1 ? '' : 's'}`]
  if (e.openReviewCount) parts.push(`${e.openReviewCount} open review${e.openReviewCount === 1 ? '' : 's'}`)
  if (e.draftNoteCount) parts.push(`${e.draftNoteCount} unsubmitted note${e.draftNoteCount === 1 ? '' : 's'} you have not sent`)
  return `Deletes this canvas for good: ${parts.join(', ')}. This cannot be undone.`
}
