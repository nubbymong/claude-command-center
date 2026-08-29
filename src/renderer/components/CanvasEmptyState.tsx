import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ExcalidrawPane from './ExcalidrawPane'
import CanvasExplainedPage from './CanvasExplainedPage'
import { useCanvasStore } from '../stores/canvasStore'
import { useCanvasTotalsStore } from '../stores/canvasTotalsStore'
import { useSessionStore } from '../stores/sessionStore'
import { relativeTime } from '../utils/relativeTime'
import {
  dismissCanvas,
  dismissConfirmAriaLabel,
  dismissConfirmLabel,
  queueAge,
  resumeCanvas,
  resumeRefusalText,
  useCanvasResumableRows,
} from '../lib/canvasQueue'
import type { CanvasLibraryRow, CanvasLibraryTab, LibraryRowKind, ResumableRow } from '../../shared/canvas'
import { CanvasLibrary } from './CanvasLibrary'
import { useArmedConfirm } from '../hooks/useArmedConfirm'
import { DismissButton } from './ui/DismissButton'
import heroUrl from '../assets/aicc-agent-canvas.svg'

interface Props {
  sessionId: string
  onClose: () => void
}

/** How many artefacts of each type the front page shows before "See all". */
const RECENTS_PER_COLUMN = 3

/** The three typed columns, in the order the loop produces them. */
const RECENT_COLUMNS: Array<{ kind: LibraryRowKind; label: string; testid: string }> = [
  { kind: 'mockup', label: 'Mockups', testid: 'canvas-recents-mockups' },
  { kind: 'plan', label: 'Plans', testid: 'canvas-recents-plans' },
  { kind: 'pack', label: 'Test packs', testid: 'canvas-recents-packs' },
]

/** One artefact type, in the words the user reads on a row. */
function kindWord(kind: LibraryRowKind): string {
  return kind === 'pack' ? 'test pack' : kind
}

/**
 * Which badge treatment a row's verdict wears.
 *
 * ARCHIVED and SIGNED OFF are row-level facts, not verdicts, so they win over
 * the verdict string — an archived rejected mockup is archived first. Below
 * that the mapping is by prefix, because `verdictLabel` appends
 * "WITH OBSERVATIONS" to an approved or passed run.
 */
export function verdictBadge(row: Pick<CanvasLibraryRow, 'verdict' | 'archived' | 'completed'>): {
  text: string
  className: string
} {
  if (row.archived) return { text: 'ARCHIVED', className: 'cfp-vb cfp-vb-muted' }
  if (row.completed) return { text: 'SIGNED OFF', className: 'cfp-vb cfp-vb-done' }
  const v = (row.verdict || '').toUpperCase()
  if (v.startsWith('APPROVED') || v.startsWith('PASSED')) return { text: v, className: 'cfp-vb cfp-vb-ok' }
  if (v.startsWith('REJECTED') || v.startsWith('FAILED')) return { text: v, className: 'cfp-vb cfp-vb-bad' }
  if (v === 'OPEN' || v === 'DRAFT') return { text: v, className: 'cfp-vb cfp-vb-open' }
  return { text: v || 'OPEN', className: 'cfp-vb cfp-vb-muted' }
}

/** Type marks, one stroked glyph per artefact kind (the mock's own family). */
function KindIcon({ kind, className }: { kind: LibraryRowKind; className?: string }) {
  const paths =
    kind === 'plan' ? (
      <>
        <path d="M4 2.5h8v11H4z" />
        <path d="M6 5.5h4M6 8h4M6 10.5h2.5" />
      </>
    ) : kind === 'pack' ? (
      <>
        <path d="M6 2v4L2.5 12a1.5 1.5 0 0 0 1.3 2.2h8.4A1.5 1.5 0 0 0 13.5 12L10 6V2" />
        <path d="M5 2h6" />
      </>
    ) : (
      <>
        <rect x="1.5" y="2.5" width="13" height="9" rx="1" />
        <path d="M5 14h6" />
      </>
    )
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths}
    </svg>
  )
}

