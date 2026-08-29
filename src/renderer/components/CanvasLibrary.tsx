import React, { useCallback, useEffect, useState } from 'react'
import type { CanvasLibraryEntry } from '../../shared/canvas'
import { useSessionStore } from '../stores/sessionStore'
import { useArmedConfirm } from '../hooks/useArmedConfirm'

/**
 * The canvas LIBRARY.
 *
 * Everything the canvas ever rendered accumulated with no way to look at it or
 * remove it: `renderVersion` only appends, nothing deleted, and the only place
 * an old canvas surfaced was the reclaim list of a session that happened to have
 * none of its own. So the pile grew, and the visible symptom was old sessions
 * turning up in a list the user could not act on.
 *
 * Placement follows the two states the user is actually in. With a canvas open,
 * the library sits in the pane header next to the version picker — "which
 * version" and "which canvas" are the same kind of question, so they belong in
 * the same place. With no canvas open, the empty state offers it directly,
 * because that is the moment the user is asking "what have I got?".
 *
 * Deleting is two-step in place rather than a modal: a modal in front of a
 * housekeeping action the user does several of in a row is a wall. The second
 * click is the confirmation, it says what will go, and a canvas that is on
 * screen in another tile right now says so before it can be removed.
 */
export function CanvasLibrary({
  sessionId,
  onClose,
  onOpened,
}: {
  sessionId: string
  onClose: () => void
  /** Called after a canvas is adopted into THIS session, so the pane can show it. */
  onOpened?: () => void
}) {
  const [entries, setEntries] = useState<CanvasLibraryEntry[] | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Double-click-proofing (#456): each confirm kind guards its own arm moment.
  const deleteConfirm = useArmedConfirm(confirming)
  const openSessionIds = useSessionStore((s) => s.sessions.map((x) => x.id).join(','))

  const load = useCallback(async () => {
    try {
      // sessionId scopes the list to THIS project. Main resolves the directory
      // from its own spawn record, so this is a "which project am I in" hint,
      // not a path the renderer gets to choose.
      const list = await window.electronAPI.canvas.listAll({
        openTileSessionIds: openSessionIds ? openSessionIds.split(',') : [],
        sessionId,
      })
      setEntries(Array.isArray(list) ? list : [])
    } catch {
      setEntries([])
      setError('The library could not be read.')
    }
  }, [openSessionIds, sessionId])

  useEffect(() => { void load() }, [load])

  const remove = useCallback(async (canvasId: string) => {
    setBusy(canvasId)
    setError(null)
    try {
      const res = await window.electronAPI.canvas.deleteCanvas({ canvasId })
      if (res?.ok) setEntries((list) => (list ?? []).filter((e) => e.canvasId !== canvasId))
      else setError('That canvas could not be deleted.')
    } catch {
      setError('That canvas could not be deleted.')
    } finally {
      setBusy(null)
      setConfirming(null)
    }
  }, [])

  // The row's "Close notes" close-out is gone with the per-note controls (W6).
  // Bulk-clearing a canvas's rounds from a list, where none of the notes are on
  // screen, was the shape that made "settled" mean six different things; the one
  // exit that remains is Mark complete in the pane, which names exactly what it
  // is closing before the user commits.

  /**
   * How much a row still OWES — the owed-first sort key.
   *
   * `liveRoundCount`, not `verdictRounds`: a round the agent has answered is no
   * longer work the user has to discharge, so counting only those left rows
   * with real outstanding feedback sorted below rows with none. A live round is
   * a live round whichever side last touched it, and a version still open for
   * review (`phase: 'needs-you'`) is the decision that ends one.
   */
  const libraryOwed = (e: CanvasLibraryEntry): number =>
    (e.awaitingReview || e.phase === 'needs-you' ? 1 : 0) + (e.liveRoundCount ?? 0) + (e.draftNoteCount ?? 0)

  /** Reopen a completed canvas (#476): clears the sign-off; obligations (there
   *  are none, by the completion guard) and history come back as they were. */
  const reopenCompletedRow = useCallback(async (canvasId: string) => {
    setBusy(canvasId)
    setError(null)
    try {
      const res = await window.electronAPI.canvas.completeReopen({ sessionId, canvasId })
      if (res?.ok) await load()
      else setError('That canvas could not be reopened.')
    } catch {
      setError('That canvas could not be reopened.')
    } finally {
      setBusy(null)
    }
  }, [sessionId, load])

  const openHere = useCallback(async (canvasId: string) => {
    setBusy(canvasId)
    setError(null)
    try {
      const res = await window.electronAPI.canvas.reclaim({
        sessionId,
        canvasId,
        openTileSessionIds: openSessionIds ? openSessionIds.split(',') : [],
      })
      if (res?.ok) { onOpened?.(); onClose() }
      else setError('That canvas could not be opened here — it may belong to a session that is still running.')
    } catch {
      setError('That canvas could not be opened here.')
    } finally {
      setBusy(null)
    }
  }, [sessionId, openSessionIds, onOpened, onClose])

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-[var(--surface-stage)]" data-testid="canvas-library">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)] shrink-0">
        <span className="text-[12px] font-semibold text-[var(--text-primary)]">Canvas library</span>
        <span className="text-[11px] text-[var(--text-secondary)]">
          {entries === null ? '' : `${entries.length} canvas${entries.length === 1 ? '' : 'es'}`}
        </span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="text-[11.5px] rounded px-2 py-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)] focus-ring"
        >
          Done
        </button>
      </div>

      {error && <div className="px-3 py-1.5 text-[11px] text-[var(--status-danger)] shrink-0">{error}</div>}

      <div className="flex-1 overflow-y-auto">
        {entries !== null && entries.length === 0 && (
          <p className="p-4 text-[12px] text-[var(--text-secondary)]">
            Nothing here yet. Ask for a mockup, or point the canvas at a built site, and it will show up.
          </p>
        )}
        {/* Rows that owe the user something sort above recency (#364) — the
            same action-first rule as the picker; stable, so the store's
            banding survives inside each half. */}
        {(entries ?? [])
          .slice()
          .sort((a, b) => (libraryOwed(b) > 0 ? 1 : 0) - (libraryOwed(a) > 0 ? 1 : 0))
          .map((e) => (
          <div
            key={e.canvasId}
            className="flex items-center gap-3 px-3 py-2 border-b border-[var(--border-subtle)]/60"
            data-testid="canvas-library-row"
          >
            <ModeBadge mode={e.latestMode} />
            <div className="min-w-0 flex-1">
              {/* The subject leads when there is one: a project name and a
                  timestamp do not tell anyone WHICH canvas they are about to
                  delete, and several canvases from one project look identical
                  without it. The project drops to the second line in that case
                  rather than disappearing. */}
              <div className="flex items-center gap-1.5 text-[12px] text-[var(--text-primary)] truncate" title={e.title || e.cwd}>
                {e.completed ? (
                  <span
                    className="shrink-0 text-[8.5px] font-bold uppercase tracking-[0.05em] rounded px-1 py-px"
                    style={{ color: 'var(--status-success)', background: 'color-mix(in srgb, var(--status-success) 13%, transparent)' }}
                    title={`Signed off ${e.completed.by === 'agent' ? 'by the agent on your instruction' : 'by you'}`}
                    data-testid="canvas-library-completed-badge"
                  >
                    Completed
                  </span>
                ) : e.awaitingReview ? (
                  <span
                    className="shrink-0 text-[8.5px] font-bold uppercase tracking-[0.05em] rounded px-1 py-px"
                    style={{ color: 'var(--status-warning)', background: 'color-mix(in srgb, var(--status-warning) 14%, transparent)' }}
                  >
                    Review
                  </span>
                ) : e.phase === 'needs-you' ? (
                  <span
                    className="shrink-0 text-[8.5px] font-bold uppercase tracking-[0.05em] rounded px-1 py-px"
                    style={{ color: 'var(--status-warning)', background: 'color-mix(in srgb, var(--status-warning) 14%, transparent)' }}
                  >
                    Decide
                  </span>
                ) : e.liveRoundCount ? (
                  // "Verdict" was the old badge, and it named something that no
                  // longer exists: a round is never waiting on the user's
                  // per-note verdict. A live round is with the AGENT, and the
                  // row should say so rather than send the user looking for a
                  // button that is not there.
                  <span
                    className="shrink-0 text-[8.5px] font-bold uppercase tracking-[0.05em] rounded px-1 py-px"
                    style={{ color: 'var(--accent-tip)', background: 'color-mix(in srgb, var(--accent-tip) 14%, transparent)' }}
                  >
                    In flight
                  </span>
                ) : null}
                {e.title || projectName(e.cwd)}
                {!e.title && e.conversationShortId && (
                  <span className="ml-1.5 text-[10.5px] text-[var(--text-secondary)]">· {e.conversationShortId}</span>
                )}
              </div>
              <div className="text-[10.5px] text-[var(--text-secondary)] truncate">
                {e.title && <span title={e.cwd}>{projectName(e.cwd)} · </span>}
                {e.versionCount} version{e.versionCount === 1 ? '' : 's'} · {relTime(e.lastRenderedAt)}
                {/* Counts are undefined, never zero, when the review store
                    could not be read — so an unreadable one shows no claim
                    rather than a confident "clear". */}
                {!!e.openReviewCount && (
                  <span className="ml-1.5 text-[var(--status-warning)]">
                    {e.openReviewCount} review{e.openReviewCount === 1 ? '' : 's'} open
                  </span>
                )}
                {e.ownedByOpenSession && <span className="ml-1.5 text-[var(--brand)]">open in another session</span>}
              </div>
            </div>
            <button
              onClick={() => void openHere(e.canvasId)}
              disabled={busy === e.canvasId}
              className="shrink-0 text-[11px] rounded px-2 py-0.5 border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 focus-ring"
              title={e.completed ? 'Look at the completed canvas — read-only until you Reopen it' : undefined}
            >
              {e.completed ? 'View' : 'Open here'}
            </button>
            {/* Reopen (#476): only on rows this session owns — a foreign
                canvas's sign-off is its owner's to undo. */}
            {e.completed && e.ownedByThisSession && (
              <button
                onClick={() => void reopenCompletedRow(e.canvasId)}
                disabled={busy === e.canvasId}
                className="shrink-0 text-[11px] rounded px-2 py-0.5 border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 focus-ring"
                data-testid="canvas-library-reopen"
                title="Put this canvas back in play — clears the Completed sign-off"
              >
                Reopen
              </button>
            )}
            {confirming === e.canvasId ? (
              <button
                ref={deleteConfirm.confirmRef}
                onClick={deleteConfirm.guarded(() => void remove(e.canvasId))}
                disabled={busy === e.canvasId}
                className="shrink-0 text-[11px] rounded px-2 py-0.5 bg-[color-mix(in_srgb,var(--status-danger)_15%,transparent)] border border-[color-mix(in_srgb,var(--status-danger)_50%,transparent)] text-[var(--status-danger)] hover:bg-[color-mix(in_srgb,var(--status-danger)_25%,transparent)] disabled:opacity-50 focus-ring"
                data-testid="canvas-library-confirm-delete"
              >
                {e.ownedByOpenSession
                  ? 'Delete anyway'
                  : `Delete ${e.versionCount} version${e.versionCount === 1 ? '' : 's'}`}
              </button>
            ) : (
              <button
                onClick={() => { setConfirming(e.canvasId); setError(null) }}
                className="shrink-0 text-[11px] rounded px-2 py-0.5 border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--status-danger)] focus-ring"
                data-testid="canvas-library-delete"
              >
                Delete
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** The mode, said plainly. The three modes are the product's own vocabulary, so
 *  the badge uses the same words the empty state and the pane header use. */
function ModeBadge({ mode }: { mode?: 'design' | 'uat' }) {
  const label = mode === 'uat' ? 'Live site' : mode === 'design' ? 'Mockup' : '—'
  const title =
    mode === 'uat' ? 'A built site, served for UI testing'
      : mode === 'design' ? 'A standalone mockup document'
        : 'No versions yet'
  return (
    <span
      className="shrink-0 w-[68px] text-center text-[10px] rounded px-1.5 py-0.5 border border-[var(--border-subtle)] text-[var(--text-secondary)]"
      title={title}
    >
      {label}
    </span>
  )
}

/** Last path segment of the project folder — the part a person recognises. */
function projectName(cwd?: string): string {
  if (!cwd) return 'Unknown project'
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : cwd
}

/** Short relative time; absolute dates read as noise in a list this dense. */
function relTime(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return 'unknown'
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}
