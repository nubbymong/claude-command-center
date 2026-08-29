import React, { useCallback, useState } from 'react'
import { useCanvasStore } from '../stores/canvasStore'
import { useExcalidrawStore } from '../stores/excalidrawStore'
import { useSessionStore } from '../stores/sessionStore'
import { isContextMenuGesture } from '../lib/pointer'
import {
  dismissCanvas,
  dismissConfirmAriaLabel,
  dismissConfirmLabel,
  queueAge,
  resumeCanvas,
  resumeRefusalText,
  useCanvasQueueRows,
  useCanvasResumableRows,
} from '../lib/canvasQueue'
import { useCanvasTotalsStore, type CanvasQueueRow } from '../stores/canvasTotalsStore'
import { useArmedConfirm } from '../hooks/useArmedConfirm'
import type { ResumableRow } from '../../shared/canvas'

/**
 * The review queue (#364): click the Canvas button's count and this is the
 * owed list — one row per round, action first. A row opens THAT canvas: the
 * pane opens if it is closed, and a round on another of this session's
 * canvases switches to it through the same reclaim path the subject picker
 * uses (an index repoint of the session's own work, never an adoption).
 *
 * The list is the sweep's view (canvasTotalsStore.queueRows). The count on
 * the button mixes in the live mirrors for the on-screen canvas, so the two
 * can disagree by one for the ~150ms the sweep's debounce lasts — the list
 * refreshes on the same pushes and catches up on its own.
 *
 * Below it, a second section (M4): canvases nobody currently owns, on this
 * project, that this session may take over. Kept visibly apart from the owed
 * list because they are different obligations — the first is work you owe an
 * answer on, the second is work going spare. Rows for another LIVE session's
 * in-flight work never reach here at all: main applies that privacy rule and
 * the renderer does not second-guess it.
 */

interface Props {
  sessionId: string
  onClose: () => void
}

