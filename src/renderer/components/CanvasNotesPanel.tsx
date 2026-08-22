import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { exportToBlob } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { Annotation, CanvasSketchExport, CanvasVersion, FocusObject, Rect } from '../../shared/canvas'
import {
  draftAnnotationsOf,
  draftReviewOf,
  notesWaitingOnYou,
  reviewGroupsOf,
  roundsWaitingOnYou,
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
  /**
   * Is this panel the one the user is actually looking at?
   *
   * Every session renders its own pane and the inactive ones are hidden with
   * CSS, so being MOUNTED proves nothing about being seen. This is the session
   * being the active one on the sessions view — and it is load-bearing, not
   * cosmetic: it gates the "the user has seen this round addressed" report that
   * releases the agent's close-out barrier. Defaults to false at every call
   * site that does not know, which fails closed (the barrier stays shut and the
   * user closes the round themselves).
   */
  isActive: boolean
}

/**
 * How long an addressed round must be ON SCREEN before it counts as SEEN.
 *
 * The close-out barrier's release is a claim about the user's eyes, so the
 * report has to be worth something: a note that appeared for one frame during a
 * re-render, or while the pane was mounted behind another view, has not been
 * read by anybody. A second and a half of continuous visibility in the active,
 * visible window is a modest claim that is actually true.
 *
 * Note where this dwell lives — on the USER's side, measuring the user's
 * exposure. The dwell it replaces sat on the agent's side and measured the
 * agent's patience, which an unattended agent simply spends.
 */
const SEEN_DWELL_MS = 1500

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

/**
 * What happened to a closed note — and, as load-bearing as the verdict itself,
 * WHO said so.
 *
 * The agent can reach two of these three states (`stale`, `dismissed`) when the
 * user tells it to, so a row that showed only the verdict would let "the agent
 * closed this because you asked" and "you decided this yourself" read
 * identically. `approved` is the user's alone — the store refuses a record that
 * claims otherwise — so it can never carry the agent's name here.
 */
