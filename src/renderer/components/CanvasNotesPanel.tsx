import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { exportToBlob } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { Annotation, CanvasSketchExport, CanvasVersion, FocusObject, Rect } from '../../shared/canvas'
import {
  draftAnnotationsOf,
  draftReviewOf,
  reviewGroupsOf,
  useCanvasReviewStore,
  type ReviewGroup,
} from '../stores/canvasReviewStore'
import { PAGE_REPORTED_MARK, PAGE_REPORTED_TITLE } from '../canvas/page-reported'

interface Props {
  sessionId: string
  version: CanvasVersion
  /** Read at call time — the glass remounts with the pane. */
  getGlassApi: () => ExcalidrawImperativeAPI | null
  /** One-click return to the terminal after submit (spec D3). */
  onReturnToTerminal: () => void
}

/** Scene-coord bbox of a set of glass elements. The glass is pinned 1:1 over
 *  the content (scene ≡ page coords), so this IS the sketch's page bbox. */
function sceneBBox(elements: Array<{ x: number; y: number; width: number; height: number }>): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of elements) {
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + el.width)
    maxY = Math.max(maxY, el.y + el.height)
  }
  return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** "sent 14:20 · on v3" — when the round went out, and against what. The
 *  version matters: a note was written against the render that was on screen
 *  then, which is not necessarily the one you are looking at now. */
function reviewSentLabel(review: { submittedAt?: string; createdAt: string; versionId: string }): string {
  const raw = review.submittedAt ?? review.createdAt
  const ms = Date.parse(raw)
  const when = Number.isFinite(ms)
    ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null
  return when ? `sent ${when} · on ${review.versionId}` : `on ${review.versionId}`
}

const SCOPE_BADGE: Record<Annotation['scope'], string> = {
  element: 'text-blue',
  region: 'text-peach',
  general: 'text-overlay1',
}

/**
 * The label of a locked target, attributed.
 *
 * An element lock's label ('button "Save"') is assembled from what the page
 * answered when the host asked what sits at the clicked point — the artifact
 * under review describing itself. A region's ('region 420×180') is the app's
 * own measurement of the rectangle the user dragged. Only the first is marked,
 * because marking both would teach the user to read the mark as decoration.
 */
function FocusLabel({ focus, className }: { focus: FocusObject; className?: string }) {
  const pageReported = focus.targets.length > 0
  return (
    <span className={className} title={pageReported ? PAGE_REPORTED_TITLE : focus.label}>
      {pageReported && <span className="text-overlay1">{PAGE_REPORTED_MARK} </span>}
      {focus.label}
    </span>
  )
}

/**
 * The docked notes panel (spec D3/§6): resolution checklist for open notes
 * from earlier reviews, the composer for the note being written, the draft
 * list, and Submit. GitHub-review vocabulary throughout.
 */