export default function CanvasQueuePopover({ sessionId, onClose }: Props) {
  const rows = useCanvasQueueRows(sessionId)
  const resumables = useCanvasResumableRows(sessionId)
  const unknown = useCanvasTotalsStore((s) => s.bySessionId[sessionId]?.unknown ?? 0)
  const refreshTotals = useCanvasTotalsStore((s) => s.refresh)
  const activeCanvasId = useCanvasStore((s) => s.bySessionId[sessionId]?.canvasId ?? null)
  const setOpen = useExcalidrawStore((s) => s.setOpen)
  const openSessionIds = useSessionStore((s) => s.sessions.map((x) => x.id).join(','))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDismiss, setConfirmingDismiss] = useState<string | null>(null)
  // #456: the confirm swaps into the Dismiss button's footprint, so a
  // double-click would otherwise arm and fire in one gesture.
  const dismissConfirm = useArmedConfirm(confirmingDismiss)

  // Re-read the tiles at CLICK time, not at list time: main applies the same
  // liveness rule on both calls and the truth may have changed in between.
  const openTiles = useCallback(
    () => (openSessionIds ? openSessionIds.split(',') : []),
    [openSessionIds],
  )

  const onResume = useCallback(
    async (row: ResumableRow) => {
      setBusy(row.canvasId)
      setError(null)
      const res = await resumeCanvas(sessionId, row, openTiles())
      if (res.ok) {
        await useCanvasStore.getState().refresh(sessionId)
        await refreshTotals(sessionId)
        setBusy(null)
        setOpen(sessionId, true)
        onClose()
        return
      }
      // Refused — someone else got there first, or it is gone. One plain line,
      // then a refresh: the row must not linger offering an action that cannot
      // run.
      setError(resumeRefusalText(res.reason))
      await refreshTotals(sessionId)
      setBusy(null)
    },
    [sessionId, openTiles, refreshTotals, setOpen, onClose],
  )

  const onDismiss = useCallback(
    async (row: ResumableRow) => {
      setBusy(row.canvasId)
      setError(null)
      const res = await dismissCanvas(sessionId, row.canvasId, openTiles())
      if (!res.ok) setError(resumeRefusalText(res.reason))
      await refreshTotals(sessionId)
      setBusy(null)
      setConfirmingDismiss(null)
    },
    [sessionId, openTiles, refreshTotals],
  )

  const openRow = useCallback(
    async (row: CanvasQueueRow) => {
      setError(null)
      if (row.canvasId !== activeCanvasId) {
        setBusy(row.canvasId)
        // The subject picker's switch: announce before the round-trip so the
        // change is not reported as a filing, and cancel the announcement on
        // any refusal so it cannot swallow a real one. Announced ONLY when the
        // mirror holds a canvas to switch FROM — with none (the row opens a
        // canvas onto an empty session), the change event carries no identity
        // change, nothing would consume the expectation, and the leaked count
        // would silence the next genuine filing notice.
        const announced = activeCanvasId !== null
        if (announced) useCanvasStore.getState().expectSwitch(sessionId)
        try {
          const res = await window.electronAPI.canvas.reclaim({
            sessionId,
            canvasId: row.canvasId,
            openTileSessionIds: openSessionIds ? openSessionIds.split(',') : [],
          })
          if (!res?.ok) {
            if (announced) useCanvasStore.getState().cancelExpectedSwitch(sessionId)
            setError('That canvas could not be opened here.')
            setBusy(null)
            return
          }
        } catch {
          if (announced) useCanvasStore.getState().cancelExpectedSwitch(sessionId)
          setError('That canvas could not be opened here.')
          setBusy(null)
          return
        }
        setBusy(null)
      }
      setOpen(sessionId, true)
      onClose()
    },
    [sessionId, activeCanvasId, openSessionIds, setOpen, onClose],
  )

  return (
    <>
      {/* Mousedown, not click, and a right-click dismisses inertly — the
          command bar's popover rule (#386). */}
      <div
        className="fixed inset-0 z-40"
        onMouseDown={(e) => { if (!isContextMenuGesture(e)) onClose() }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onClose() }}
        data-testid="canvas-queue-backdrop"
      />
      <div
        role="menu"
        aria-label="Canvas review queue"
        className="absolute right-0 top-full mt-1 z-[41] w-[320px] rounded-lg overflow-hidden"
        style={{
          background: 'var(--surface-raised)',
          border: '1px solid var(--border-subtle)',
          boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
        }}
        data-testid="canvas-queue-popover"
      >
        <div
          className="px-3 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.09em]"
          style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}
        >
          Waiting on you
        </div>
        {error && <div className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--status-danger)' }}>{error}</div>}
        {rows.length === 0 && (
          <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Nothing is waiting on you.
          </div>
        )}
        <div className="max-h-[280px] overflow-y-auto">
          {rows.map((row) => (
            <button
              key={`${row.canvasId}:${row.kind}`}
              type="button"
              role="menuitem"
              onClick={() => void openRow(row)}
              disabled={busy !== null}
              data-testid="canvas-queue-row"
              data-kind={row.kind}
              className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors focus-ring hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] disabled:opacity-60"
              style={{ borderBottom: '1px solid color-mix(in srgb, var(--border-subtle) 55%, transparent)' }}
            >
              {/* C1 left `review` as the only queue kind, so the second arm of
                  this badge ("Verdict") had become unreachable — a colour and a
                  word the code claimed to support and could never draw. */}
              <span
                className="shrink-0 text-[9px] font-bold uppercase tracking-[0.05em] rounded px-1.5 py-0.5"
                style={{
                  color: 'var(--status-warning)',
                  background: 'color-mix(in srgb, var(--status-warning) 14%, transparent)',
                }}
              >
                Review
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[11.5px] truncate" style={{ color: 'var(--text-primary)' }}>
                  {row.title || 'Untitled canvas'}
                </span>
                <span className="block text-[9.5px] truncate" style={{ color: 'var(--text-muted)' }}>
                  {`ready for review${row.onActive ? ' · this canvas' : ''}`}
                </span>
              </span>
              <span className="shrink-0 text-[9.5px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                {queueAge(row.at)}
              </span>
            </button>
          ))}
        </div>
        {resumables.length > 0 && (
          <div data-testid="canvas-queue-resume-section">
            <div
              className="px-3 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.09em]"
              style={{
                color: 'var(--text-muted)',
                borderTop: '1px solid var(--border-subtle)',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              Can be resumed
            </div>
            <div className="max-h-[220px] overflow-y-auto">
              {resumables.map((row) => (
                <div
                  key={row.canvasId}
                  className="px-3 py-2"
                  style={{ borderBottom: '1px solid color-mix(in srgb, var(--border-subtle) 55%, transparent)' }}
                  data-testid="canvas-queue-resume-row"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="cqp-resume-dot" aria-hidden="true" />
                    <span className="min-w-0 flex-1 block text-[11.5px] truncate" style={{ color: 'var(--text-primary)' }}>
                      {row.title}
                    </span>
                    <span className="shrink-0 text-[9.5px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                      {queueAge(row.lastRenderedAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[9.5px] truncate" style={{ color: 'var(--text-muted)' }}>
                    {row.kind === 'pack' ? 'test pack' : row.kind} · {row.noteCount} note
                    {row.noteCount === 1 ? '' : 's'}
                    {row.configName ? ` · ${row.configName}` : ''}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => void onResume(row)}
                      disabled={busy !== null}
                      data-testid="canvas-queue-resume-action"
                      className="cqp-resume-btn rounded px-2 py-1 text-[11px] font-semibold focus-ring disabled:opacity-50"
                      title="Take this canvas over in this session, with its versions and notes"
                    >
                      {busy === row.canvasId && confirmingDismiss !== row.canvasId ? 'Resuming…' : 'Resume'}
                    </button>
                    {confirmingDismiss === row.canvasId ? (
                      <button
                        type="button"
                        ref={dismissConfirm.confirmRef}
                        onClick={dismissConfirm.guarded(() => void onDismiss(row))}
                        disabled={busy !== null}
                        data-testid="canvas-queue-dismiss-confirm"
                        aria-label={dismissConfirmAriaLabel(row.title, row.noteCount)}
                        className="cqp-dismiss-confirm rounded px-2 py-1 text-[11px] font-semibold focus-ring disabled:opacity-50"
                      >
                        {busy === row.canvasId ? 'Discarding…' : dismissConfirmLabel(row.noteCount)}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setConfirmingDismiss(row.canvasId); setError(null) }}
                        disabled={busy !== null}
                        data-testid="canvas-queue-dismiss"
                        className="cqp-dismiss-btn rounded px-2 py-1 text-[11px] focus-ring disabled:opacity-50"
                        title="Discard this canvas — its versions, notes and evidence go with it"
                      >
                        Dismiss
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* "Could not tell" is never presented as "nothing owed" — the rule the
            whole totals sweep follows. */}
        {unknown > 0 && (
          <div
            className="px-3 py-1.5 text-[9.5px]"
            style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}
            data-testid="canvas-queue-unknown"
          >
            {unknown} canvas{unknown === 1 ? '' : 'es'} could not be read — verdict rounds there are not counted.
          </div>
        )}
      </div>
    </>
  )
}