/**
 * The Agent Canvas front page (v8, approved on the canvas 2026-08-29).
 *
 * It used to be a lesson: an eyebrow, a headline, a starter prompt to type into
 * the terminal, the review loop drawn as five numbered steps, a sketchpad
 * escape hatch and a reclaim list. Every one of those is gone. A user who opens
 * this pane is not asking "what is a canvas" — they are asking "what is waiting
 * on me, what can I pick back up, and what has this project produced". So the
 * page answers exactly that, in three bands, and the explanation moved behind
 * one card for the one time it is actually wanted.
 *
 * What the removal costs, recorded honestly: the sketchpad has NO entry point
 * here any more (the store value survives — see `CanvasEmptyView`), and the
 * starter prompt is gone, so a brand-new user's first render now starts from
 * their own words rather than a canned one.
 */
export default function CanvasEmptyState({ sessionId, onClose }: Props) {
  const emptyView = useCanvasStore((s) => s.bySessionId[sessionId]?.emptyView ?? 'intro')
  const setEmptyView = useCanvasStore((s) => s.setEmptyView)
  const completedNotice = useCanvasStore((s) => s.bySessionId[sessionId]?.completedNotice ?? null)
  const dismissCompleted = useCanvasStore((s) => s.dismissCompleted)
  const refreshCanvas = useCanvasStore((s) => s.refresh)

  // Reopen from the acknowledgment: clear the stamp; main rebinds the canvas
  // as current (the session shows nothing else right now, by construction),
  // and the change push swaps the pane back onto it.
  const reopenCompleted = useCallback(
    async (canvasId: string) => {
      try {
        const res = await window.electronAPI.canvas.completeReopen({ sessionId, canvasId })
        if (res?.ok) {
          useCanvasStore.getState().dismissCompleted(sessionId)
          await useCanvasStore.getState().refresh(sessionId)
        }
      } catch {
        /* the notice stays; nothing was changed */
      }
    },
    [sessionId],
  )

  // Which Library tab this page is sending the user to, or `null` for closed.
  // A typed column's "See all" must land on THAT type — arriving on All and
  // having to re-find the tab you just clicked out of is the whole reason the
  // per-column link exists.
  const [libraryTab, setLibraryTab] = useState<CanvasLibraryTab | null>(null)
  const [rows, setRows] = useState<CanvasLibraryRow[]>([])
  const [truncated, setTruncated] = useState(false)
  const [opening, setOpening] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmingDismiss, setConfirmingDismiss] = useState<string | null>(null)
  // Double-click-proofing (#456): the confirm swaps into the Dismiss button's
  // footprint, so both clicks of one gesture land on the same point.
  const dismissConfirm = useArmedConfirm(confirmingDismiss)

  const resumables = useCanvasResumableRows(sessionId)
  const totalsLoaded = useCanvasTotalsStore((s) => !!s.bySessionId[sessionId]?.loaded)
  const refreshTotals = useCanvasTotalsStore((s) => s.refresh)

  // The resume rows come from the same sweep that feeds the Canvas button's
  // dot, so the two can never disagree about what is going spare. Hydrated
  // here as well as there because the pane can be the first thing to mount.
  useEffect(() => {
    if (!totalsLoaded) void refreshTotals(sessionId)
  }, [sessionId, totalsLoaded, refreshTotals])

  // What this project has produced, artefact by artefact. One read feeds the
  // in-flight card, the plan jump and all three recents columns — the front
  // page must not ask three times for one answer.
  //
  // Callable, not just an effect: the Library overlay sits OVER this page and
  // can archive or delete a row it still shows. The epoch keeps overlapping
  // loads last-write-wins.
  const listEpoch = useRef(0)
  const loadRows = useCallback(async () => {
    const epoch = ++listEpoch.current
    const openTileSessionIds = useSessionStore.getState().sessions.map((s) => s.id)
    try {
      const res = await window.electronAPI.canvas.libraryList({
        sessionId,
        openTileSessionIds,
        sort: 'recent',
      })
      if (listEpoch.current !== epoch) return
      setRows(Array.isArray(res?.rows) ? res.rows : [])
      setTruncated(!!res?.truncated)
    } catch {
      // Nothing to show is the safe default — an unread list must not invent
      // rows, and the bands simply do not draw.
      if (listEpoch.current === epoch) {
        setRows([])
        setTruncated(false)
      }
    }
  }, [sessionId])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  // Archived work is history, not "recent in this project" — it is reachable
  // through the Library's Archived filter, which is where someone looking for
  // it goes. This is a DISPLAY choice on rows main already decided we may see;
  // the privacy rule (never another live session's in-flight work) is enforced
  // in main and is not re-applied, or second-guessed, here.
  const live = useMemo(() => rows.filter((r) => !r.archived), [rows])

  // The one thing owed. Own, in play, and main says something is outstanding.
  const inFlight = useMemo(
    () => live.find((r) => r.ownedByThisSession && !r.completed && !!r.owed) ?? null,
    [live],
  )

  // A plan the project has already agreed. Offered as a jump, not an action:
  // the approved plan is the thing you re-read while the work happens.
  //
  // Excluded by ROW identity (canvasId + anchorVersionId), not by canvas. One
  // canvas ACCUMULATES artefacts — a plan gets approved, then a mockup run
  // starts on the same canvas — which is the normal shape, not the exception.
  // Matching on canvasId alone suppressed the jump in exactly that case, so the
  // most common project on earth never got a "View plan" link.
  const approvedPlan = useMemo(
    () =>
      live.find(
        (r) =>
          r.kind === 'plan' &&
          !(r.canvasId === inFlight?.canvasId && r.anchorVersionId === inFlight?.anchorVersionId) &&
          (r.completed || /^APPROVED/.test((r.verdict || '').toUpperCase())),
      ) ?? null,
    [live, inFlight],
  )

  const byKind = useMemo(() => {
    const map: Record<LibraryRowKind, CanvasLibraryRow[]> = { mockup: [], plan: [], pack: [] }
    for (const r of live) map[r.kind]?.push(r)
    return map
  }, [live])

  const openTiles = useCallback(() => useSessionStore.getState().sessions.map((s) => s.id), [])

  /** Put the pane on one of THIS session's own canvases. An index repoint of
   *  work it already owns, never an adoption — the same open-here path the
   *  Library and the queue list use. */
  const openHere = useCallback(
    async (canvasId: string) => {
      setOpening(true)
      setNotice(null)
      try {
        const res = await window.electronAPI.canvas.reclaim({
          sessionId,
          canvasId,
          openTileSessionIds: openTiles(),
        })
        if (res?.ok) await refreshCanvas(sessionId)
        else setNotice('That canvas could not be opened here.')
      } catch {
        setNotice('That canvas could not be opened here.')
      } finally {
        setOpening(false)
      }
    },
    [sessionId, refreshCanvas, openTiles],
  )

  const onResume = useCallback(
    async (row: ResumableRow) => {
      setBusy(row.canvasId)
      setNotice(null)
      const res = await resumeCanvas(sessionId, row, openTiles())
      if (res.ok) {
        // The pane swaps to the canvas surface as soon as the store has it.
        await refreshCanvas(sessionId)
      } else {
        // Refused: someone else got there first, or it is gone. Say which, then
        // re-read — the row must not linger offering an action that cannot run.
        setNotice(resumeRefusalText(res.reason))
      }
      await refreshTotals(sessionId)
      await loadRows()
      setBusy(null)
    },
    [sessionId, refreshCanvas, refreshTotals, loadRows, openTiles],
  )

  const onDismiss = useCallback(
    async (row: ResumableRow) => {
      setBusy(row.canvasId)
      setNotice(null)
      const res = await dismissCanvas(sessionId, row.canvasId, openTiles())
      if (!res.ok) setNotice(resumeRefusalText(res.reason))
      await refreshTotals(sessionId)
      await loadRows()
      setBusy(null)
      setConfirmingDismiss(null)
    },
    [sessionId, refreshTotals, loadRows, openTiles],
  )

  if (emptyView === 'sketchpad') {
    return (
      <div className="flex-1 flex flex-col min-h-0 relative">
        <ExcalidrawPane sessionId={sessionId} />
        {/* The way back to the canvas identity — floating so the classic pane
            keeps its whole chrome untouched. The v8 front page has no way IN
            to the sketchpad any more, so this is the only door, and it stays. */}
        <button
          onClick={() => setEmptyView(sessionId, 'intro')}
          className="absolute bottom-3 right-3 z-10 px-2.5 py-1 text-[11px] rounded-full border border-[var(--border-strong)] bg-[var(--surface-panel)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] shadow-lg transition-colors focus-ring"
          title="Back to the Agent Canvas front page"
        >
          Agent Canvas
        </button>
      </div>
    )
  }

  const chrome = (
    // Same chrome as the live canvas surface: 38px, one type size, and no
    // version affordances — an empty canvas has nothing to version.
    <div className="h-[38px] shrink-0 flex items-center gap-2.5 px-3 bg-[var(--surface-chrome)] border-b border-[var(--border-subtle)]">
      <span className="w-[5px] h-[5px] rounded-full bg-[var(--brand)]" aria-hidden="true" />
      <span className="text-[12px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">Agent Canvas</span>
      <div className="flex-1" />
      <DismissButton onClick={onClose} label="Close Agent Canvas" size={12} data-testid="canvas-empty-close" />
    </div>
  )

  if (emptyView === 'explained') {
    return (
      <div className="canvas-landing relative flex-1 flex flex-col min-h-0 bg-[var(--surface-stage)]">
        {chrome}
        {/* `canvas-stage` stays the container-query root so the Explained page
            answers to the PANE's width the same way the front page does. */}
        <div className="canvas-stage flex-1 min-h-0 overflow-y-auto" data-testid="canvas-explained-view">
          <CanvasExplainedPage onHome={() => setEmptyView(sessionId, 'intro')} />
        </div>
      </div>
    )
  }

  return (
    <div className="canvas-landing relative flex-1 flex flex-col min-h-0 bg-[var(--surface-stage)]">
      {chrome}

      {/* The stage. `canvas-stage` makes this a container query root so the
          page answers to the PANE's width, not the window's. */}
      <div className="canvas-stage flex-1 min-h-0 overflow-y-auto px-5 py-7" data-testid="canvas-front-page">
        {/* One quiet acknowledgment for a subject just signed off (#476) —
            session-local, gone on dismissal, Reopen, or the next render. It
            stays ABOVE the page, where the filed strip also sits. */}
        {completedNotice && (
          <div
            className="w-full max-w-[880px] mx-auto mb-4 flex items-center gap-2.5 rounded border px-3.5 py-2 text-[12px]"
            style={{
              background: 'var(--surface-panel)',
              borderColor: 'color-mix(in srgb, var(--status-success) 35%, transparent)',
              color: 'var(--text-secondary)',
            }}
            data-testid="canvas-completed-notice"
          >
            <span className="font-semibold" style={{ color: 'var(--status-success)' }}>
              {completedNotice.title ? `“${completedNotice.title}”` : 'Canvas'} completed
            </span>
            <span>· in the Library</span>
            <button
              onClick={() => void reopenCompleted(completedNotice.canvasId)}
              className="underline underline-offset-2 focus-ring rounded"
              style={{ color: 'var(--brand)' }}
              data-testid="canvas-completed-notice-reopen"
              title="Put it back in play — the pane returns to it"
            >
              Reopen
            </button>
            <div className="flex-1" />
            <DismissButton
              onClick={() => dismissCompleted(sessionId)}
              label="Dismiss this notice"
              data-testid="canvas-completed-notice-dismiss"
            />
          </div>
        )}

        <div className="cfp-col">
          {/* ── Masthead. The artwork in relief beside the wordmark; nothing
              else. No eyebrow, no tagline, no explanatory line. ───────── */}
          <div className="cfp-masthead" data-ux-id="brand-hero" data-testid="canvas-masthead">
            <img className="cfp-mast-art" src={heroUrl} alt="" aria-hidden="true" data-testid="canvas-masthead-art" />
            <h2 className="cfp-mast-word m-0" data-testid="canvas-masthead-word">
              Agent Canvas
            </h2>
          </div>

          {notice && (
            <p className="m-0 cfp-rc-note" role="status" data-testid="canvas-front-page-notice">
              {notice}
            </p>
          )}

          {/* ── In flight work, beside what can be picked back up ────────
              The plan jump does NOT depend on the need-card: a project with an
              agreed plan and nothing currently owed still wants the way back to
              the plan it is working to. */}
          {(inFlight || approvedPlan || resumables.length > 0) && (
            <div>
              <div className="cfp-band-h">
                <span className="cfp-band-t">In flight work</span>
              </div>
              <div className="cfp-now-grid">
                {(inFlight || approvedPlan) && (
                  <div data-ux-id="band-continue">
                    {inFlight && (
                      <div className="cfp-need-card" data-testid="canvas-inflight-card">
                        <div className="min-w-0">
                          <div className="cfp-need-title truncate">{inFlight.title}</div>
                          <div className="cfp-need-meta">
                            <span className="cfp-chip">{kindWord(inFlight.kind).toUpperCase()}</span>
                            <span className="cfp-chip">{inFlight.versionLabel}</span>
                            <span className="cfp-chip cfp-chip-warn" data-testid="canvas-inflight-owed">
                              {inFlight.owed}
                            </span>
                            {/* The owed line already carries a note count when
                                notes are what is owed — showing it twice on one
                                card is the thing the counts rule forbids. */}
                            {inFlight.noteCount > 0 && !/note/i.test(inFlight.owed ?? '') && (
                              <span>
                                {inFlight.noteCount} note{inFlight.noteCount === 1 ? '' : 's'}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          className="cfp-go focus-ring"
                          onClick={() => void openHere(inFlight.canvasId)}
                          disabled={opening}
                          data-testid="canvas-inflight-open"
                          title="Open this canvas in the pane"
                        >
                          {opening ? 'Opening…' : 'Open'}
                        </button>
                      </div>
                    )}
                    {approvedPlan && (
                      <button
                        className="cfp-plan-jump focus-ring"
                        onClick={() => setLibraryTab('plan')}
                        data-ux-id="plan-jump"
                        data-testid="canvas-plan-jump"
                        title="Find this plan in the Library"
                      >
                        <span className="cfp-pj-dot" aria-hidden="true" />
                        <span className="min-w-0 truncate">
                          <b>{approvedPlan.title}</b> · approved plan
                        </span>
                        <span className="cfp-pj-go">View plan →</span>
                      </button>
                    )}
                  </div>
                )}

                {resumables.length > 0 && (
                  <div className="cfp-resume-card" data-ux-id="resume-row" data-testid="canvas-resume-card">
                    {resumables.map((row) => (
                      <div key={row.canvasId} className="cfp-rc-item" data-testid="canvas-resume-row">
                        <div className="cfp-rc-h">
                          <span className="cfp-rc-dot" aria-hidden="true" />
                          <span className="cfp-rc-title">{row.title}</span>
                        </div>
                        <div className="cfp-rc-meta">
                          {kindWord(row.kind)} · {row.noteCount} note{row.noteCount === 1 ? '' : 's'} ·{' '}
                          {renderedLabel(row.lastRenderedAt)}
                          {row.configName ? ` · ${row.configName}` : ''}
                        </div>
                        <div className="cfp-rc-actions">
                          <button
                            className="cfp-rc-resume focus-ring"
                            onClick={() => void onResume(row)}
                            disabled={busy !== null}
                            data-testid="canvas-resume-action"
                            title="Take this canvas over in this session, with its versions and notes"
                          >
                            {busy === row.canvasId && confirmingDismiss !== row.canvasId ? 'Resuming…' : 'Resume'}
                          </button>
                          {confirmingDismiss === row.canvasId ? (
                            <button
                              ref={dismissConfirm.confirmRef}
                              className="cfp-rc-confirm focus-ring"
                              onClick={dismissConfirm.guarded(() => void onDismiss(row))}
                              disabled={busy !== null}
                              data-testid="canvas-resume-dismiss-confirm"
                              aria-label={dismissConfirmAriaLabel(row.title, row.noteCount)}
                            >
                              {busy === row.canvasId ? 'Discarding…' : dismissConfirmLabel(row.noteCount)}
                            </button>
                          ) : (
                            <button
                              className="cfp-rc-dismiss focus-ring"
                              onClick={() => { setConfirmingDismiss(row.canvasId); setNotice(null) }}
                              disabled={busy !== null}
                              data-testid="canvas-resume-dismiss"
                              title="Discard this canvas — its versions, notes and evidence go with it"
                            >
                              Dismiss
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Recent in this project ─────────────────────────────────── */}
          <div data-ux-id="band-recents" data-testid="canvas-recents">
            <div className="cfp-band-h">
              <span className="cfp-band-t">Recent in this project</span>
              <span className="cfp-band-n" data-testid="canvas-recents-total">
                {live.length}
                {truncated ? '+' : ''} artefact{live.length === 1 && !truncated ? '' : 's'}
              </span>
              <button
                className="cfp-band-seeall focus-ring"
                onClick={() => setLibraryTab('all')}
                data-ux-id="recents-seeall"
                data-testid="canvas-empty-library-open"
              >
                All in Library →
              </button>
            </div>
            <div className="cfp-recents-grid">
              {RECENT_COLUMNS.map((col) => {
                const items = byKind[col.kind]
                return (
                  <div className="cfp-type-card" key={col.kind} data-ux-id={col.testid} data-testid={col.testid}>
                    <div className="cfp-type-h">
                      <KindIcon kind={col.kind} className="cfp-type-icon" />
                      <span className="cfp-type-lbl">{col.label}</span>
                      <span className="cfp-type-count">{items.length}</span>
                      {items.length > RECENTS_PER_COLUMN && (
                        <button
                          className="cfp-type-more focus-ring"
                          onClick={() => setLibraryTab(col.kind)}
                          data-testid="canvas-recents-see-all"
                          data-kind={col.kind}
                        >
                          See all
                        </button>
                      )}
                    </div>
                    {items.length === 0 ? (
                      <p className="cfp-type-empty m-0">None yet.</p>
                    ) : (
                      items.slice(0, RECENTS_PER_COLUMN).map((row) => {
                        const badge = verdictBadge(row)
                        return (
                          <button
                            key={row.canvasId + row.anchorVersionId}
                            className="cfp-rrow focus-ring"
                            // A row lands on its OWN type's tab, so a click and
                            // the "See all" directly above it go to the same
                            // place — one meaning per card.
                            onClick={() => setLibraryTab(row.kind)}
                            data-testid="canvas-recent-row"
                            data-kind={row.kind}
                            title={`${row.title} — open in the Library`}
                          >
                            <span className="cfp-rt">{row.title}</span>
                            <span className="cfp-rmeta">
                              <span className={badge.className}>{badge.text}</span>
                              <span className="cfp-age">{queueAge(row.updatedAt)}</span>
                            </span>
                          </button>
                        )
                      })
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── Canvas Explained. The only teaching left on the page, behind
              one door, for the one time it is wanted. ─────────────────── */}
          <button
            className="cfp-explain focus-ring"
            onClick={() => setEmptyView(sessionId, 'explained')}
            data-ux-id="explain-card"
            data-testid="canvas-explained-card"
          >
            <span className="cfp-ex-icon">
              <svg
                width="22"
                height="22"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2" y="2.5" width="12" height="8.5" rx="1" />
                <path d="M8 11v2.5M5 15h6M5.5 5.5h5M5.5 8h3" />
              </svg>
            </span>
            <span>
              <span className="cfp-ex-title block">Canvas Explained</span>
              <span className="cfp-ex-sub block">
                How reviews work — versions, notes and verdicts across mockup, plan and testing.
              </span>
            </span>
            <span className="cfp-ex-arrow" aria-hidden="true">
              ›
            </span>
          </button>
        </div>
      </div>

      {libraryTab !== null && (
        <CanvasLibrary
          sessionId={sessionId}
          initialTab={libraryTab}
          onClose={() => {
            setLibraryTab(null)
            // The Library can archive, adopt or delete a row this page still
            // shows — re-read so nothing offers an action on a ghost.
            void loadRows()
            void refreshTotals(sessionId)
          }}
        />
      )}
    </div>
  )
}

/** "2d ago" when the stamp parses, the raw stamp when it does not — a stored
 *  value we cannot read is still worth showing, just not worth guessing at. */
function renderedLabel(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? relativeTime(ms) : iso
}
