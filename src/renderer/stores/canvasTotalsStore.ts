import { create } from 'zustand'
import type { CanvasLibraryEntry } from '../../shared/canvas'
import { useSessionStore } from './sessionStore'

/**
 * "3 canvases, 2 with reviews waiting" — the number that spans canvases.
 *
 * A session owns many canvases and the pane shows one. The pane's own count
 * ("2 reviews open") is honest about THAT canvas and says nothing about the
 * others; the 2026-08-20 dimensions pass shipped it as the small honest number
 * and deferred the total ("worth doing, not worth doing first"). This is the
 * total: every canvas this session owns, what is still owed on each, summed.
 *
 * Source: `canvas:listAll`, which already joins per-canvas review counts onto
 * every entry the asking session owns (the sweep is bounded only for OTHER
 * sessions' canvases). No new channel; one read per refresh.
 *
 * Refreshed lazily the first time a session's Canvas button mounts, and on
 * every `canvas:changed` / `canvas:reviewChanged` push for that session —
 * which is every moment the answer can change. Debounced: a review submit
 * fires both pushes within a millisecond.
 *
 * `unknown` is the count of owned canvases whose review store could not be
 * read. main leaves `openReviewCount` UNDEFINED rather than 0 for those, and
 * the UI must not present "could not tell" as "nothing owed".
 */
export interface CanvasTotals {
  loaded: boolean
  /** Canvases this session owns (including the one on screen). */
  canvases: number
  /** Open reviews summed across them. */
  openReviews: number
  /** Owned canvases with at least one open review. */
  withOpenReviews: number
  /** Owned canvases whose counts could not be read. */
  unknown: number
  /** Open reviews on the canvas the session is currently showing (0 when unreadable). */
  onActive: number
  /**
   * THE queue number (#364, recut in #470): CANVASES waiting on the user —
   * a canvas counts once whether it owes a first review, verdict rounds, or
   * both ("a count above 1 is legitimate across different canvases, never for
   * the same item"). One row per owing canvas too. One derivation feeds
   * the Canvas button, the queue list, the tab mark and the pane lead, so the
   * numbers can never disagree.
   */
  queue: number
  /** The sweep's view of the on-screen canvas's share of `queue` — subtracted
   *  by consumers that read that canvas from the fresher live mirrors. */
  queueOnActive: number
  /** The owed canvases, one row each, newest first. */
  queueRows: CanvasQueueRow[]
}

/** One owing canvas in the queue list. */
export interface CanvasQueueRow {
  canvasId: string
  title?: string
  kind: 'review' | 'verdict'
  /** verdict rows: how many rounds on this canvas await verdicts. */
  rounds?: number
  /** When it became owed (review) or the canvas last rendered (verdict). */
  at: string
  onActive: boolean
}

interface State {
  bySessionId: Record<string, CanvasTotals>
}

interface Actions {
  refresh: (sessionId: string) => Promise<void>
  /** Debounced refresh for the push listeners. */
  scheduleRefresh: (sessionId: string) => void
  reset: () => void
}

const defaultTotals = (): CanvasTotals => ({
  loaded: false, canvases: 0, openReviews: 0, withOpenReviews: 0, unknown: 0, onActive: 0,
  queue: 0, queueOnActive: 0, queueRows: [],
})

/** Fold a library listing into the session's totals. Exported for tests. */
export function totalsFromEntries(entries: CanvasLibraryEntry[]): CanvasTotals {
  const t: CanvasTotals = { ...defaultTotals(), loaded: true }
  for (const e of entries) {
    if (!e.ownedByThisSession && !e.isActiveForThisSession) continue
    // A signed-off canvas (#476) is terminal history: it owes nothing and is
    // not part of the working count or the queue. By invariant it carries no
    // awaitingReview/verdictRounds, but skip it outright so a stale count can
    // never surface a completed canvas in the pill.
    if (e.completed) continue
    t.canvases++
    // ONE canvas is at most ONE owed item (#470, owner: "a count above 1 is
    // legitimate across different canvases, never for the same item") — one
    // row per owing canvas too, so the pill and the list under it agree. A
    // canvas owing BOTH kinds shows as the ready render (the newest ask); the
    // verdict detail rides `rounds` when that is the kind. The review-needed
    // half comes from the canvas RECORD, so it counts even when the review
    // store is unreadable — a hand-over must never disappear behind a broken
    // reviews.json.
    const owesVerdicts = !!e.verdictRounds && e.verdictRounds > 0
    if (e.awaitingReview || owesVerdicts) {
      t.queue++
      if (e.isActiveForThisSession) t.queueOnActive++
      t.queueRows.push({
        canvasId: e.canvasId,
        ...(e.title ? { title: e.title } : {}),
        ...(e.awaitingReview
          ? { kind: 'review' as const, at: e.awaitingReviewAt ?? e.lastRenderedAt }
          : { kind: 'verdict' as const, rounds: e.verdictRounds, at: e.lastRenderedAt }),
        onActive: !!e.isActiveForThisSession,
      })
    }
    if (e.openReviewCount === undefined) { t.unknown++; continue }
    t.openReviews += e.openReviewCount
    if (e.openReviewCount > 0) t.withOpenReviews++
    if (e.isActiveForThisSession) t.onActive = e.openReviewCount
  }
  t.queueRows.sort((a, b) => {
    const at = Date.parse(a.at)
    const bt = Date.parse(b.at)
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at
    return a.canvasId < b.canvasId ? -1 : a.canvasId > b.canvasId ? 1 : 0
  })
  return t
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

export const useCanvasTotalsStore = create<State & Actions>((set, get) => ({
  bySessionId: {},

  refresh: async (sessionId) => {
    let entries: CanvasLibraryEntry[]
    try {
      const openTileSessionIds = useSessionStore.getState().sessions.map((s) => s.id)
      const list = await window.electronAPI.canvas.listAll({ openTileSessionIds, sessionId })
      entries = Array.isArray(list) ? list : []
    } catch {
      // Could not read. Keep whatever was known; never zero it — a broken read
      // must not render as "nothing owed".
      const prev = get().bySessionId[sessionId]
      if (!prev) set((s) => ({ bySessionId: { ...s.bySessionId, [sessionId]: { ...defaultTotals(), loaded: true } } }))
      return
    }
    set((s) => ({ bySessionId: { ...s.bySessionId, [sessionId]: totalsFromEntries(entries) } }))
  },

  scheduleRefresh: (sessionId) => {
    const prev = timers.get(sessionId)
    if (prev) clearTimeout(prev)
    timers.set(sessionId, setTimeout(() => {
      timers.delete(sessionId)
      void get().refresh(sessionId)
    }, 150))
  },

  reset: () => {
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
    set({ bySessionId: {} })
  },
}))
