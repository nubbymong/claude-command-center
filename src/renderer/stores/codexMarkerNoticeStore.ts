import { create } from 'zustand'
import type { CanvasMarkerUndelivered, SubmitNotDeliveredReason } from '../../shared/types'

/**
 * Filed Agent Canvas reviews and verdicts a Codex session did not get (WP2 PR
 * 4, P4.1, row 51; review A-1): main's submit primitive answered "not
 * delivered" for the marker line, and main pushes it once
 * (canvas:agentMarkerUndelivered) with the canvas it was filed on.
 *
 * Held here, for the renderer's life, not in the canvas page: the page is
 * mounted only while the canvas pane is open, and a marker can fail up to two
 * minutes after it was filed, often while the user is watching the terminal.
 * The listener is set up once, early (App.tsx, as the cloud-agent listeners
 * are; the notices also ask for it when they mount), and never torn down.
 * Each record is kept under its canvas until the user dismisses it, and the
 * canvas page shows the ones of the canvas it has open.
 */

/** At most this many lines are kept per canvas, the oldest let go first. */
export const MARKER_NOTICES_PER_CANVAS = 5
/** At most this many canvases keep lines, the least recently told let go first. */
export const MARKER_NOTICE_CANVASES = 50
/** No marker line or id the app files is anywhere near this long. */
const MAX_FIELD = 4_000

const REASONS: ReadonlySet<SubmitNotDeliveredReason> = new Set<SubmitNotDeliveredReason>(['busy-timeout', 'prompt-on-screen', 'too-tall', 'not-drawn', 'refused-text', 'session-gone'])

const field = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD

/** A push as main sends it, checked: anything else is not kept. */
export function parseMarkerUndelivered(raw: unknown): CanvasMarkerUndelivered | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  if (!field(u.sessionId) || !field(u.canvasId) || !field(u.line)) return null
  if (typeof u.reason !== 'string' || !REASONS.has(u.reason as SubmitNotDeliveredReason)) return null
  return { sessionId: u.sessionId, canvasId: u.canvasId, line: u.line, reason: u.reason as SubmitNotDeliveredReason }
}

interface MarkerNoticeState {
  /** By canvas id, oldest first. */
  byCanvasId: Record<string, CanvasMarkerUndelivered[]>
  add: (notice: CanvasMarkerUndelivered) => void
  dismiss: (notice: CanvasMarkerUndelivered) => void
}

export const useCodexMarkerNoticeStore = create<MarkerNoticeState>((set) => ({
  byCanvasId: {},
  add: (notice) => set((s) => {
    // The same line about the same canvas again replaces the earlier one.
    const list = [...(s.byCanvasId[notice.canvasId] ?? []).filter((x) => !(x.line === notice.line && x.sessionId === notice.sessionId)), notice]
      .slice(-MARKER_NOTICES_PER_CANVAS)
    const rest = Object.entries(s.byCanvasId).filter(([id]) => id !== notice.canvasId)
    const kept = [...rest, [notice.canvasId, list] as const].slice(-MARKER_NOTICE_CANVASES)
    return { byCanvasId: Object.fromEntries(kept) }
  }),
  dismiss: (notice) => set((s) => {
    const list = (s.byCanvasId[notice.canvasId] ?? []).filter((x) => x !== notice)
    const next = { ...s.byCanvasId }
    if (list.length) next[notice.canvasId] = list
    else delete next[notice.canvasId]
    return { byCanvasId: next }
  }),
}))

let listening = false

/** Listen for main's pushes, once for the renderer's life. Idempotent. */
export function setupCodexMarkerNoticeListener(): void {
  if (listening) return
  const subscribe = window.electronAPI?.canvas?.onAgentMarkerUndelivered
  if (typeof subscribe !== 'function') return
  listening = true
  subscribe((raw) => {
    const notice = parseMarkerUndelivered(raw)
    if (notice) useCodexMarkerNoticeStore.getState().add(notice)
  })
}

/** Forget the listener and the records. Tests only. */
export function _resetCodexMarkerNoticesForTest(): void {
  listening = false
  useCodexMarkerNoticeStore.setState({ byCanvasId: {} })
}