export function closedLabel(note: Annotation): string {
  const verdict =
    note.state === 'approved' ? 'approved' : note.state === 'stale' ? 'closed — work shipped' : 'dismissed'
  if (note.closedBy === 'agent') return `${verdict} · by the agent on your instruction`
  if (note.closedBy === 'user') return `${verdict} · by you`
  // A record from before close-out existed. Says the verdict and claims
  // nothing about who gave it, which is all that is actually known.
  return verdict
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
export default function CanvasNotesPanel({ sessionId, version, getGlassApi, onReturnToTerminal, isActive }: Props) {
  const state = useCanvasReviewStore((s) => s.bySessionId[sessionId])
  const refresh = useCanvasReviewStore((s) => s.refresh)
  const markAddressedSeen = useCanvasReviewStore((s) => s.markAddressedSeen)
  const upsertNote = useCanvasReviewStore((s) => s.upsertNote)
  const deleteNote = useCanvasReviewStore((s) => s.deleteNote)
  const submitReview = useCanvasReviewStore((s) => s.submitReview)
  const resolveNote = useCanvasReviewStore((s) => s.resolveNote)
  const reopenNote = useCanvasReviewStore((s) => s.reopenNote)
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
   *  becomes closed folds itself away without the user having to tidy up.
   *
   *  Keyed by CANVAS as well as review, because a review id is ordinal within
   *  its own canvas — every canvas has an R1. The panel does not remount when
   *  the session switches canvases, so keying on the review id alone carried
   *  "R2 is collapsed" from the canvas you left onto the one you arrived at.
   *  Switching back still finds your toggles where you left them. */
  const [groupOverride, setGroupOverride] = useState<Record<string, boolean>>({})
  const overrideKey = useCallback(
    (reviewId: string) => `${state?.canvasId ?? ''}:${reviewId}`,
    [state?.canvasId],
  )
  const isGroupCollapsed = useCallback(
    (g: ReviewGroup) => groupOverride[overrideKey(g.review.id)] ?? g.waitingOn === 'closed',
    [groupOverride, overrideKey],
  )
  const toggleGroup = useCallback((reviewId: string, defaultCollapsed: boolean) => {
    const key = overrideKey(reviewId)
    setGroupOverride((prev) => ({ ...prev, [key]: !(prev[key] ?? defaultCollapsed) }))
  }, [overrideKey])
  const [busyReviewId, setBusyReviewId] = useState<string | null>(null)
  const [confirmDismissId, setConfirmDismissId] = useState<string | null>(null)
  /** Two-step, like every other bulk action here: the first click arms, the
   *  second does it and says how many. Nothing is deleted either way. */
  const [closeAllArmed, setCloseAllArmed] = useState(false)
  const [closingAll, setClosingAll] = useState(false)
  /** Which rounds have their Closed list expanded. Closed work is kept, not
   *  hidden — but it folds away by default so it does not bury what is live. */
  const [closedOpen, setClosedOpen] = useState<Record<string, boolean>>({})

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
   * Resolve a snapshotted list of note ids one at a time, ABORTING the moment
   * the session's canvas changes underneath the loop.
   *
   * `annotationResolve` takes only an annotation id, and main resolves it
   * against whatever canvas the session points at RIGHT NOW. Annotation ids
   * restart at a1 on every canvas, and an agent's `canvas_render` naming a
   * different subject files the current canvas mid-flight. Without this check a
   * bulk pass carries on against the new canvas and marks whichever a4 / a7 /
   * … happen to exist there as closed, under the user's own name, on notes
   * they never looked at. The ids were captured for one canvas; when that
   * canvas is gone, so is the rest of the pass.
   */
  const resolveEach = useCallback(
    async (ids: string[], action: 'approve' | 'dismiss' | 'stale') => {
      const canvasNow = () => useCanvasReviewStore.getState().bySessionId[sessionId]?.canvasId ?? null
      const startedOn = canvasNow()
      // No canvas, nothing this pass could have been composed against.
      if (!startedOn) return
      for (const id of ids) {
        // The pre-flight check stops the REST of the pass. It cannot stop the
        // one note already in flight when the canvas changes — the check and
        // the write it authorises are separated by an await. So the canvas the
        // pass started on travels WITH each call, and main refuses any write
        // that arrives after the session has moved on; the residual one-note
        // window closes there, inside the same synchronous mutation.
        if (canvasNow() !== startedOn) break
        await resolveNote(sessionId, id, action, startedOn)
      }
    },
    [resolveNote, sessionId],
  )

  /** One note, one click. The canvas is read at CLICK time — that is the one
   *  the user is looking at — and travels with the call so main can refuse the
   *  write if the session moves between the click and the handler. */
  const resolveOne = useCallback(
    (annotationId: string, action: 'approve' | 'dismiss' | 'reannotate' | 'stale') => {
      const on = useCanvasReviewStore.getState().bySessionId[sessionId]?.canvasId ?? null
      if (!on) return
      void resolveNote(sessionId, annotationId, action, on)
    },
    [resolveNote, sessionId],
  )

  /**
   * Report to main that the user has these addressed notes ON SCREEN.
   *
   * This is the release side of the agent's close-out barrier: until the user
   * has seen a note in its addressed state, `canvas_verdict` refuses to close
   * it and the agent is told to hand back. The report is therefore a claim
   * about the user's eyes, and every condition here exists to keep that claim
   * honest:
   *
   *   - `isActive`: every session mounts its own pane, hidden with CSS. Mounted
   *     is not seen.
   *   - the document being VISIBLE: a minimised or background window shows
   *     nobody anything.
   *   - `SEEN_DWELL_MS` of both, uninterrupted: a row that flashed past during
   *     a re-render was not read.
   *
   * Only notes not already marked are sent, so the steady state is an empty
   * list and no IPC — the effect cannot feed itself through the refresh its own
   * write triggers.
   */
  const unseenAddressedIds = useMemo(
    () =>
      (state?.annotations ?? [])
        .filter((a) => a.state === 'addressed' && a.userSawAddressed !== true)
        .map((a) => a.id),
    [state?.annotations],
  )
  /** Identity that changes only when the SET does, so the dwell is not restarted
   *  by every unrelated store commit. */
  const unseenKey = unseenAddressedIds.join(',')
  const canvasId = state?.canvasId ?? null

  /** Window visibility as state, so a window hidden mid-dwell RESTARTS the dwell
   *  when it comes back rather than leaving a cancelled timer nobody re-arms. */
  const [windowVisible, setWindowVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  )
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisibility = (): void => setWindowVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    if (!isActive || !windowVisible || !canvasId || unseenKey === '') return
    const ids = unseenKey.split(',')
    const timer = setTimeout(() => {
      void markAddressedSeen(sessionId, canvasId, ids)
    }, SEEN_DWELL_MS)
    return () => clearTimeout(timer)
  }, [isActive, windowVisible, canvasId, unseenKey, sessionId, markAddressedSeen])

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
    async (group: ReviewGroup, action: 'approve' | 'dismiss' | 'stale') => {
      // `closingAll` too: the header's bulk pass is already walking these same
      // notes, and two loops interleaving means each resolve lands on a note
      // the other has consumed.
      if (busyReviewId || closingAll) return
      setBusyReviewId(group.review.id)
      try {
        // Snapshot the ids first: `group` is derived from the store, which each
        // resolve mutates underneath us.
        const ids = group.notes.filter((n) => n.state === 'addressed').map((n) => n.id)
        await resolveEach(ids, action)
      } finally {
        setBusyReviewId(null)
        setConfirmDismissId(null)
      }
    },
    [busyReviewId, closingAll, resolveEach],
  )

  /** Every round waiting on YOU, and the notes in them. The scope rule for the
   *  bulk button, derived in one place so the label and the action cannot
   *  disagree about what "waiting on me" means. */
  const waitingRounds = useMemo(() => roundsWaitingOnYou(groups), [groups])
  const waitingNotes = useMemo(() => notesWaitingOnYou(groups), [groups])

  /** Any verdict pass in flight locks EVERY verdict control, not just the one
   *  that started it. Two loops over the same notes interleave otherwise, and
   *  each resolve lands on a note the other has already consumed. */
  const actionsLocked = busyReviewId !== null || closingAll

  /**
   * "Close all rounds waiting on me."
   *
   * Marks every one of those notes STALE — the work moved on — not approved.
   * Sequential for the same reason `resolveGroup` is: each resolve commits the
   * mirror main returns, so parallel calls would overwrite each other. Ids are
   * snapshotted up front because the list they came from is re-derived on every
   * commit.
   */
  const closeAllWaiting = useCallback(async () => {
    if (closingAll || busyReviewId) return
    const ids = waitingNotes.map((n) => n.id)
    if (ids.length === 0) return
    setClosingAll(true)
    try {
      await resolveEach(ids, 'stale')
    } finally {
      setClosingAll(false)
      setCloseAllArmed(false)
    }
  }, [closingAll, busyReviewId, waitingNotes, resolveEach])

  // A round that stops waiting on you (the agent re-opened it, or you cleared
  // it) must not leave the button armed for a set that no longer exists.
  useEffect(() => {
    if (waitingNotes.length === 0 && closeAllArmed) setCloseAllArmed(false)
  }, [waitingNotes.length, closeAllArmed])

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

      {/* ── Close out everything waiting on YOU ──
          The pill counts rounds the agent has finished and only your verdict
          can close, and until now there was no way to clear them in one go —
          not from here, and not by telling the agent. This is that way. It
          writes STALE ("the work moved on"), never approved: nothing here
          claims you reviewed anything. Nothing is deleted either — every note
          keeps its text and a Reopen, which is what makes one click safe. */}
      {waitingNotes.length > 0 && (
        <div className="px-3 py-1.5 border-b border-surface0 flex items-center gap-2 shrink-0 bg-peach/5" data-testid="close-all-waiting">
          <span className="text-[11px] text-subtext0 truncate">
            {waitingRounds.length} round{waitingRounds.length === 1 ? '' : 's'} waiting on you
          </span>
          <div className="flex-1" />
          {closeAllArmed ? (
            <>
              <button
                onClick={() => setCloseAllArmed(false)}
                className="px-1.5 py-0.5 text-[10px] rounded border border-surface1 text-overlay1 hover:text-text focus-ring"
              >
                Cancel
              </button>
              <button
                onClick={() => void closeAllWaiting()}
                disabled={closingAll}
                data-testid="close-all-waiting-confirm"
                className="px-2 py-0.5 text-[10px] font-semibold rounded border border-peach/50 text-peach bg-peach/15 hover:bg-peach/25 disabled:opacity-40 focus-ring"
                title="Marks them as closed because the work moved on — not as approved. Each one can be reopened."
              >
                {closingAll ? 'Closing…' : `Close ${waitingNotes.length} note${waitingNotes.length === 1 ? '' : 's'}`}
              </button>
            </>
          ) : (
            <button
              onClick={() => setCloseAllArmed(true)}
              data-testid="close-all-waiting-arm"
              className="px-2 py-0.5 text-[10px] rounded border border-surface1 text-subtext0 hover:text-text focus-ring"
              title="Close every round that is waiting on you. They are marked as closed because the work moved on — never as approved — and nothing is deleted."
            >
              Close all waiting on me
            </button>
          )}
        </div>
      )}

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
                      onClick={() => resolveOne(note.id, 'approve')}
                      disabled={actionsLocked}
                      className="px-1.5 py-0.5 text-[10px] rounded border border-green/40 text-green hover:bg-green/10 disabled:opacity-40"
                      title="The agent addressed this note"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => resolveOne(note.id, 'reannotate')}
                      disabled={actionsLocked}
                      className="px-1.5 py-0.5 text-[10px] rounded border border-peach/40 text-peach hover:bg-peach/10 disabled:opacity-40"
                      title="Not addressed — write a follow-up note linked to this one"
                    >
                      Re-annotate
                    </button>
                    {/* The close-out verdict, and deliberately NOT a second
                        Approve: "the work this asked about shipped" is a
                        different claim from "I checked it and it is right",
                        and only the second is an approval. */}
                    <button
                      onClick={() => resolveOne(note.id, 'stale')}
                      disabled={actionsLocked}
                      className="px-1.5 py-0.5 text-[10px] rounded border border-peach/40 text-peach hover:bg-peach/10 disabled:opacity-40"
                      title="The work this note was about has shipped — close it without calling it approved"
                      data-testid="note-close-stale"
                    >
                      Close
                    </button>
                    <button
                      onClick={() => resolveOne(note.id, 'dismiss')}
                      disabled={actionsLocked}
                      className="px-1.5 py-0.5 text-[10px] rounded border border-surface1 text-overlay1 hover:bg-surface0 disabled:opacity-40"
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
                  disabled={actionsLocked}
                  className="px-2 py-0.5 text-[10px] font-semibold rounded border border-green/40 text-green bg-green/10 hover:bg-green/20 disabled:opacity-40"
                  title="Mark every remaining note in this round as done. The agent has already said it addressed them."
                  data-testid="review-approve-rest"
                >
                  Approve all {group.addressedCount} as done
                </button>
                {/* For a round whose work has already gone out. Says what it
                    means — the thing was built — rather than borrowing the
                    word for a judgement nobody is making. */}
                <button
                  onClick={() => void resolveGroup(group, 'stale')}
                  disabled={actionsLocked}
                  className="px-2 py-0.5 text-[10px] rounded border border-peach/40 text-peach hover:bg-peach/10 disabled:opacity-40"
                  title="The work in this round has shipped. Closes all of it without calling any of it approved; each note can be reopened."
                  data-testid="review-accept-as-built"
                >
                  Accept as built
                </button>
                <div className="flex-1" />
                {confirmDismissId === group.review.id ? (
                  <button
                    onClick={() => void resolveGroup(group, 'dismiss')}
                    disabled={actionsLocked}
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

            {/* ── Closed ──
                Cleared, not deleted. Everything ruled on in this round is still
                here with its text, and every row says WHO closed it — because
                "the agent closed this because you told it to" and "you approved
                this" are different facts, and the second is the only one that
                is an approval. Reopen is one click, which is what makes a bulk
                close something a person can risk. */}
            {!collapsed && group.closedNotes.length > 0 && (
              <div className="border-t border-surface0/60" data-testid="review-closed-section">
                <button
                  type="button"
                  onClick={() => setClosedOpen((p) => ({ ...p, [overrideKey(group.review.id)]: !p[overrideKey(group.review.id)] }))}
                  className="w-full flex items-center gap-1.5 px-3 py-1 text-left hover:bg-surface0/40 focus-ring"
                  aria-expanded={!!closedOpen[overrideKey(group.review.id)]}
                  data-testid="review-closed-toggle"
                >
                  <span className="text-[10px] text-overlay1">
                    Closed · {group.closedNotes.length}
                  </span>
                  {group.agentClosedCount > 0 && (
                    <span
                      className="text-[9.5px] px-1 py-px rounded border text-mauve border-mauve/40 bg-mauve/10"
                      title="Closed by the agent on your instruction — not approved. Reopen any of them below."
                      data-testid="review-agent-closed-chip"
                    >
                      {group.agentClosedCount} on your instruction
                    </span>
                  )}
                  <div className="flex-1" />
                  <span className="text-[10px] text-overlay0">{closedOpen[overrideKey(group.review.id)] ? 'hide' : 'show'}</span>
                </button>
                {closedOpen[overrideKey(group.review.id)] && group.closedNotes.map((note) => (
                  <div key={note.id} className="px-3 py-1.5 border-t border-surface0/40" data-testid="review-closed-note">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[10px] uppercase tracking-wide ${SCOPE_BADGE[note.scope]}`}>{note.scope}</span>
                      <span className="text-[10px] text-overlay1">{closedLabel(note)}</span>
                      <div className="flex-1" />
                      <button
                        onClick={() => void reopenNote(sessionId, note.id)}
                        className="px-1.5 py-0.5 text-[10px] rounded border border-surface1 text-overlay1 hover:text-text focus-ring"
                        title="Put this note back in play, exactly where it was before it was closed"
                        data-testid="review-reopen-note"
                      >
                        Reopen
                      </button>
                    </div>
                    <div className="text-text/60 mt-0.5 line-clamp-2 whitespace-pre-wrap">{note.note}</div>
                    {/* The residual risk, said out loud on the row it applies to.
                        The agent's close-out precondition is a state the agent
                        itself writes (canvas_resolve), so on an agent-closed
                        note the same party did the work AND ended the
                        conversation about it. The store refuses the two in one
                        pass, but it cannot see whether the user actually asked —
                        that instruction lives in chat. So the row says who did
                        what, and Reopen sits next to it. */}
                    {note.closedBy === 'agent' && note.closedFrom === 'addressed' && (
                      <div className="text-[9.5px] text-overlay0 mt-0.5" data-testid="review-closed-agent-both">
                        the agent marked this addressed and closed it — nobody else checked it
                      </div>
                    )}
                  </div>
                ))}
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