export default function CanvasNotesPanel({ sessionId, version, getGlassApi, onReturnToTerminal }: Props) {
  const state = useCanvasReviewStore((s) => s.bySessionId[sessionId])
  const refresh = useCanvasReviewStore((s) => s.refresh)
  const upsertNote = useCanvasReviewStore((s) => s.upsertNote)
  const deleteNote = useCanvasReviewStore((s) => s.deleteNote)
  const submitReview = useCanvasReviewStore((s) => s.submitReview)
  const resolveNote = useCanvasReviewStore((s) => s.resolveNote)
  const clearFocus = useCanvasReviewStore((s) => s.clearFocus)
  const expandFocus = useCanvasReviewStore((s) => s.expandFocus)
  const setEditing = useCanvasReviewStore((s) => s.setEditingAnnotation)
  const setPanelHighlight = useCanvasReviewStore((s) => s.setPanelHighlight)
  const dismissHelp = useCanvasReviewStore((s) => s.dismissHelp)
  const helpDismissed = useCanvasReviewStore((s) => s.bySessionId[sessionId]?.helpDismissed ?? false)

  const [noteText, setNoteText] = useState('')
  const [attachedSketch, setAttachedSketch] = useState<{ excalidrawElementIds: string[]; bboxPage: Rect } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [justSubmitted, setJustSubmitted] = useState<{ id: string; count: number } | null>(null)
  /** Pending auto-return, cleared on unmount so a torn-down panel cannot toggle
   *  a pane that no longer belongs to it. */
  const returnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (returnTimerRef.current) clearTimeout(returnTimerRef.current) }, [])

  useEffect(() => {
    void refresh(sessionId)
  }, [sessionId, refresh])

  const focus = state?.focus ?? null
  const focusChain = state?.focusChain ?? []
  const focusChainIndex = state?.focusChainIndex ?? 0
  const editingId = state?.editingAnnotationId ?? null
  const resolution = state?.resolution ?? null

  const draftReview = state ? draftReviewOf(state) : null
  const draftNotes = state ? draftAnnotationsOf(state) : []
  // Every submitted round, newest first, with who it is waiting on.
  const groups = useMemo(() => (state ? reviewGroupsOf(state) : []), [state])
  /** Explicit user toggles only. The DEFAULT is derived per group (a closed
   *  round starts collapsed, an outstanding one starts open) so a round that
   *  becomes closed folds itself away without the user having to tidy up. */
  const [groupOverride, setGroupOverride] = useState<Record<string, boolean>>({})
  const isGroupCollapsed = useCallback(
    (g: ReviewGroup) => groupOverride[g.review.id] ?? g.waitingOn === 'closed',
    [groupOverride],
  )
  const toggleGroup = useCallback((reviewId: string, defaultCollapsed: boolean) => {
    setGroupOverride((prev) => ({ ...prev, [reviewId]: !(prev[reviewId] ?? defaultCollapsed) }))
  }, [])
  const [busyReviewId, setBusyReviewId] = useState<string | null>(null)
  const [confirmDismissId, setConfirmDismissId] = useState<string | null>(null)

  const editingNote = useMemo(
    () => (editingId ? (draftNotes.find((a) => a.id === editingId) ?? null) : null),
    [editingId, draftNotes],
  )

  // Opening a note for editing loads its text + sketch into the composer.
  useEffect(() => {
    if (editingNote) {
      setNoteText(editingNote.note)
      setAttachedSketch(editingNote.sketch ? { excalidrawElementIds: editingNote.sketch.excalidrawElementIds, bboxPage: editingNote.sketch.bboxPage } : null)
    }
  }, [editingNote?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const composerScope: Annotation['scope'] = focus ? (focus.targets.length > 0 ? 'element' : 'region') : 'general'
  const canExpand = focus != null && focusChain.length > 0 && focusChainIndex < focusChain.length - 1

  const attachSelection = useCallback(() => {
    const api = getGlassApi()
    if (!api) return
    const selected = api.getAppState().selectedElementIds
    const ids = Object.keys(selected).filter((id) => selected[id])
    if (ids.length === 0) return
    const chosen = api.getSceneElements().filter((el) => ids.includes(el.id))
    if (chosen.length === 0) return
    setAttachedSketch({ excalidrawElementIds: chosen.map((el) => el.id), bboxPage: sceneBBox(chosen) })
  }, [getGlassApi])

  const saveNote = useCallback(async () => {
    const text = noteText.trim()
    if (!text) return
    const scope = editingNote ? editingNote.scope : composerScope
    const noteFocus = editingNote ? editingNote.focus : (focus ?? undefined)
    const saved = await upsertNote(sessionId, {
      ...(editingNote ? { annotationId: editingNote.id } : {}),
      scope,
      note: text,
      ...(scope !== 'general' && noteFocus ? { focus: noteFocus } : {}),
      ...(attachedSketch ? { sketch: attachedSketch } : {}),
      versionId: version.id,
    })
    if (saved !== null) {
      setNoteText('')
      setAttachedSketch(null)
      setEditing(sessionId, null)
      if (!editingNote) clearFocus(sessionId)
      setJustSubmitted(null)
    }
  }, [noteText, editingNote, composerScope, focus, attachedSketch, sessionId, version.id, upsertNote, setEditing, clearFocus])

  /**
   * Close a whole round in one action.
   *
   * Sequential, not parallel: every resolve round-trips through main and
   * commits the state main returns, so firing them together would have each
   * response overwrite the last and leave the panel showing a stale mirror.
   * Guarded by `busyReviewId` so a double-click cannot start a second pass over
   * notes the first pass has already consumed.
   */
  const resolveGroup = useCallback(
    async (group: ReviewGroup, action: 'approve' | 'dismiss') => {
      if (busyReviewId) return
      setBusyReviewId(group.review.id)
      try {
        // Snapshot the ids first: `group` is derived from the store, which each
        // resolve mutates underneath us.
        const ids = group.notes.filter((n) => n.state === 'addressed').map((n) => n.id)
        for (const id of ids) {
          await resolveNote(sessionId, id, action)
        }
      } finally {
        setBusyReviewId(null)
        setConfirmDismissId(null)
      }
    },
    [busyReviewId, resolveNote, sessionId],
  )

  const cancelEdit = useCallback(() => {
    setEditing(sessionId, null)
    setNoteText('')
    setAttachedSketch(null)
  }, [sessionId, setEditing])

  /**
   * Submit (spec §6 step 4): every sketch-carrying draft note gets its glass
   * elements exported to PNG here — elements that have since been erased drop
   * the sketch from the note first, so main (which refuses a sketch without
   * its export) never sees a half-attached note.
   */
  const doSubmit = useCallback(async () => {
    if (!draftReview || draftNotes.length === 0 || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const api = getGlassApi()
      const scene = api?.getSceneElements() ?? []
      const files = api?.getFiles() ?? {}
      const sketches: CanvasSketchExport[] = []
      for (const note of draftNotes) {
        if (!note.sketch) continue
        const live = scene.filter((el) => note.sketch!.excalidrawElementIds.includes(el.id))
        if (live.length === 0) {
          // The drawing is gone from the glass — save the note without it.
          await upsertNote(sessionId, {
            annotationId: note.id,
            scope: note.scope,
            note: note.note,
            ...(note.scope !== 'general' && note.focus ? { focus: note.focus } : {}),
            versionId: note.versionId,
          })
          continue
        }
        const blob = await exportToBlob({
          elements: live,
          appState: { exportBackground: false },
          files,
          mimeType: 'image/png',
          maxWidthOrHeight: 1200,
        })
        sketches.push({ annotationId: note.id, pngBase64: await blobToBase64(blob) })
      }
      const review = await submitReview(sessionId, draftReview.id, sketches)
      if (!review) {
        setSubmitError('The review could not be submitted. Check the note list and try again.')
        return
      }
      const count = review.annotationIds.length
      // The pull side of D10: one line in chat carries the id; the agent
      // fetches the payload itself via canvas_review.
      window.electronAPI.pty.write(sessionId, `Review #${review.id.slice(1)} — ${count} notes · canvas_review ${review.id}\r`)
      setJustSubmitted({ id: review.id, count })
      // Hand back to the session automatically. Submitting is the moment the
      // work moves from the user to the agent, and the agent has ALREADY been
      // handed the review by the line written just above -- so leaving the user
      // on a frozen canvas, with a button they have to find, strands them on the
      // one surface where nothing is now happening. The confirmation stays up
      // for a beat first so the hand-off reads as deliberate rather than abrupt,
      // and the Canvas button pulses again the moment the agent re-renders,
      // which is what brings them back. The manual control stays for anyone who
      // wants to leave sooner.
      returnTimerRef.current = setTimeout(() => {
        returnTimerRef.current = null
        onReturnToTerminal()
      }, 1200)
    } finally {
      setSubmitting(false)
    }
  }, [draftReview, draftNotes, submitting, getGlassApi, sessionId, submitReview, upsertNote])

  /**
   * What the checklist may say about one open note — and, as load-bearing as
   * the words, WHO is saying it.
   *
   * `current` and `ghost` are the app's own knowledge: which version a note was
   * written against, and where its box was when the user drew it. `reported` is
   * not. A re-anchor result is assembled by the page under review, in answer to
   * a question about that page, with no way for the host to check the answer —
   * so it is rendered in the page's voice ("page says …") and never in the
   * app's. It used to read "re-anchored" in resolved green, which let an
   * artifact mark every open issue against it as tracked and point the
   * highlight anywhere it liked (adversarial review, 2026-08-14): the reviewer
   * saw their issues as followed up when nothing had been.
   */
  const checklistStatus = useCallback(
    (note: Annotation): { text: string; kind: 'reported' | 'ghost' | 'current'; rect: Rect | null } => {
      // A note written against the version on screen needs no re-anchoring.
      if (note.versionId === version.id) {
        return { text: 'on this version', kind: 'current', rect: note.focus?.bboxPage ?? null }
      }
      if (!note.focus) return { text: 'general', kind: 'current', rect: null }
      if (note.focus.targets.length === 0) {
        return { text: 'region — verify placement', kind: 'ghost', rect: note.focus.bboxPage }
      }
      const entry = resolution?.versionId === version.id ? resolution.byAnnotation[note.id] : undefined
      if (entry && entry.found) {
        return {
          text: entry.via === 'ux-id' ? 'page says re-anchored (id)' : 'page says re-anchored (fingerprint)',
          kind: 'reported',
          rect: entry.box,
        }
      }
      if (entry === null) return { text: 'needs re-pointing', kind: 'ghost', rect: note.focus.bboxPage }
      return { text: 'locating…', kind: 'ghost', rect: note.focus.bboxPage }
    },
    [resolution, version.id],
  )

  const hoverChecklistNote = useCallback(
    (note: Annotation | null) => {
      if (!note) {
        setPanelHighlight(sessionId, null)
        return
      }
      const status = checklistStatus(note)
      // The stage highlight carries the same distinction: a box the page
      // asserts is drawn dashed and in the page-reported colour, never in the
      // solid green that means "the app knows where this is".
      setPanelHighlight(
        sessionId,
        status.rect
          ? { rect: status.rect, kind: status.kind === 'current' ? 'anchored' : status.kind === 'reported' ? 'reported' : 'ghost' }
          : null,
      )
    },
    [sessionId, checklistStatus, setPanelHighlight],
  )

  return (
    <div className="w-80 shrink-0 border-l border-surface0 bg-mantle flex flex-col min-h-0 text-[12px]">
      <div className="px-3 py-2 border-b border-surface0 flex items-center gap-2 shrink-0">
        <span className="font-medium text-subtext1">Review</span>
        {draftReview && <span className="text-overlay1">draft · {draftNotes.length} note{draftNotes.length === 1 ? '' : 's'}</span>}
        <div className="flex-1" />
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {/* ── First-use primer — until the first note exists or it's dismissed ── */}
        {!helpDismissed && draftNotes.length === 0 && (state?.reviews.length ?? 0) === 0 && (
          <div className="mx-3 mt-2 mb-1 rounded border border-mauve/40 bg-mauve/5 px-3 py-2.5">
            <div className="flex items-center">
              <span className="text-[11px] font-medium text-mauve uppercase tracking-wide">How to review</span>
              <button
                onClick={() => dismissHelp(sessionId)}
                className="ml-auto text-[11px] text-overlay1 hover:text-text"
                title="Hide this"
              >
                ✕
              </button>
            </div>
            <ul className="mt-1.5 flex flex-col gap-1 text-[11px] text-subtext0 leading-relaxed">
              <li>In <span className="text-text">Browse</span>, click anything on the page to select it — <span className="text-text">↑</span> selects its parent, <span className="text-text">Esc</span> clears.</li>
              <li><span className="text-text">Region</span> lets you drag a box over an area instead.</li>
              <li>Sketch in <span className="text-text">Draw</span>, select the strokes, then attach them to a note here.</li>
              <li>Write notes below, then <span className="text-text">Submit review</span> — your agent picks them up and revises.</li>
            </ul>
          </div>
        )}

        {/* ── Resolution checklist (spec §6 step 2), by ROUND ──
            A review is sent as a unit, so it comes back as one. Flattening every
            open note under a single heading lost the round: nothing said a whole
            review was finished, there was no way to close one, and a note from
            this morning sat between two from ten minutes ago. */}
        {groups.map((group) => {
          const collapsed = isGroupCollapsed(group)
          return (
          <div key={group.review.id} className="border-b border-surface0" data-testid="review-group" data-review={group.review.id}>
            <button
              type="button"
              onClick={() => toggleGroup(group.review.id, group.waitingOn === 'closed')}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface0/40 focus-ring"
              aria-expanded={!collapsed}
            >
              <svg
                width="9" height="9" viewBox="0 0 10 10" fill="currentColor" aria-hidden
                className="shrink-0 text-overlay0 transition-transform"
                style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
              >
                <polygon points="2,2 8,5 2,8" />
              </svg>
              <span className="text-[11px] font-semibold text-text shrink-0">
                {group.review.id.replace('R', 'Review #')}
              </span>
              <span className="text-[10px] text-overlay1 truncate">{reviewSentLabel(group.review)}</span>
              <span className={`ml-auto shrink-0 text-[9.5px] font-semibold px-1.5 py-px rounded-full border ${
                group.waitingOn === 'you'
                  ? 'text-peach border-peach/40 bg-peach/10'
                  : group.waitingOn === 'agent'
                    ? 'text-blue border-blue/40 bg-blue/10'
                    : 'text-green border-green/40 bg-green/10'
              }`}>
                {group.waitingOn === 'you'
                  ? `${group.addressedCount} for you`
                  : group.waitingOn === 'agent'
                    ? `${group.openCount} with the agent`
                    : 'closed'}
              </span>
            </button>
            {!collapsed && group.notes.map((note) => {
              const status = checklistStatus(note)
              return (
                <div
                  key={note.id}
                  className="px-3 py-2 border-t border-surface0/60 hover:bg-surface0/40"
                  onMouseEnter={() => hoverChecklistNote(note)}
                  onMouseLeave={() => hoverChecklistNote(null)}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[10px] uppercase tracking-wide ${SCOPE_BADGE[note.scope]}`}>{note.scope}</span>
                    {/* The "Review #N" tag that used to live here is gone: the
                        row now sits UNDER its review's header, so repeating it
                        on every note was the flat list showing through. */}
                    {/* The agent said it acted on this one (canvas_resolve). The
                        verdict is still the user's — the buttons below stay —
                        but the row says which notes are waiting on THEM rather
                        than on the agent, so a review finished in chat does not
                        look like five things nobody did. */}
                    {note.state === 'addressed' && (
                      <span
                        className="text-[10px] px-1 py-0.5 rounded border text-mauve border-mauve/40 bg-mauve/10"
                        title="The agent marked this note as addressed. Approve if the change is right, re-annotate if it is not."
                        data-testid="note-addressed-chip"
                      >
                        addressed
                      </span>
                    )}
                    <span
                      className={`ml-auto text-[10px] px-1 py-0.5 rounded border ${
                        status.kind === 'ghost'
                          ? 'text-yellow border-yellow/40 bg-yellow/10'
                          : status.kind === 'reported'
                            ? 'text-blue border-blue/40 bg-blue/10'
                            : 'text-green border-green/40 bg-green/10'
                      }`}
                      title={status.kind === 'reported' ? PAGE_REPORTED_TITLE : undefined}
                    >
                      {status.text}
                    </span>
                  </div>
                  {note.focus && <FocusLabel focus={note.focus} className="text-subtext1 truncate mt-0.5 block" />}
                  <div className="text-text/90 mt-0.5 line-clamp-3 whitespace-pre-wrap">{note.note}</div>
                  <div className="flex gap-1.5 mt-1.5">
                    <button
                      onClick={() => void resolveNote(sessionId, note.id, 'approve')}
                      className="px-1.5 py-0.5 text-[10px] rounded border border-green/40 text-green hover:bg-green/10"
                      title="The agent addressed this note"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => void resolveNote(sessionId, note.id, 'reannotate')}
                      className="px-1.5 py-0.5 text-[10px] rounded border border-peach/40 text-peach hover:bg-peach/10"
                      title="Not addressed — write a follow-up note linked to this one"
                    >
                      Re-annotate
                    </button>
                    <button
                      onClick={() => void resolveNote(sessionId, note.id, 'dismiss')}
                      className="px-1.5 py-0.5 text-[10px] rounded border border-surface1 text-overlay1 hover:bg-surface0"
                      title="Drop this note without action"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )
            })}
            {/* Close the whole round at once. Offered ONLY when every remaining
                note is 'addressed' -- i.e. the agent says it did all of them and
                has already summarised that in chat. While anything is still open
                there is nothing here for the user to decide, and a bulk button
                would just be a way to approve work nobody claims to have done.
                Dismiss is two-step, because it drops notes without action. */}
            {!collapsed && group.waitingOn === 'you' && group.notes.length > 1 && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-surface0/60">
                <button
                  onClick={() => void resolveGroup(group, 'approve')}
                  disabled={busyReviewId === group.review.id}
                  className="px-2 py-0.5 text-[10px] font-semibold rounded border border-green/40 text-green bg-green/10 hover:bg-green/20 disabled:opacity-40"
                  title="Mark every remaining note in this round as done. The agent has already said it addressed them."
                  data-testid="review-approve-rest"
                >
                  Approve all {group.addressedCount} as done
                </button>
                <div className="flex-1" />
                {confirmDismissId === group.review.id ? (
                  <button
                    onClick={() => void resolveGroup(group, 'dismiss')}
                    disabled={busyReviewId === group.review.id}
                    className="px-2 py-0.5 text-[10px] font-semibold rounded border border-red/50 text-red bg-red/15 hover:bg-red/25 disabled:opacity-40"
                    title="Drop these notes without action. They will not come back."
                    data-testid="review-dismiss-rest-confirm"
                  >
                    Drop {group.addressedCount} without action
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmDismissId(group.review.id)}
                    className="px-2 py-0.5 text-[10px] rounded border border-surface1 text-overlay1 hover:text-red"
                    title="Drop the remaining notes in this round without action"
                    data-testid="review-dismiss-rest"
                  >
                    Dismiss the rest
                  </button>
                )}
              </div>
            )}
          </div>
          )
        })}

        {/* ── Composer ── */}
        <div className="px-3 py-2 border-b border-surface0">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className={`text-[10px] uppercase tracking-wide ${SCOPE_BADGE[editingNote ? editingNote.scope : composerScope]}`}>
              {editingNote ? editingNote.scope : composerScope}
            </span>
            {(editingNote ? editingNote.focus : focus) ? (
              <FocusLabel focus={(editingNote ? editingNote.focus : focus)!} className="text-subtext1 truncate flex-1" />
            ) : (
              <span className="text-overlay1 flex-1">whole page{editingNote ? '' : ' — click an element or drag a region to target'}</span>
            )}
            {!editingNote && focus && (
              <>
                {canExpand && (
                  <button
                    onClick={() => expandFocus(sessionId)}
                    className="px-1 py-0.5 text-[10px] rounded border border-surface1 text-overlay1 hover:text-text"
                    title="Expand selection to the parent element (ArrowUp)"
                  >
                    ↑ parent
                  </button>
                )}
                <button
                  onClick={() => clearFocus(sessionId)}
                  className="px-1 py-0.5 text-[10px] rounded border border-surface1 text-overlay1 hover:text-text"
                  title="Clear the selection (Esc)"
                >
                  ✕
                </button>
              </>
            )}
          </div>
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder={editingNote ? 'Edit this note…' : 'Write a note for the agent…'}
            rows={3}
            className="w-full resize-y rounded bg-surface0/60 border border-surface1/60 px-2 py-1.5 text-text placeholder:text-overlay0 focus:outline-none focus:border-overlay1"
          />
          <div className="flex items-center gap-1.5 mt-1.5">
            <button
              onClick={attachSelection}
              className={`px-1.5 py-0.5 text-[10px] rounded border ${
                attachedSketch ? 'border-mauve/50 text-mauve bg-mauve/10' : 'border-surface1 text-overlay1 hover:text-text'
              }`}
              title="Attach the glass elements currently selected in Draw mode to this note"
            >
              {attachedSketch ? `sketch: ${attachedSketch.excalidrawElementIds.length} element(s)` : 'Attach selected sketch'}
            </button>
            {attachedSketch && (
              <button
                onClick={() => setAttachedSketch(null)}
                className="px-1 py-0.5 text-[10px] rounded border border-surface1 text-overlay1 hover:text-text"
                title="Detach the sketch"
              >
                ✕
              </button>
            )}
            <div className="flex-1" />
            {editingNote && (
              <button onClick={cancelEdit} className="px-2 py-0.5 text-[11px] rounded border border-surface1 text-overlay1 hover:text-text">
                Cancel
              </button>
            )}
            <button
              onClick={() => void saveNote()}
              disabled={noteText.trim().length === 0}
              className="px-2 py-0.5 text-[11px] rounded border border-blue/50 text-blue hover:bg-blue/10 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {editingNote ? 'Save' : 'Add note'}
            </button>
          </div>
        </div>

        {/* ── Draft notes ── */}
        {draftNotes.length > 0 && (
          <div>
            <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-subtext0">Pending notes</div>
            {draftNotes.map((note) => (
              <div
                key={note.id}
                className={`px-3 py-2 border-t border-surface0/60 hover:bg-surface0/40 ${editingId === note.id ? 'bg-surface0/60' : ''}`}
                onMouseEnter={() => note.focus && setPanelHighlight(sessionId, { rect: note.focus.bboxPage, kind: 'anchored' })}
                onMouseLeave={() => setPanelHighlight(sessionId, null)}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`text-[10px] uppercase tracking-wide ${SCOPE_BADGE[note.scope]}`}>{note.scope}</span>
                  {note.sketch && <span className="text-[10px] text-mauve">✎ sketch</span>}
                  <div className="flex-1" />
                  <button
                    onClick={() => setEditing(sessionId, note.id)}
                    className="text-[10px] text-overlay1 hover:text-text"
                    title="Edit this note"
                  >
                    edit
                  </button>
                  <button
                    onClick={() => void deleteNote(sessionId, note.id)}
                    className="text-[10px] text-overlay1 hover:text-red"
                    title="Delete this note"
                  >
                    delete
                  </button>
                </div>
                {note.focus && <FocusLabel focus={note.focus} className="text-subtext1 truncate mt-0.5 block" />}
                <div className="text-text/90 mt-0.5 line-clamp-3 whitespace-pre-wrap">{note.note}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Submit ── */}
      <div className="px-3 py-2 border-t border-surface0 shrink-0">
        {justSubmitted ? (
          <div className="flex items-center gap-2">
            <span className="text-green text-[11px]">
              Review #{justSubmitted.id.slice(1)} submitted — {justSubmitted.count} note{justSubmitted.count === 1 ? '' : 's'}
            </span>
            <div className="flex-1" />
            <button
              onClick={() => {
                if (returnTimerRef.current) { clearTimeout(returnTimerRef.current); returnTimerRef.current = null }
                onReturnToTerminal()
              }}
              className="px-2 py-1 text-[11px] rounded border border-blue/50 text-blue hover:bg-blue/10"
              title="Returning automatically — click to go now"
            >
              Return to terminal
            </button>
          </div>
        ) : (
          <>
            {submitError && <div className="text-red text-[10px] mb-1">{submitError}</div>}
            <button
              onClick={() => void doSubmit()}
              disabled={!draftReview || draftNotes.length === 0 || submitting}
              className="w-full px-2 py-1.5 text-[12px] rounded border border-green/50 text-green hover:bg-green/10 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Freeze this review and hand it to the agent"
            >
              {submitting
                ? 'Submitting…'
                : draftNotes.length > 0
                  ? `Submit review — ${draftNotes.length} note${draftNotes.length === 1 ? '' : 's'}`
                  : 'Submit review'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
