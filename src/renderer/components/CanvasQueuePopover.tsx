import React, { useCallback, useState } from 'react'
import { useCanvasStore } from '../stores/canvasStore'
import { useExcalidrawStore } from '../stores/excalidrawStore'
import { useSessionStore } from '../stores/sessionStore'
import { isContextMenuGesture } from '../lib/pointer'
import { queueAge, useCanvasQueueRows } from '../lib/canvasQueue'
import { useCanvasTotalsStore, type CanvasQueueRow } from '../stores/canvasTotalsStore'

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
 */

interface Props {
  sessionId: string
  onClose: () => void
}

export default function CanvasQueuePopover({ sessionId, onClose }: Props) {
  const rows = useCanvasQueueRows(sessionId)
  const unknown = useCanvasTotalsStore((s) => s.bySessionId[sessionId]?.unknown ?? 0)
  const activeCanvasId = useCanvasStore((s) => s.bySessionId[sessionId]?.canvasId ?? null)
  const setOpen = useExcalidrawStore((s) => s.setOpen)
  const openSessionIds = useSessionStore((s) => s.sessions.map((x) => x.id).join(','))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
              <span
                className="shrink-0 text-[9px] font-bold uppercase tracking-[0.05em] rounded px-1.5 py-0.5"
                style={
                  row.kind === 'review'
                    ? {
                        color: 'var(--status-warning)',
                        background: 'color-mix(in srgb, var(--status-warning) 14%, transparent)',
                      }
                    : {
                        color: 'var(--accent-tip)',
                        background: 'color-mix(in srgb, var(--accent-tip) 14%, transparent)',
                      }
                }
              >
                {row.kind === 'review' ? 'Review' : 'Verdict'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[11.5px] truncate" style={{ color: 'var(--text-primary)' }}>
                  {row.title || 'Untitled canvas'}
                </span>
                <span className="block text-[9.5px] truncate" style={{ color: 'var(--text-muted)' }}>
                  {row.kind === 'review'
                    ? `ready for review${row.onActive ? ' · this canvas' : ''}`
                    : `${row.rounds ?? 1} round${(row.rounds ?? 1) === 1 ? '' : 's'} awaiting your verdicts${row.onActive ? ' · this canvas' : ''}`}
                </span>
              </span>
              <span className="shrink-0 text-[9.5px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                {queueAge(row.at)}
              </span>
            </button>
          ))}
        </div>
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
