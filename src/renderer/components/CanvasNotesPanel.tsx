import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { exportToBlob } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { Annotation, CanvasSketchExport, CanvasVersion, Rect } from '../../shared/canvas'
import {
  draftAnnotationsOf,
  draftReviewOf,
  openSubmittedNotesOf,
  useCanvasReviewStore,
} from '../stores/canvasReviewStore'

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

const SCOPE_BADGE: Record<Annotation['scope'], string> = {
  element: 'text-blue',
  region: 'text-peach',
  general: 'text-overlay1',
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
  const openNotes = state ? openSubmittedNotesOf(state) : []

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
    } finally {
      setSubmitting(false)
    }
  }, [draftReview, draftNotes, submitting, getGlassApi, sessionId, submitReview, upsertNote])

  const checklistStatus = useCallback(
    (note: Annotation): { text: string; kind: 'anchored' | 'ghost' | 'current'; rect: Rect | null } => {
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
        return { text: entry.via === 'ux-id' ? 're-anchored' : 're-anchored (fingerprint)', kind: 'anchored', rect: entry.box }
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
      setPanelHighlight(
        sessionId,
        status.rect ? { rect: status.rect, kind: status.kind === 'anchored' || status.kind === 'current' ? 'anchored' : 'ghost' } : null,
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

        {/* ── Resolution checklist (spec §6 step 2) ── */}
        {openNotes.length > 0 && (
          <div className="border-b border-surface0">
            <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-subtext0">
              Open notes from earlier reviews
            </div>
            {openNotes.map((note) => {
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
                    <span className="text-overlay1 text-[10px]">{note.reviewId.replace('R', 'Review #')}</span>
                    <span
                      className={`ml-auto text-[10px] px-1 py-0.5 rounded border ${
                        status.kind === 'ghost'
                          ? 'text-yellow border-yellow/40 bg-yellow/10'
                          : 'text-green border-green/40 bg-green/10'
                      }`}
                    >
                      {status.text}
                    </span>
                  </div>
                  {note.focus && <div className="text-subtext1 truncate mt-0.5">{note.focus.label}</div>}
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
          </div>
        )}

        {/* ── Composer ── */}
        <div className="px-3 py-2 border-b border-surface0">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className={`text-[10px] uppercase tracking-wide ${SCOPE_BADGE[editingNote ? editingNote.scope : composerScope]}`}>
              {editingNote ? editingNote.scope : composerScope}
            </span>
            {(editingNote ? editingNote.focus : focus) ? (
              <span className="text-subtext1 truncate flex-1" title={(editingNote ? editingNote.focus : focus)?.label}>
                {(editingNote ? editingNote.focus : focus)?.label}
              </span>
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
                {note.focus && <div className="text-subtext1 truncate mt-0.5">{note.focus.label}</div>}
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
              onClick={onReturnToTerminal}
              className="px-2 py-1 text-[11px] rounded border border-blue/50 text-blue hover:bg-blue/10"
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
