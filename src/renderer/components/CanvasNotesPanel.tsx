import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { exportToBlob } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type {
  Annotation,
  CanvasSketchExport,
  CanvasSketchScene,
  CanvasVersion,
  FocusObject,
  Rect,
  TrailEntry,
} from '../../shared/canvas'
import {
  MAX_NOTE_IMAGES,
  MAX_SKETCH_SCENE_BYTES,
  MAX_SKETCH_SCENE_ELEMENTS,
  artifactPhaseOf,
  artifactRunContaining,
  artifactRuns,
} from '../../shared/canvas'
import { trailClockTime } from '../../shared/canvas-review-serialize'
import {
  draftAnnotationsOf,
  draftReviewOf,
  reviewGroupsOf,
  settledLabel,
  useCanvasReviewStore,
  type ReviewGroup,
} from '../stores/canvasReviewStore'
import { PAGE_REPORTED_MARK, PAGE_REPORTED_TITLE } from '../canvas/page-reported'
import { useCanvasStore } from '../stores/canvasStore'
import { useExcalidrawStore } from '../stores/excalidrawStore'
import { imageFileFromClipboard, pastedImageToPng } from '../utils/canvasPasteImage'
import { DismissButton } from './ui/DismissButton'

/**
 * Testing mode's evidence seam (M3) — the pane's half, as the panel sees it.
 *
 * The split is not arbitrary. The PANE owns the frame, the screenshot, the pause
 * shield and the action trail, because all four are facts about the page under
 * review. The PANEL owns the composer, its persistence and the note record. This
 * interface is the whole of what passes between them, and it is `undefined`
 * outside Testing mode — so "a mockup never captures anything" is enforced by
 * the shape of the props rather than by a condition somebody has to remember at
 * five call sites.
 */
export interface CanvasEvidenceSeam {
  /** The capture waiting to be locked to the note being written, or null when
   *  the site is live. Its presence IS the paused state. */
  pending: { evidenceId: string; previewDataUrl?: string } | null
  /** Why the last capture did not happen, in plain words. */
  notice: string | null
  /** A note is starting — freeze the site and take the shot. Idempotent: the
   *  four things that start a note can all happen in one breath. */
  begin: () => void
  /** The note was abandoned: delete the pending shot and unpause. */
  discard: () => void
  /** The note took it — main has moved the file onto `annotationId`. */
  lock: (annotationId: string) => void
  /** A capture that survived a pane switch, named by the restored draft. */
  adopt: (evidenceId: string) => void
  /** Hand the pane a way to cancel the note, so Escape on the shield does
   *  exactly what the composer's Cancel does. Pass null on unmount. */
  registerCancel: (fn: (() => void) | null) => void
  /** The WHOLE run's trail, for the submit. */
  runTrail: () => TrailEntry[]
  /** The run is over — the trail starts again from nothing. */
  endRun: () => void
}

interface Props {
  sessionId: string
  /**
   * The canvas the PANE is showing — the id its surface is keyed by, so it is
   * fixed for the life of this mount.
   *
   * The review mirror carries a canvas id too, and during a switch the two
   * disagree for a beat. Every composer read, write and restore is gated on them
   * AGREEING: a draft written against the canvas the user just left, or restored
   * from the one they are arriving at before its notes have loaded, is a draft
   * on the wrong canvas.
   */
  canvasId: string
  version: CanvasVersion
  /** Read at call time — the glass remounts with the pane. */
  getGlassApi: () => ExcalidrawImperativeAPI | null
  /** C1: the live scene PLUS the pane's foreign-version sketch stash, so a
   *  note's sketch exports whichever version is on screen at submit. Required:
   *  the pane always passes it, and the pre-C1 fallback it used to have was a
   *  quieter way of exporting the wrong version's strokes. */
  getAllSketchElements: () => ReturnType<ExcalidrawImperativeAPI['getSceneElements']>
  /** One-click return to the terminal after submit (spec D3). */
  onReturnToTerminal: () => void
  /**
   * Is this panel the one the user is actually looking at?
   *
   * Every session renders its own pane and the inactive ones are hidden with
   * CSS, so being MOUNTED proves nothing about being seen. This is the session
   * being the active one on the sessions view — and it is load-bearing, not
   * cosmetic: it gates the "the user has seen this round addressed" report that
   * releases the agent's close-out barrier, and the window paste listener.
   * Defaults to false at every call site that does not know, which fails closed.
   */
  isActive: boolean
  /** Hide the panel (item C): the page takes the full width and a thin rail
   *  keeps the way back. Owned by the pane, since the panel does not control
   *  its own column; optional so other mounts need not wire it. */
  onHide?: () => void
  /** Testing mode only (M3) — see CanvasEvidenceSeam. Absent everywhere else,
   *  and every evidence path in this file is gated on its presence. */
  evidence?: CanvasEvidenceSeam

  // ── The glass, as the pane exposes it (M2 shared contract) ────────────────
  // Drawings RIDE THE NOTE now (W16): there is no "attach selected sketch"
  // button, so the panel has to be able to ask which strokes on the displayed
  // version are not yet spoken for, and to tell the pane it has taken them.
  /** Glass elements on the DISPLAYED version not yet attached to any note. */
  getUnattachedSketchElementIds: () => string[]
  /** Claim those ids, so the next note does not take them a second time. */
  markSketchElementsAttached: (ids: string[]) => void
  /** The glass, serialised for the persisted composer draft (W14/W20). */
  getSketchSceneForPersist: () => CanvasSketchScene | null
  /**
   * Put a persisted scene back on the glass. Returns whether it actually CHANGED
   * the glass.
   *
   * The answer is load-bearing, not a courtesy: the panel has to ignore exactly
   * one `sketchRevision` bump after a restore (its own echo through the glass's
   * onChange), and a restore that changed nothing produces no bump — so arming
   * that suppression unconditionally leaves it waiting, and the next bump it
   * eats is the user's FIRST REAL STROKE. That stroke then never marks the draft
   * dirty and never reaches disk.
   */
  restoreSketchScene: (scene: CanvasSketchScene) => boolean
  /**
   * Bumped by the pane whenever the glass changes (throttled from Excalidraw's
   * `onChange`).
   *
   * The panel cannot observe the glass — it is the pane's, and `getUnattached…`
   * is a plain function call, not reactive state. Without this the stroke count
   * was read once per render and nothing re-rendered when the user drew, so Add
   * note stayed dead after a drawing and a drawing-only draft never reached
   * disk. A counter rather than the scene itself: the panel needs to know THAT
   * it changed, never what changed.
   */
  sketchRevision: number
}

/**
 * How long an addressed round must be ON SCREEN before it counts as SEEN.
 *
 * The close-out barrier's release is a claim about the user's eyes, so the
 * report has to be worth something: a note that appeared for one frame during a
 * re-render, or while the pane was mounted behind another view, has not been
 * read by anybody. A second and a half of continuous visibility in the active,
 * visible window is a modest claim that is actually true.
 */
const SEEN_DWELL_MS = 1500

/**
 * How long typing settles before the composer is written to disk.
 *
 * Long enough that a sentence is one write rather than forty; short enough that
 * a user who types a line and immediately switches panes keeps it. The saves
 * that cost REAL bytes — a paste, an image removed — do not wait for this at
 * all: they go immediately, because those are the ones whose loss is expensive.
 */
export const COMPOSER_SAVE_DEBOUNCE_MS = 400

/** A stable empty list, so a component reading `versions ?? NO_VERSIONS` does
 *  not hand its effects a fresh array identity on every commit. */
const NO_VERSIONS: readonly CanvasVersion[] = []

/**
 * Will this drawing fit in the persisted draft?
 *
 * Checked in the RENDERER, before the IPC, because main refuses an oversized
 * scene for the whole call — and a refusal at the seam takes the note's text
 * down with the drawing. Both bounds are the shared ones main enforces, so the
 * two can never disagree about what fits.
 */
export function sketchFitsDraft(sketch: CanvasSketchScene): boolean {
  if (new Blob([sketch.scene]).size > MAX_SKETCH_SCENE_BYTES) return false
  return Object.keys(sketch.versions).length <= MAX_SKETCH_SCENE_ELEMENTS
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

/** "02:53" — when the round went out. */
function reviewTime(review: { submittedAt?: string; createdAt: string }): string {
  const ms = Date.parse(review.submittedAt ?? review.createdAt)
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
}

// ── The words (W13/W46) ─────────────────────────────────────────────────────
//
// One place, because the same decision is called three things depending on what
// the user is looking at, and a button that says Approve above a Submit that
// says Pass is two different events to the person clicking them.

/** What the user is deciding ON: a build in Testing mode, a plan, or a version. */
export function decisionSubject(version: CanvasVersion): string {
  if (version.mode === 'uat') {
    const label = version.source.mode === 'uat' ? version.source.buildLabel : undefined
    return label ?? version.id
  }
  if (version.mode === 'plan') return 'plan'
  return version.id
}

/**
 * The two decision buttons' words.
 *
 * A PLAN has no Reject (owner spec, 2026-08-31). A plan is iterative: the thing
 * that is not an approval is another turn of the loop, so the button says what
 * the user is asking for — revisions — rather than passing judgement on work
 * nobody has done yet. The DECISION underneath is still `reject`: it drives the
 * identical machine (the version closes, the notes go back, the agent renders
 * the next one), and inventing a third decision value for the same transition
 * would fork the state machine to change a word.
 */
export function decisionLabels(version: CanvasVersion): { approve: string; reject: string } {
  const subject = decisionSubject(version)
  if (version.mode === 'uat') return { approve: `Pass build ${subject}`, reject: `Fail build ${subject}` }
  if (version.mode === 'plan') return { approve: `Approve ${subject}`, reject: 'Submit Revisions' }
  return { approve: `Approve ${subject}`, reject: `Reject ${subject}` }
}

/**
 * Why Approve is unavailable on a PLAN, or null when it is available.
 *
 * Two gates, and the order matters — the questions are the agent's, the notes
 * are the user's, and a user who has both should be told about the one they can
 * do nothing about first.
 *
 *  - an OPEN QUESTION blocks it. Answering a question is not approving a plan:
 *    the answers go back as revisions and the NEXT version — the one written
 *    knowing them — is the one that can be approved. "Approve with answers
 *    attached" is exactly the one-step move this exists to prevent, and a
 *    revision that raises new questions blocks it again.
 *  - any NOTE blocks it. Approve on a plan means "this is perfect"; a note means
 *    it is not. (This is where a plan parts company with a mockup, where notes
 *    filed with an approval are observations the agent reads and owes nothing
 *    on.)
 */
export function planApproveBlock(version: CanvasVersion, noteCount: number): string | null {
  if (version.mode !== 'plan') return null
  const open = version.openQuestions ?? 0
  if (open > 0) return `${open} open question${open === 1 ? '' : 's'} — answer ${open === 1 ? 'it' : 'them'} in a note and submit revisions`
  if (noteCount > 0) return `${noteCount} note${noteCount === 1 ? '' : 's'} to send — approve a plan only when there is nothing to say`
  return null
}

/**
 * What Submit says it will FILE — never just "Submit".
 *
 * The button is the last thing between the user and a decision that settles
 * every earlier round of the subject, so it states the decision, what it is
 * about, and how many notes ride with it. Testing mode names its own nouns:
 * notes on a failure are defects, notes on a pass are observations.
 */
export function submitLabel(version: CanvasVersion, decision: 'approve' | 'reject' | null, noteCount: number): string {
  if (decision === null) return 'Submit'
  const subject = decisionSubject(version)
  if (version.mode === 'uat') {
    if (decision === 'reject') return `Submit test — Fail, ${noteCount} ${noteCount === 1 ? 'defect' : 'defects'}`
    return noteCount > 0
      ? `Submit test — Pass, ${noteCount} ${noteCount === 1 ? 'observation' : 'observations'}`
      : 'Submit test — Pass'
  }
  if (version.mode === 'plan' && decision === 'reject') {
    return `Submit revisions — ${noteCount} ${noteCount === 1 ? 'note' : 'notes'}`
  }
  const word = decision === 'approve' ? 'Approve' : 'Reject'
  if (noteCount === 0) return `Submit — ${word} ${subject}`
  return `Submit — ${word} ${subject}, ${noteCount} ${noteCount === 1 ? 'note' : 'notes'}`
}

/**
 * The outcome a SETTLED round wears in History.
 *
 * The user's own word first — they Approved or Rejected (Passed or Failed in
 * Testing mode) and that is what the row should say back. Two exceptions, both
 * about not overstating:
 *
 *  - a round carrying OBSERVATIONS says so, because "APPROVED" alone hides that
 *    the user wrote something the agent was meant to read;
 *  - a round with no decision stamped — settled by a later decision, by a force,
 *    or healed from a pre-rework record — has no word of the user's to quote, so
 *    it says HOW it settled instead of inventing one.
 */
export function roundOutcomeLabel(group: ReviewGroup, versions: readonly CanvasVersion[]): string {
  const mode = versions.find((v) => v.id === group.review.versionId)?.mode
  const uat = mode === 'uat'
  const hasObservations = group.closedNotes.some((n) => n.state === 'observation')
  const decision = group.review.decision
  if (hasObservations || decision === undefined) return settledLabel(group, versions) ?? 'settled'
  if (decision === 'approve') return uat ? 'PASSED' : 'APPROVED'
  // A plan was never rejected — the user asked for another turn. Same decision,
  // same machine; the row says what the button said (see decisionLabels).
  if (mode === 'plan') return 'REVISIONS REQUESTED'
  return uat ? 'FAILED' : 'REJECTED'
}

/**
 * The version the agent will render next, named rather than guessed at.
 *
 * Ids are minted monotonically per canvas (`v<n>`, the store's own high-water
 * mark is `max(id) + 1`), so the successor of the whole canvas IS what the next
 * render gets. Falls back to the vaguer phrasing when nothing parses, which is
 * better than naming a version that will not exist.
 */
export function nextVersionLabel(versions: readonly CanvasVersion[]): string | null {
  let max = 0
  for (const v of versions) {
    const n = Number(v.id.slice(1))
    if (Number.isFinite(n)) max = Math.max(max, n)
  }
  return max > 0 ? `v${max + 1}` : null
}

/**
 * The version that ANSWERED a rejected one — the next ready render in the same
 * artefact run, or null when the agent has not made it yet.
 *
 * Not `max(id) + 1`. That is the id the NEXT render will get, which is the right
 * prediction while the user is waiting and the wrong answer once the answer
 * exists: with v8 already on the canvas, "v7 was rejected — the agent is working
 * on v9" names a version nobody has heard of and hides the one the user could go
 * and look at. It also has to stay inside the RUN, because a plan rendered
 * between two mockups takes the next id without answering anything.
 */
export function answeringVersion(
  versions: readonly CanvasVersion[],
  rejectedId: string,
): CanvasVersion | null {
  const run = artifactRunContaining(versions, rejectedId)
  if (!run) return null
  const at = run.findIndex((v) => v.id === rejectedId)
  if (at < 0) return null
  return run.slice(at + 1).find((v) => !v.draft && !v.show) ?? null
}

// ── Inline image markers ────────────────────────────────────────────────────
//
// The note text may say "Image 2", and that is not decoration: the serializer
// tells the agent which image block "Image 2" is, so the words in the note point
// at a picture. Which means the panel owns the numbering, and has to keep it
// true when the user deletes one from the middle.

export function imageMarker(n: number): string {
  return `Image ${n}`
}

/** Insert "Image N" at the caret, with a space either side when the text there
 *  does not already have one. Returns the new text and where the caret lands. */
export function insertImageMarker(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  n: number,
): { text: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, text.length))
  const end = Math.max(start, Math.min(selectionEnd, text.length))
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
  const marker = `${lead}${imageMarker(n)}${trail}`
  return { text: `${before}${marker}${after}`, caret: before.length + marker.length }
}

/**
 * Renumber the note's markers after image `removed` (1-based) is deleted.
 *
 * The marker for the removed image goes with it — leaving "Image 2" behind
 * would point the agent at a picture that is no longer attached, which is worse
 * than saying nothing. Everything after it shifts down by one, so "Image 3"
 * becomes "Image 2" and the words keep meaning what they meant.
 */
export function renumberImageMarkers(text: string, removed: number): string {
  // Eat the whitespace on BOTH sides and put one back only when the marker sat
  // between two things — otherwise deleting the first word of a note leaves it
  // starting with a space.
  const withoutRemoved = text.replace(
    new RegExp(`(\\s*)\\b${imageMarker(removed)}\\b(\\s*)`, 'g'),
    (_whole, lead: string, trail: string) => (lead && trail ? lead : ''),
  )
  return withoutRemoved.replace(/\bImage (\d+)\b/g, (whole, digits: string) => {
    const n = Number(digits)
    return Number.isFinite(n) && n > removed ? imageMarker(n - 1) : whole
  })
}

/**
 * What happened to a closed note — and, as load-bearing as the verdict itself,
 * WHO said so.
 *
 * The agent can reach two of these three states (`stale`, `dismissed`) when the
 * user tells it to, so a row that showed only the verdict would let "the agent
 * closed this because you asked" and "you decided this yourself" read
 * identically. `approved` beside the agent's name exists in exactly one form —
 * a variant pick the user stated in chat (`canvas_pick`, always stamped
 * `pickSource: 'chat'`); the store refuses the pair without that stamp, and the
 * row says "picked in chat" so it never reads as a click that didn't happen.
 */
export function closedLabel(note: Annotation): string {
  // An OBSERVATION is its own sentence, not a verdict with an author: the user
  // filed it WITH an approval, so nothing was ever owed on it and no "by you"
  // suffix would add anything true.
  if (note.state === 'observation') return 'observation · nothing owed'
  // The settled machine's own: the user's DECISION on a later version closed
  // it. Nobody clicked this note, and "closed — work shipped" would be a claim
  // about the work that nobody made — so the row says what actually happened to
  // THIS note, which is a different sentence depending on where it was.
  if (note.closedBy === 'decision') {
    const by = note.settledBy?.reviewId
      ? `superseded by your ${note.settledBy.reviewId.replace('R', 'Review #')}`
      : note.settledBy
        ? `settled by your ${note.settledBy.versionId} decision`
        : 'settled by your later decision'
    if (note.closedFrom === 'open') return `closed — never resolved · ${by}`
    return note.addressedIn ? `updated in ${note.addressedIn} · ${by}` : `answered by the agent · ${by}`
  }
  const verdict =
    note.state === 'approved' ? 'approved' : note.state === 'stale' ? 'closed — work shipped' : 'dismissed'
  // A chat pick (canvas_pick): the user named the winner in conversation and
  // the agent recorded it. Its own words, because "by the agent on your
  // instruction" would undersell that the DECISION was the user's.
  if (note.closedBy === 'agent' && note.pickSource === 'chat') return `${verdict} · picked in chat`
  if (note.closedBy === 'agent') return `${verdict} · by the agent on your instruction`
  if (note.closedBy === 'user') return `${verdict} · by you`
  // The version supersede: the store settled it because the VERSION it hung
  // off died. Nobody clicked this note, and the row must not read as if
  // somebody did.
  if (note.closedBy === 'supersede') return `${verdict} · settled by your later review`
  // A record from before close-out existed. Says the verdict and claims
  // nothing about who gave it, which is all that is actually known.
  return verdict
}

/** "picked B — thin rule", or null when the approval named no variant. */
export function pickedVariantLabel(note: Annotation): string | null {
  if (!note.chosenVariantKey) return null
  const chosen = note.variants?.find((v) => v.key === note.chosenVariantKey)
  return chosen ? `picked ${chosen.key} — ${chosen.label}` : `picked ${note.chosenVariantKey}`
}

/** The pencil mark. Drawn, not typed: the repo's rule is that a glyph in JSX is
 *  a font dependency the user may not have. */
function PencilMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M6.8 1.2l2 2-5 5-2.4.4.4-2.4z" />
    </svg>
  )
}

/** The disclosure triangle every collapsible row here uses. */
function Caret({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      width="9" height="9" viewBox="0 0 10 10" fill="currentColor" aria-hidden
      className="shrink-0 transition-transform"
      style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', color: 'var(--text-muted)' }}
    >
      <polygon points="2,2 8,5 2,8" />
    </svg>
  )
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
      {pageReported && <span style={{ color: 'var(--text-muted)' }}>{PAGE_REPORTED_MARK} </span>}
      {focus.label}
    </span>
  )
}

/**
 * One image on a note or in the composer.
 *
 * A freshly pasted one has its bytes in hand and shows the picture; a persisted
 * one is a numbered tile, because the renderer never reads files and "Image 2"
 * is the honest thing to draw for a picture it cannot see.
 *
 * M3 adds an owner-scoped `canvas:evidenceRead` channel and these tiles become
 * real thumbnails then; the numbering and the ordering are already the contract,
 * so only the picture changes.
 *
 * `prefix` keeps the composer's tiles and a note row's tiles apart in the DOM:
 * they are the same component in two places, and one testid for both makes a
 * test that means "the composer's second image" quietly match a note's.
 */
function ImageTile({
  index,
  pngBase64,
  onRemove,
  prefix = 'composer-image',
}: {
  index: number
  pngBase64?: string
  onRemove?: () => void
  prefix?: 'composer-image' | 'note-image'
}): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 pl-1 pr-0.5 py-0.5 rounded border text-[10px]"
      style={{ borderColor: 'color-mix(in srgb, var(--color-mauve) 45%, transparent)', color: 'var(--color-mauve)' }}
      data-testid={`${prefix}-${index}`}
    >
      {pngBase64 ? (
        <img src={`data:image/png;base64,${pngBase64}`} alt="" className="h-[16px] w-auto max-w-[32px] rounded-[2px] object-cover" />
      ) : (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden>
          <rect x="1" y="1.8" width="8" height="6.4" rx="1" />
          <path d="M1 6.4l2.2-2 2 1.8 1.6-1.4L9 6.6" />
        </svg>
      )}
      {imageMarker(index)}
      {onRemove && <DismissButton onClick={onRemove} label={`Remove ${imageMarker(index)}`} size={8} data-testid={`${prefix}-remove-${index}`} />}
    </span>
  )
}

/**
 * The composer's own idea of one image.
 *
 * `key` is a LOCAL, monotonic identity and it is the whole point. Neither
 * position nor path survives a save: main renames the files by destination on
 * every write, so an image that was `img-2.png` becomes `img-1.png` the moment
 * something before it is removed — and a `keepIndex` resolved against a path
 * would silently miss and drop the picture. The key never moves, so the send
 * path can say exactly which of main's images it means by looking the key up in
 * the list it last confirmed.
 *
 * `pngBase64` is present only while this session still holds the bytes (a paste
 * made here), and only for the thumbnail. `noteIndex` is set for an image that
 * came off a note being EDITED — its position on that note, which is what
 * `fromNote` names and which the current position stops matching as soon as one
 * is removed.
 */
interface ComposerImage {
  key: number
  pngBase64?: string
  noteIndex?: number
}

/** Local image ids, unique within the process. Only their inequality matters. */
let nextComposerImageKey = 1
function mintImageKey(): number {
  nextComposerImageKey += 1
  return nextComposerImageKey
}

/**
 * The docked review panel (M2): the folded history, the one live round, the
 * notes not yet sent, the composer, and the decision.
 */
export default function CanvasNotesPanel({
  sessionId,
  canvasId,
  version,
  getGlassApi,
  getAllSketchElements,
  onReturnToTerminal,
  isActive,
  onHide,
  getUnattachedSketchElementIds,
  markSketchElementsAttached,
  getSketchSceneForPersist,
  restoreSketchScene,
  sketchRevision,
  evidence,
}: Props) {
  const state = useCanvasReviewStore((s) => s.bySessionId[sessionId])
  const refresh = useCanvasReviewStore((s) => s.refresh)
  const markAddressedSeen = useCanvasReviewStore((s) => s.markAddressedSeen)
  const upsertNote = useCanvasReviewStore((s) => s.upsertNote)
  const deleteNote = useCanvasReviewStore((s) => s.deleteNote)
  const submitReview = useCanvasReviewStore((s) => s.submitReview)
  const reopenNote = useCanvasReviewStore((s) => s.reopenNote)
  const reopenRound = useCanvasReviewStore((s) => s.reopenRound)
  const clearFocus = useCanvasReviewStore((s) => s.clearFocus)
  const expandFocus = useCanvasReviewStore((s) => s.expandFocus)
  const restoreFocus = useCanvasReviewStore((s) => s.restoreFocus)
  const setEditing = useCanvasReviewStore((s) => s.setEditingAnnotation)
  const setPanelHighlight = useCanvasReviewStore((s) => s.setPanelHighlight)
  const saveComposerDraft = useCanvasReviewStore((s) => s.saveComposerDraft)
  const clearComposerDraft = useCanvasReviewStore((s) => s.clearComposerDraft)
  /** The canvas's versions, so a settled round can name the DECISION that ended
   *  it. A stable EMPTY constant rather than `?? []`, so the restore effect
   *  below does not see a fresh array identity on every commit. */
  const canvasVersions = useCanvasStore((s) => s.bySessionId[sessionId]?.versions) ?? NO_VERSIONS

  const [noteText, setNoteText] = useState('')
  const [images, setImages] = useState<ComposerImage[]>([])
  const [pasteError, setPasteError] = useState<string | null>(null)
  /** The drawing is too big to ride the draft. Said once, in plain words,
   *  rather than failing the whole save in silence. */
  const [sketchTooLarge, setSketchTooLarge] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  /** The decision this review will carry. Submit stays dead until one is made;
   *  reject mandates a note. */
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  /** What was just filed, so the compose area can say what is now happening
   *  instead of offering a second submit (W12). */
  const [filed, setFiled] = useState<{ decision: 'approve' | 'reject'; reviewId?: string } | null>(null)
  /** History is folded by default — it is the settled past, not the work. */
  const [historyOpen, setHistoryOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // The displayed version's openness: only an OPEN version (ready, no verdict)
  // takes a review.
  const versionOpen = !version.draft && !version.verdict

  useEffect(() => {
    void refresh(sessionId)
  }, [sessionId, refresh])

  const focus = state?.focus ?? null
  const focusChain = state?.focusChain ?? []
  const focusChainIndex = state?.focusChainIndex ?? 0
  const editingId = state?.editingAnnotationId ?? null
  const resolution = state?.resolution ?? null

  /**
   * Is the review mirror actually describing the canvas the PANE is showing?
   *
   * The mirror refreshes asynchronously and a canvas switch moves it a beat
   * after the pane, so for that beat `state.canvasId` names the canvas the user
   * has left. Every composer read, write and restore hangs off this: a draft
   * saved during that beat lands on the wrong canvas, and one restored during it
   * puts another canvas's half-written note in front of the user.
   */
  const mirrorMatches = !!state?.loaded && state.canvasId === canvasId

  const draftReview = state ? draftReviewOf(state) : null
  const draftNotes = useMemo(() => (state ? draftAnnotationsOf(state) : []), [state])
  const groups = useMemo(() => (state ? reviewGroupsOf(state) : []), [state])
  // "ONE active round" is the invariant; a user Reopen can legitimately make a
  // second, and both are drawn, newest first.
  const liveGroups = useMemo(() => groups.filter((g) => g.waitingOn === 'agent'), [groups])
  const settledGroups = useMemo(() => groups.filter((g) => g.waitingOn === 'closed'), [groups])

  /**
   * Why Approve is unavailable on a PLAN, or null. Derived on every render from
   * the two facts it is made of (the version's open questions, the notes in the
   * composer), never latched — so a note added a moment AFTER the user picked
   * Approve closes the gate rather than leaving a stale decision armed. It is
   * computed here, above the submit path, because `doSubmit` re-checks it: the
   * disabled button is the affordance, the refusal in the handler is the rule.
   * Null for every other mode — a mockup's Approve still carries observations.
   */
  const approveBlock = planApproveBlock(version, draftNotes.length)

  /** Explicit user toggles only; a round's default fold state is derived (a
   *  settled round starts collapsed, the live one starts open). Keyed by CANVAS
   *  as well as review, because a review id is an ordinal within its own canvas. */
  const [groupOverride, setGroupOverride] = useState<Record<string, boolean>>({})
  const overrideKey = useCallback((reviewId: string) => canvasId + ':' + reviewId, [canvasId])
  const isGroupCollapsed = useCallback(
    (g: ReviewGroup) => groupOverride[overrideKey(g.review.id)] ?? g.waitingOn === 'closed',
    [groupOverride, overrideKey],
  )
  const toggleGroup = useCallback(
    (g: ReviewGroup) => {
      const key = overrideKey(g.review.id)
      setGroupOverride((prev) => ({ ...prev, [key]: !(prev[key] ?? g.waitingOn === 'closed') }))
    },
    [overrideKey],
  )
  /** Which settled rounds have their note list expanded. */
  const [closedOpen, setClosedOpen] = useState<Record<string, boolean>>({})

  const editingNote = useMemo(
    () => (editingId ? (draftNotes.find((a) => a.id === editingId) ?? null) : null),
    [editingId, draftNotes],
  )

  // ── The EDIT BUFFER, kept apart from the composer ──────────────────────────
  //
  // Editing a filed draft note used to load it into the composer's own state, so
  // the note's text became the composer's text — and every save path wrote it to
  // disk as the half-written note. Cancel then left a phantom: a composer holding
  // words the user had never composed, which came back on the next mount.
  //
  // An edit is a different operation with a different destination (the note, via
  // `annotationUpsert`), so it gets its own buffer and touches nothing the
  // composer owns.
  const [editText, setEditText] = useState('')
  const [editImages, setEditImages] = useState<ComposerImage[]>([])
  const editTextRef = useRef('')
  editTextRef.current = editText
  const editImagesRef = useRef<ComposerImage[]>([])
  editImagesRef.current = editImages

  // ── The persisted composer (W14) ──────────────────────────────────────────
  //
  // Every field the composer owns round-trips through main. Nothing that a
  // pane switch could throw away may live only in React state after this — the
  // "draft in renderer memory" root cause is the reason the rework exists.

  /**
   * The live composer values, updated SYNCHRONOUSLY at every mutation.
   *
   * Not an effect, deliberately. A save fired from an event handler has to see
   * what the user just did, and two mutations in one tick (two removes, a paste
   * then a remove) each have to build on the last — an effect-updated ref lags
   * by a commit, so both would build on the same stale base.
   */
  const composerRef = useRef({
    noteText: '',
    decision: null as 'approve' | 'reject' | null,
    images: [] as ComposerImage[],
    focus: null as FocusObject | null,
  })
  composerRef.current.focus = focus
  /** The KEYS of the images main is currently holding, in its own order — the
   *  list this panel last successfully sent. `keepIndex` is resolved against
   *  THIS at send time; see ComposerImage for why not a path. */
  const confirmedImageKeysRef = useRef<number[]>([])
  /** Set by anything the user does; the saver refuses to write until then, so
   *  restoring a draft cannot immediately re-save the thing it just read. */
  const dirtyRef = useRef(false)
  /** The canvas this mount belongs to. The pane keys its surface by canvas id so
   *  this never changes for a mount — captured all the same, because the unmount
   *  save runs after the props are gone. */
  const mountedCanvasIdRef = useRef(canvasId)
  const versionOpenRef = useRef(versionOpen)
  versionOpenRef.current = versionOpen
  const versionIdRef = useRef(version.id)
  versionIdRef.current = version.id
  const mirrorMatchesRef = useRef(mirrorMatches)
  mirrorMatchesRef.current = mirrorMatches
  const editingRef = useRef(false)
  editingRef.current = editingNote !== null
  /**
   * The submit gate.
   *
   * A debounced save armed a moment before Submit used to land AFTER it, writing
   * the composer main had just cleared with the round — so the note the user had
   * sent came back as an unsent draft on the next mount. The submit paths close
   * this before their first await; the next user edit opens it again.
   */
  const submittingRef = useRef(false)

  // ── Testing mode: the evidence a note locks (M3) ──────────────────────────
  //
  // Everything here is gated on the seam being present, which the pane passes
  // only for a `uat` version. Read through a ref as well as a prop because the
  // save paths fire from event handlers and unmount cleanups, where the render
  // that closed over the prop may be several commits old.
  const evidenceRef = useRef(evidence)
  evidenceRef.current = evidence
  const testing = !!evidence
  /**
   * The thumbnail for each note in this run.
   *
   * Two sources, and the distinction is worth keeping: a note saved in THIS
   * session already has a preview data URL (the capture reply minted one, at
   * 40 KiB), so it costs nothing; a note restored from disk has to be read back
   * through `canvas:evidenceRead`, which returns the full shot. Preferring the
   * preview is what keeps a run of twenty notes from pulling twenty full-size
   * screenshots into the renderer to draw twenty 34px thumbnails.
   */
  const [evidencePreviews, setEvidencePreviews] = useState<Record<string, string>>({})
  /** Paths already asked for, so a failed read is not retried on every render. */
  const previewAskedRef = useRef(new Set<string>())

  /**
   * A note is starting — freeze the site and capture it.
   *
   * Called from the two triggers the PANEL can see (the composer taking focus,
   * a paste); the pane raises the other two (a target selection, a first
   * stroke). An EDIT never starts one: the note being re-worded already carries
   * its own evidence, and re-capturing would swap the screen under words
   * written about the old one.
   */
  const beginNoteEvidence = useCallback(() => {
    if (editingRef.current || submittingRef.current) return
    if (!versionOpenRef.current || !mirrorMatchesRef.current) return
    evidenceRef.current?.begin()
  }, [])

  /** Fill in the thumbnails for notes this session did not capture — a run
   *  reopened after a pane switch, or restored from disk. Asked once per note:
   *  a thumbnail that could not be read is a blank tile, never a retry loop. */
  useEffect(() => {
    if (!testing || !mirrorMatches) return
    const wanted = draftNotes.filter(
      (note) => note.evidence && !evidencePreviews[note.id] && !previewAskedRef.current.has(note.id),
    )
    if (wanted.length === 0) return
    for (const note of wanted) previewAskedRef.current.add(note.id)
    let cancelled = false
    void (async () => {
      for (const note of wanted) {
        const path = note.evidence?.shotPath
        if (!path) continue
        try {
          const out = await window.electronAPI.canvas.evidenceRead({ sessionId, canvasId, path })
          if (cancelled || !out?.dataUrl) continue
          setEvidencePreviews((prev) => ({ ...prev, [note.id]: out.dataUrl }))
        } catch {
          /* a thumbnail is worth no failure state — the row still reads */
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [testing, mirrorMatches, draftNotes, evidencePreviews, sessionId, canvasId])

  /** Serialise the saves: one in flight, and the LATEST queued behind it. Two
   *  saves racing is how the renderer and main came to disagree about which
   *  images exist. */
  const saveQueuedRef = useRef(false)
  const saveRunningRef = useRef(false)

  const sendComposerDraft = useCallback(async (): Promise<void> => {
    const cid = mountedCanvasIdRef.current
    const cur = composerRef.current
    // The glass rides the draft, so a pane switch does not lose the drawing the
    // note was going to carry.
    //
    // CHECKED HERE, before the IPC: main refuses an oversized scene, and a
    // refusal at the seam would take the note's TEXT down with it. A drawing too
    // big to persist is a drawing that stays on the canvas while the pane is
    // open — worth saying, not worth losing a paragraph over.
    const rawSketch = getSketchSceneForPersist()
    const oversized = rawSketch !== null && !sketchFitsDraft(rawSketch)
    const sketch = oversized ? null : rawSketch
    setSketchTooLarge(oversized)
    // Resolve every already-persisted image to its position in MAIN's list by
    // its stable KEY. The keys of the last confirmed send describe main's
    // current list exactly — saves are serialised, so it cannot be a send behind
    // — while a path or a position would have moved under the rename.
    const confirmed = confirmedImageKeysRef.current
    const sending = cur.images
    const sentKeys: number[] = []
    const entries: Array<{ pngBase64: string } | { keepIndex: number }> = []
    for (const img of sending) {
      const at = confirmed.indexOf(img.key)
      if (at >= 0) {
        entries.push({ keepIndex: at })
        sentKeys.push(img.key)
      } else if (img.pngBase64 !== undefined) {
        entries.push({ pngBase64: img.pngBase64 })
        sentKeys.push(img.key)
      }
      // Neither: main has forgotten it and this session has no bytes for it, so
      // there is nothing honest to send. Dropped rather than guessed at.
    }
    // The PENDING capture rides the draft too (M3), so a pane switch mid-note
    // does not orphan a screenshot main is holding — and the note the user
    // comes back to still locks the screen it was started against. Read from
    // the seam at send time rather than mirrored into composerRef: the pane
    // owns this fact, and a second copy is a second thing to keep in step.
    const evidenceId = evidenceRef.current?.pending?.evidenceId
    const saved = await saveComposerDraft(sessionId, cid, {
      versionId: versionIdRef.current,
      ...(cur.decision ? { decision: cur.decision } : {}),
      text: cur.noteText,
      ...(cur.focus ? { focus: cur.focus } : {}),
      images: entries,
      ...(sketch ? { sketch } : {}),
      ...(evidenceId ? { evidenceId } : {}),
    })
    if (!saved) return
    // Main now holds exactly the images we sent, in that order. Recording their
    // KEYS is what lets the next save name them without re-sending bytes — and
    // it is correct even if the list has moved under us in the meantime, because
    // the survivors keep their keys and the queued save resolves against this.
    confirmedImageKeysRef.current = sentKeys.slice(0, saved.images.length)
  }, [sessionId, saveComposerDraft, getSketchSceneForPersist])

  /**
   * Write the composer to disk — at most one write in flight, latest wins.
   *
   * Every early return here is a case where writing would be WRONG rather than
   * merely unnecessary: no user edit yet (a restore would re-save itself), an
   * edit in progress (that belongs to the note, not the composer), a submit in
   * flight (the round has taken the draft with it), or a mirror describing
   * another canvas.
   */
  const persistComposer = useCallback((): void => {
    if (!dirtyRef.current || !versionOpenRef.current) return
    if (editingRef.current || submittingRef.current || !mirrorMatchesRef.current) return
    saveQueuedRef.current = true
    if (saveRunningRef.current) return
    saveRunningRef.current = true
    void (async () => {
      try {
        while (saveQueuedRef.current) {
          saveQueuedRef.current = false
          await sendComposerDraft()
        }
      } finally {
        saveRunningRef.current = false
      }
    })()
  }, [sendComposerDraft])

  const persistRef = useRef(persistComposer)
  persistRef.current = persistComposer

  /**
   * The debounce timer, in a ref.
   *
   * Held rather than left to an effect's own cleanup because Submit has to
   * CANCEL it — a save armed a keystroke before Submit lands after it, and
   * resurrects the draft main has just cleared.
   */
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPendingSave = useCallback(() => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    debounceRef.current = null
  }, [])
  const armSave = useCallback(() => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null
      persistRef.current()
    }, COMPOSER_SAVE_DEBOUNCE_MS)
  }, [])

  /** Debounced: typing, deciding, re-targeting. */
  useEffect(() => {
    if (!dirtyRef.current) return
    armSave()
  }, [noteText, decision, focus, armSave])

  /**
   * A stroke on the glass is a user edit.
   *
   * The pane bumps sketchRevision from the glass's own onChange, which is the
   * only way this panel learns that a drawing happened: without it a
   * drawing-only draft was never dirty and never reached disk, and the stroke
   * count that arms Add note was read once per render and never recomputed.
   */
  const lastSketchRevisionRef = useRef(sketchRevision)
  const ignoreNextSketchRevisionRef = useRef(false)
  useEffect(() => {
    if (sketchRevision === lastSketchRevisionRef.current) return
    lastSketchRevisionRef.current = sketchRevision
    // A restore puts the scene back and the glass reports it as a change. That
    // is the panel's own doing, not the user's, so it must not mark the draft
    // dirty — the very next save would re-write what was just read.
    if (ignoreNextSketchRevisionRef.current) {
      ignoreNextSketchRevisionRef.current = false
      return
    }
    if (editingRef.current || submittingRef.current) return
    dirtyRef.current = true
    armSave()
  }, [sketchRevision, armSave])

  /** The panel going away is the moment the old model lost everything. */
  useEffect(() => {
    return () => {
      cancelPendingSave()
      persistRef.current()
    }
  }, [cancelPendingSave])

  /**
   * Restore the half-written note (W14) — and drop one that belongs elsewhere.
   *
   * A draft belongs to the version it was written on, but not only to that
   * version: the agent renders v9 in answer to the notes, and the half-written
   * one the user was still working on is about the same SUBJECT, so it comes
   * back. A draft from a different ARTEFACT does not — those notes were about
   * another page — and it is dropped rather than carried across.
   *
   * The artefact check runs on every version change, not once per mount: the
   * pane can move from a mockup to a plan while this panel stays mounted, and a
   * check that only ever ran at mount left the mockup's draft under the plan.
   */
  const restoredForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!mirrorMatches) return
    const composer = state?.composer
    if (!composer) {
      restoredForRef.current = canvasId
      return
    }
    const run = artifactRunContaining(canvasVersions, version.id)
    const sameArtefact = run ? run.some((v) => v.id === composer.versionId) : composer.versionId === version.id
    if (!sameArtefact) {
      // Nothing is persisted first: the draft being dropped is the one that does
      // not belong here, and writing the composer on screen over it would file
      // this artefact's empty composer against the other one's words.
      cancelPendingSave()
      dirtyRef.current = false
      composerRef.current = { noteText: '', decision: null, images: [], focus: null }
      confirmedImageKeysRef.current = []
      setNoteText('')
      setImages([])
      setDecision(null)
      restoredForRef.current = canvasId
      void clearComposerDraft(sessionId, canvasId)
      return
    }
    if (restoredForRef.current === canvasId) return
    restoredForRef.current = canvasId
    const restoredImages: ComposerImage[] = composer.images.map(() => ({ key: mintImageKey() }))
    confirmedImageKeysRef.current = restoredImages.map((img) => img.key)
    composerRef.current = {
      noteText: composer.text,
      decision: composer.decision ?? null,
      images: restoredImages,
      focus: composer.focus ?? null,
    }
    setNoteText(composer.text)
    setDecision(composer.decision ?? null)
    setImages(restoredImages)
    // A target belongs to the version it was locked on: a box measured against
    // v8 points somewhere else on v9, and the composer has no re-anchor pass of
    // its own. Restored only onto its own version; otherwise the note simply
    // starts untargeted, which is honest.
    if (composer.focus && composer.versionId === version.id) restoreFocus(sessionId, composer.focus)
    // The capture the half-written note had already locked (M3). Adopted only
    // onto its OWN version, for the same reason the target is: a screenshot of
    // v7 is not evidence about v8, and the run the note belongs to ended when
    // the version changed.
    if (composer.evidenceId && composer.versionId === version.id) evidenceRef.current?.adopt(composer.evidenceId)
    if (composer.sketch) {
      // Armed ONLY when the glass actually moved. A no-op restore (the scene was
      // already there — a quick pane toggle restoring from the in-memory stash)
      // sends no bump, so a suppression armed anyway would sit waiting and
      // swallow the user's first real stroke instead.
      ignoreNextSketchRevisionRef.current = restoreSketchScene(composer.sketch)
    }
  }, [
    mirrorMatches,
    canvasId,
    state?.composer,
    canvasVersions,
    version.id,
    sessionId,
    clearComposerDraft,
    restoreFocus,
    restoreSketchScene,
    cancelPendingSave,
  ])

  /** A version change within the same artefact keeps the draft but resets what
   *  is version-specific: the decision is about the render in front of you. */
  useEffect(() => {
    setDecision(null)
    composerRef.current.decision = null
    setFiled(null)
  }, [version.id])

  /**
   * Empty the composer's TEXT, IMAGES and TARGET, keeping the decision and the
   * drawing.
   *
   * Called after Add note. The images have moved onto the note and the words are
   * now its words, but the decision the user made about the version has not
   * changed and the glass still holds whatever they drew after it — clearing the
   * record outright threw both away.
   */
  const clearComposerAfterNote = useCallback(() => {
    composerRef.current = { noteText: '', decision: composerRef.current.decision, images: [], focus: null }
    confirmedImageKeysRef.current = []
    setNoteText('')
    setImages([])
    setPasteError(null)
    dirtyRef.current = true
    cancelPendingSave()
    persistRef.current()
  }, [cancelPendingSave])

  // Opening a draft note for editing loads it into the EDIT BUFFER — never into
  // the composer. Its images come back as positions on the NOTE; the renderer
  // never held their bytes.
  useEffect(() => {
    if (!editingNote) return
    setEditText(editingNote.note)
    setEditImages((editingNote.images ?? []).map((_, k) => ({ key: mintImageKey(), noteIndex: k })))
    setPasteError(null)
  }, [editingNote?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Multi-image paste (W15) ───────────────────────────────────────────────
  //
  // Ctrl+V anywhere on this pane APPENDS an image to the note being written and
  // drops "Image N" at the caret. The single slot it replaces silently
  // overwrote the previous paste: the user attached three screenshots and the
  // agent was handed one.
  const appendPastedImage = useCallback((pngBase64: string) => {
    const editing = editingRef.current
    const prevImages = editing ? editImagesRef.current : composerRef.current.images
    if (prevImages.length >= MAX_NOTE_IMAGES) {
      setPasteError('A note carries at most ' + MAX_NOTE_IMAGES + ' images — remove one to add another.')
      return
    }
    const nextImages: ComposerImage[] = [...prevImages, { key: mintImageKey(), pngBase64 }]
    const el = textareaRef.current
    const prevText = editing ? editTextRef.current : composerRef.current.noteText
    const start = el && document.activeElement === el ? el.selectionStart : prevText.length
    const end = el && document.activeElement === el ? el.selectionEnd : prevText.length
    const out = insertImageMarker(prevText, start, end, nextImages.length)
    setPasteError(null)
    if (editing) {
      editImagesRef.current = nextImages
      editTextRef.current = out.text
      setEditImages(nextImages)
      setEditText(out.text)
    } else {
      composerRef.current.images = nextImages
      composerRef.current.noteText = out.text
      setImages(nextImages)
      setNoteText(out.text)
      dirtyRef.current = true
      // A paste is one of the four things that START a note (M3), so the site
      // freezes here too — the pasted screenshot is usually of the very screen
      // the note is about, and it must not move underneath the comparison.
      beginNoteEvidence()
      // Immediately, not on the debounce: this one cost the user a screenshot.
      cancelPendingSave()
      persistRef.current()
    }
    // Put the caret after the marker, so the user keeps typing where they were
    // rather than at the top of the box.
    if (el) requestAnimationFrame(() => el.setSelectionRange(out.caret, out.caret))
  }, [cancelPendingSave, beginNoteEvidence])

  useEffect(() => {
    // Only the ACTIVE session's pane handles a paste. Every session mounts its
    // own CanvasNotesPanel, kept off-screen with CSS rather than unmounted, so
    // each registers this window listener; without the guard a single Ctrl+V on
    // a non-editable target would attach the image to EVERY session's composer.
    if (!isActive) return
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      const inPanel = !!(panelRef.current && target && panelRef.current.contains(target))
      const editable =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || !!target?.isContentEditable
      if (!inPanel && editable) return
      const file = imageFileFromClipboard(e.clipboardData)
      if (!file) return
      e.preventDefault()
      void (async () => {
        const out = await pastedImageToPng(file)
        if ('error' in out) {
          setPasteError(
            out.error === 'too-large'
              ? 'That image is too large even after downscaling (2 MB cap).'
              : 'Could not read that image from the clipboard.',
          )
          return
        }
        appendPastedImage(out.pngBase64)
      })()
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [isActive, appendPastedImage])

  /** Remove image k (0-based) and renumber the markers the text carries. */
  const removeImage = useCallback(
    (index: number) => {
      const editing = editingRef.current
      const prevImages = editing ? editImagesRef.current : composerRef.current.images
      const prevText = editing ? editTextRef.current : composerRef.current.noteText
      const nextImages = prevImages.filter((_, i) => i !== index)
      const nextText = renumberImageMarkers(prevText, index + 1)
      setPasteError(null)
      if (editing) {
        editImagesRef.current = nextImages
        editTextRef.current = nextText
        setEditImages(nextImages)
        setEditText(nextText)
        return
      }
      composerRef.current.images = nextImages
      composerRef.current.noteText = nextText
      setImages(nextImages)
      setNoteText(nextText)
      dirtyRef.current = true
      cancelPendingSave()
      persistRef.current()
    },
    [cancelPendingSave],
  )

  const composerScope: Annotation['scope'] = focus ? (focus.targets.length > 0 ? 'element' : 'region') : 'general'
  const canExpand = focus != null && focusChain.length > 0 && focusChainIndex < focusChain.length - 1

  /**
   * Strokes on the displayed version nobody has claimed — they ride the next
   * note automatically (W16).
   *
   * Two inputs, and BOTH are load-bearing:
   *
   *  - `sketchRevision`, because that is the only signal the panel gets that the
   *    glass moved: `getUnattachedSketchElementIds` is a plain call into the
   *    pane, so reading it during render without a reason to re-render meant the
   *    count was whatever it had been when something ELSE happened to re-render
   *    the panel — which is why Add note stayed dead after a drawing.
   *  - `draftNotes`, because taking strokes onto a note changes NOTHING about
   *    the glass: no bump, no re-render of this memo, so "1 stroke will ride
   *    this note" stayed armed after the note was filed and a second click filed
   *    a DUPLICATE carrying the same drawing.
   *
   * The pane subtracts its own attached set; the draft notes' own sketch ids are
   * subtracted here as well rather than trusted to it. Two sources agreeing is
   * cheap; a note that already carries a stroke being offered it again is the
   * duplicate this exists to stop, and the record is the one that cannot lag.
   */
  const draftSketchIds = useMemo(() => {
    const taken = new Set<string>()
    for (const note of draftNotes) for (const id of note.sketch?.excalidrawElementIds ?? []) taken.add(id)
    return taken
  }, [draftNotes])
  const unattachedStrokeIds = useMemo(
    () => (versionOpen ? getUnattachedSketchElementIds().filter((id) => !draftSketchIds.has(id)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [versionOpen, sketchRevision, version.id, getUnattachedSketchElementIds, draftSketchIds],
  )
  const unattachedStrokeCount = unattachedStrokeIds.length

  // An EDIT never takes strokes: they belong to whatever note is written next,
  // and letting a re-worded note swallow them would move a drawing the user made
  // after it. So unattached strokes only arm Add note, never Save.
  const activeText = editingNote ? editText : noteText
  const activeImages = editingNote ? editImages : images
  const canAddNote =
    activeText.trim().length > 0 ||
    activeImages.length > 0 ||
    (!editingNote && unattachedStrokeCount > 0) ||
    // In Testing a captured screen is itself a note (M3) — "this is what it
    // looked like" is a complete piece of evidence, and refusing to save it
    // would make the pause a thing the user could only escape by typing.
    (!editingNote && !!evidence?.pending) ||
    !!editingNote?.sketch

  const saveNote = useCallback(async () => {
    const editing = editingNote
    const text = (editing ? editTextRef.current : composerRef.current.noteText).trim()
    const noteImages = editing ? editImagesRef.current : composerRef.current.images
    const strokeIds = editing ? [] : unattachedStrokeIds
    const scope = editing ? editing.scope : composerScope
    const noteFocus = editing ? editing.focus : (focus ?? undefined)
    // The drawing rides the note: the strokes on the glass that nobody has
    // claimed become this note's sketch, with no button to press. The bbox is
    // measured from the live scene, so an element erased between the draw and
    // the save simply is not in it.
    //
    // On an EDIT the note KEEPS the drawing it already has — re-sending its
    // metadata unchanged. Sending nothing would delete it, which is how
    // re-wording a note would silently throw away the circle drawn round the
    // thing it was about.
    const liveElements = strokeIds.length > 0 ? getAllSketchElements() : []
    const chosen = liveElements.filter((el) => strokeIds.includes(el.id))
    const sketch = editing?.sketch
      ? { excalidrawElementIds: [...editing.sketch.excalidrawElementIds], bboxPage: editing.sketch.bboxPage }
      : chosen.length > 0
        ? { excalidrawElementIds: chosen.map((el) => el.id), bboxPage: sceneBBox(chosen) }
        : null
    // The capture this note LOCKS (M3). An edit never takes one: the note it is
    // re-wording already carries its own, and `evidenceId` is absent from the
    // draft so main leaves that evidence exactly where it is.
    const evidenceId = editing ? undefined : evidenceRef.current?.pending?.evidenceId
    // In Testing mode the screen IS a note. Words, a picture, a drawing — or
    // just "this is what it looked like".
    if (!text && noteImages.length === 0 && !sketch && !evidenceId) return
    const confirmed = confirmedImageKeysRef.current
    const saved = await upsertNote(sessionId, {
      ...(editing ? { annotationId: editing.id } : {}),
      scope,
      note: text,
      ...(scope !== 'general' && noteFocus ? { focus: noteFocus } : {}),
      ...(sketch ? { sketch } : {}),
      ...(noteImages.length > 0
        ? {
            images: noteImages.map((img) =>
              editing
                ? // An edit keeps what the NOTE already had, BY ITS POSITION ON
                  // THE NOTE — not by where it sits in the buffer now, which
                  // shifts the moment one is removed. A paste made during the
                  // edit rides its own bytes.
                  img.noteIndex !== undefined
                  ? { fromNote: img.noteIndex }
                  : { pngBase64: img.pngBase64 as string }
                : confirmed.indexOf(img.key) >= 0
                  ? { fromComposer: confirmed.indexOf(img.key) }
                  : { pngBase64: img.pngBase64 as string },
            ),
          }
        : {}),
      versionId: version.id,
      ...(evidenceId ? { evidenceId } : {}),
    })
    if (saved === null) return
    // Only a FRESH take is reported: on an edit the ids were already claimed
    // when the note first took them, and claiming them twice would say nothing.
    if (!editing && sketch) markSketchElementsAttached(sketch.excalidrawElementIds)
    if (evidenceId) {
      // Main has moved the pending file onto this note. The shield comes down
      // here — the site is live again the moment the evidence is locked — and
      // the trail is cut, so the next note's slice starts from this one.
      const preview = evidenceRef.current?.pending?.previewDataUrl
      evidenceRef.current?.lock(saved)
      if (preview) setEvidencePreviews((prev) => ({ ...prev, [saved]: preview }))
    }
    setFiled(null)
    if (editing) {
      setEditing(sessionId, null)
      editTextRef.current = ''
      editImagesRef.current = []
      setEditText('')
      setEditImages([])
      return
    }
    clearFocus(sessionId)
    // The composer keeps the decision and the drawing; its words and its images
    // have become the note's.
    clearComposerAfterNote()
  }, [
    editingNote,
    unattachedStrokeIds,
    composerScope,
    focus,
    sessionId,
    version.id,
    upsertNote,
    setEditing,
    clearFocus,
    clearComposerAfterNote,
    getAllSketchElements,
    markSketchElementsAttached,
  ])

  /**
   * Cancel the note being written (Testing mode's Cancel, and the shield's
   * Escape).
   *
   * The capture is DISCARDED rather than left pending: it is a picture of a
   * screen nobody is going to describe, and leaving it would have the next note
   * lock a screenshot taken before the user changed their mind. The decision and
   * the drawing survive, exactly as they do after a note is added — the same
   * clearing path, so the two cannot drift.
   */
  const cancelComposerNote = useCallback(() => {
    evidenceRef.current?.discard()
    clearFocus(sessionId)
    clearComposerAfterNote()
    setPasteError(null)
  }, [sessionId, clearFocus, clearComposerAfterNote])

  // Handed to the pane so Escape on the pause shield does exactly this. Cleared
  // on unmount, or the pane would hold a callback into a dead composer.
  useEffect(() => {
    const seam = evidenceRef.current
    if (!seam) return
    seam.registerCancel(cancelComposerNote)
    return () => {
      evidenceRef.current?.registerCancel(null)
    }
  }, [cancelComposerNote, testing])

  /** Cancel an edit: the note is untouched, and the composer never saw it. */
  const cancelEdit = useCallback(() => {
    setEditing(sessionId, null)
    editTextRef.current = ''
    editImagesRef.current = []
    setEditText('')
    setEditImages([])
    setPasteError(null)
  }, [sessionId, setEditing])

  /**
   * Report to main that the user has these addressed notes ON SCREEN.
   *
   * The release side of the agent's close-out barrier: until the user has seen
   * a note in its addressed state, `canvas_verdict` refuses to close it. The
   * report is a claim about the user's eyes, and every condition here exists to
   * keep it honest — `isActive` (mounted is not seen), the document being
   * VISIBLE, and SEEN_DWELL_MS of both uninterrupted.
   */
  const unseenAddressedIds = useMemo(
    () =>
      (state?.annotations ?? [])
        .filter((a) => a.state === 'addressed' && a.userSawAddressed !== true)
        .map((a) => a.id),
    [state?.annotations],
  )
  const unseenKey = unseenAddressedIds.join(',')

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
    // `mirrorMatches`, not just `canvasId`: the ids come from the review mirror,
    // so reporting them while it still describes the canvas the user has left
    // would name another canvas's notes as seen on this one.
    if (!isActive || !windowVisible || !mirrorMatches || unseenKey === '') return
    const ids = unseenKey.split(',')
    const timer = setTimeout(() => {
      void markAddressedSeen(sessionId, canvasId, ids)
    }, SEEN_DWELL_MS)
    return () => clearTimeout(timer)
  }, [isActive, windowVisible, mirrorMatches, canvasId, unseenKey, sessionId, markAddressedSeen])

  /**
   * Submit: every sketch-carrying draft note gets its glass elements exported to
   * PNG here — elements that have since been erased drop the sketch from the
   * note first, so main (which refuses a sketch without its export) never sees a
   * half-attached note.
   *
   * BOTH paths close the composer down BEFORE their first await: the debounce is
   * cancelled, the draft stops being dirty, and `submittingRef` bars any save
   * until the user edits again. A save armed one keystroke before Submit
   * otherwise lands after it and writes back the draft main has just cleared
   * with the round — so the note the user had SENT reappears as an unsent one.
   */
  /**
   * Take the composer off screen and off the save path for the duration of a
   * submit, keeping a snapshot so a REFUSAL can put it back.
   *
   * The wipe has to happen before the first await: a save armed one keystroke
   * before Submit otherwise lands after it and writes back the draft main has
   * just cleared with the round, so the note the user had SENT reappears as an
   * unsent one. But a refused submit files nothing, and the user's unsent words
   * are still the only copy — clearing the screen and leaving it clear would
   * lose them to an error they did not cause.
   */
  const restoreComposerAfterRefusal = useRef<(() => void) | null>(null)
  const closeComposerForSubmit = useCallback(() => {
    const snapshot = {
      composer: { ...composerRef.current, images: [...composerRef.current.images] },
      confirmedKeys: [...confirmedImageKeysRef.current],
      text: composerRef.current.noteText,
      decision: composerRef.current.decision,
      images: [...composerRef.current.images],
    }
    restoreComposerAfterRefusal.current = () => {
      submittingRef.current = false
      composerRef.current = snapshot.composer
      confirmedImageKeysRef.current = snapshot.confirmedKeys
      setNoteText(snapshot.text)
      setDecision(snapshot.decision)
      setImages(snapshot.images)
      // Still unsaved as far as this panel knows — the pre-submit save was
      // cancelled — so the next edit (or the unmount) writes it out again.
      dirtyRef.current = true
      restoreComposerAfterRefusal.current = null
    }
    submittingRef.current = true
    dirtyRef.current = false
    cancelPendingSave()
    saveQueuedRef.current = false
    composerRef.current = { noteText: '', decision: null, images: [], focus: null }
    confirmedImageKeysRef.current = []
    setNoteText('')
    setImages([])
    setPasteError(null)
    setSketchTooLarge(false)
  }, [cancelPendingSave])

  /**
   * The submit landed: the composer's words are the round's now.
   *
   * Anything that accumulated WHILE the gate was shut is discarded with it. The
   * paste listener sits on the window, so a screenshot can arrive mid-submit and
   * land in a composer the user is about to stop seeing — `persistComposer`
   * refuses to write it, but the flag it set would otherwise survive the gate
   * and the next debounce would file a round already sent back as an unsent
   * draft, carrying an image nobody chose to attach to it.
   */
  const finishComposerSubmit = useCallback(() => {
    restoreComposerAfterRefusal.current = null
    dirtyRef.current = false
    cancelPendingSave()
    saveQueuedRef.current = false
    composerRef.current = { noteText: '', decision: null, images: [], focus: null }
    confirmedImageKeysRef.current = []
    setNoteText('')
    setImages([])
    submittingRef.current = false
    // The run is over (M3): a capture still pending belonged to a note that was
    // never written, and the action trail belongs to the round that just went
    // out. Deliberately here rather than in `closeComposerForSubmit` — a
    // REFUSED submit puts the user's words back, and it should put them back
    // beside the screen they were written about.
    const seam = evidenceRef.current
    if (seam) {
      seam.discard()
      seam.endRun()
    }
  }, [cancelPendingSave])

  const doSubmit = useCallback(async () => {
    if (submitting || !versionOpen || decision === null) return
    if (decision === 'reject' && draftNotes.length === 0) return // note mandated
    // The plan gate, re-asserted where the write happens. The button is already
    // disabled and the armed decision is already cleared when it closes, but an
    // approval is the one submission that cannot be taken back — so it is
    // refused here too rather than trusting two pieces of UI state to have kept
    // up with each other.
    if (decision === 'approve' && approveBlock !== null) return
    // The plain Approve with nothing written: no review record — just the
    // version's verdict. The store refresh brings the new state in.
    if (decision === 'approve' && (!draftReview || draftNotes.length === 0)) {
      setSubmitting(true)
      setSubmitError(null)
      closeComposerForSubmit()
      try {
        const r = await window.electronAPI.canvas.versionVerdict({ sessionId, versionId: version.id, state: 'approved' })
        if (r && 'error' in r) {
          // The verdict was refused, so nothing was filed — and the words on
          // screen were the only copy. Put them back rather than leaving the
          // user with an error and an empty box.
          restoreComposerAfterRefusal.current?.()
          setSubmitError(r.error)
          return
        }
        window.electronAPI.pty.write(sessionId, 'Approved ' + version.id + ' on the canvas · canvas_version_verdict recorded\r')
        setFiled({ decision: 'approve' })
        setDecision(null)
        void clearComposerDraft(sessionId, mountedCanvasIdRef.current)
        useExcalidrawStore.getState().beginSubmitReturn(sessionId)
        finishComposerSubmit()
      } finally {
        setSubmitting(false)
      }
      return
    }
    if (!draftReview || draftNotes.length === 0) return
    setSubmitting(true)
    setSubmitError(null)
    closeComposerForSubmit()
    try {
      const api = getGlassApi()
      // C1: include the pane's foreign-version stash, so a sketch drawn on an
      // earlier version still exports when submitting from a later one.
      const scene = getAllSketchElements()
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
            ...((note.images?.length ?? 0) > 0 ? { images: (note.images ?? []).map((_, k) => ({ fromNote: k })) } : {}),
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
      // The whole run's trail rides the round (M3): the per-note slices are
      // already locked to their notes, and this is the continuous record the
      // agent reads once at the top. Read at submit time, not earlier — the
      // sketch export above takes real time, and anything the user did while it
      // ran is still part of the run.
      const review = await submitReview(sessionId, draftReview.id, sketches, decision, evidenceRef.current?.runTrail())
      if (!review) {
        restoreComposerAfterRefusal.current?.()
        setSubmitError('The review could not be submitted. Check the note list and try again.')
        return
      }
      const count = review.annotationIds.length
      // The pull side of D10: one line in chat carries the id; the agent
      // fetches the payload itself via canvas_review.
      window.electronAPI.pty.write(sessionId, 'Review #' + review.id.slice(1) + ' — ' + count + ' notes · canvas_review ' + review.id + '\r')
      setFiled({ decision, reviewId: review.id })
      setDecision(null)
      // Hand back to the session automatically (#478): submitting is the moment
      // the work moves from the user to the agent, and the agent has ALREADY
      // been handed the review by the line written just above. The store owns
      // the landing so it outlives this panel, and it CLOSES rather than
      // toggles, so a click racing it cannot double-flip the pane.
      useExcalidrawStore.getState().beginSubmitReturn(sessionId)
      finishComposerSubmit()
    } finally {
      setSubmitting(false)
    }
  }, [
    draftReview,
    draftNotes,
    submitting,
    decision,
    versionOpen,
    version.id,
    getGlassApi,
    getAllSketchElements,
    sessionId,
    submitReview,
    upsertNote,
    closeComposerForSubmit,
    finishComposerSubmit,
    clearComposerDraft,
    approveBlock,
  ])

  /**
   * An armed Approve does not survive the gate closing.
   *
   * The user can pick Approve on a plan with nothing written and then write a
   * note — at which point the plan is no longer perfect and the decision they
   * are holding is one they are not allowed to file. Leaving it selected would
   * put a green, disabled Submit in front of them with no way to read why; so
   * the decision goes back to undecided and the reason line under the buttons
   * says what happened. Approve is simply pressed again when the note is gone.
   *
   * `composerRef` moves with it, because it is what every out-of-render save
   * writes — a persisted draft still claiming `decision: 'approve'` would arm
   * the gate again on the next mount.
   */
  useEffect(() => {
    if (approveBlock === null || decision !== 'approve') return
    composerRef.current.decision = null
    setDecision(null)
  }, [approveBlock, decision])

  /**
   * What the panel may say about ONE live note's anchor — and, as load-bearing
   * as the words, WHO is saying it.
   *
   * `current` and `ghost` are the app's own knowledge. `reported` is not: a
   * re-anchor result is assembled by the page under review, with no way for the
   * host to check it, so it is rendered in the page's voice ("page says …") and
   * never in the app's. It used to read "re-anchored" in resolved green, which
   * let an artifact mark every open issue against it as tracked and point the
   * highlight anywhere it liked (adversarial review, 2026-08-14).
   */
  const anchorStatus = useCallback(
    (note: Annotation): { text: string | null; kind: 'reported' | 'ghost' | 'current'; rect: Rect | null } => {
      if (note.versionId === version.id) {
        const zoomEntry = resolution?.versionId === version.id ? resolution.byAnnotation[note.id] : undefined
        if (zoomEntry && zoomEntry.found) {
          return { text: 'on this version — page-located', kind: 'reported', rect: zoomEntry.box }
        }
        // No chip. "on this version" is the ordinary case — every note in the
        // live round is normally on it — so a badge saying so on every row is
        // noise that teaches the eye to skip the chip column, which is exactly
        // where the page-reported warning lives.
        return { text: null, kind: 'current', rect: note.focus?.bboxPage ?? null }
      }
      if (!note.focus) return { text: null, kind: 'current', rect: null }
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

  const hoverNote = useCallback(
    (note: Annotation | null) => {
      if (!note) {
        setPanelHighlight(sessionId, null)
        return
      }
      const status = anchorStatus(note)
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
    [sessionId, anchorStatus, setPanelHighlight],
  )

  /**
   * What is still owed ELSEWHERE on this canvas, in plain words.
   *
   * Read after an approval that did NOT sign the subject off, which is the one
   * moment the user is owed an explanation: they approved, the pane did not go
   * to the front page, and without this the only signal is the absence of one.
   * Derived through the shared `artifactPhaseOf` — the same helper the Library
   * row and main use — so this line cannot disagree with them.
   */
  const owedElsewhere = useCallback((): string | null => {
    if (!state) return null
    if (draftNotes.length > 0) return 'a note you have not sent yet'
    const runs = artifactRuns(canvasVersions).filter((r) => !r[0]?.archived)
    for (const run of runs) {
      if (run.some((v) => v.id === version.id)) continue
      const phase = artifactPhaseOf(run, state.reviews, state.annotations)
      if (phase.kind === 'needs-you') return 'another version is waiting on you'
      if (phase.kind === 'with-agent') return 'another round is still with the agent'
    }
    return null
  }, [state, draftNotes.length, canvasVersions, version.id])

  const nextVersion = nextVersionLabel(canvasVersions)
  const labels = decisionLabels(version)

  /**
   * What an APPROVE that did not sign the subject off leaves on screen.
   *
   * When it DOES complete, the canvas's own `completed` push takes the pane back
   * to its front page and this line is never read — so its only job is the other
   * case: the user approved, nothing moved, and without a sentence naming what is
   * still owed the only signal would be the absence of one.
   */
  const approvedLine =
    `${version.mode === 'uat' ? 'Passed' : 'Approved'} ${decisionSubject(version)}` +
    (filed?.decision === 'approve' ? ((owed) => (owed ? ` · ${owed}` : ''))(owedElsewhere()) : '')

  // ── Rows ──────────────────────────────────────────────────────────────────

  const noteRow = (note: Annotation, live: boolean): React.JSX.Element => {
    const status = live ? anchorStatus(note) : null
    return (
      <div
        key={note.id}
        className="px-3 py-2.5"
        style={{ borderTop: '1px solid var(--border-subtle)' }}
        data-testid={live ? 'round-note' : 'review-closed-note'}
        onMouseEnter={() => live && hoverNote(note)}
        onMouseLeave={() => live && hoverNote(null)}
      >
        {note.note.trim().length > 0 && (
          <div className="whitespace-pre-wrap leading-[1.5]" style={{ color: live ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
            {note.note}
          </div>
        )}
        {note.focus && <FocusLabel focus={note.focus} className="block truncate mt-1" />}
        <div className="flex items-center gap-2 flex-wrap mt-1.5">
          <span className="text-[9.5px] tracking-[0.08em]" style={{ color: 'var(--text-muted)' }}>
            {note.scope.toUpperCase()}
          </span>
          {live ? (
            <span
              className="text-[10px] rounded-full px-2 py-px border"
              data-testid="note-state-chip"
              style={
                note.state === 'open'
                  ? {
                      color: 'var(--color-peach)',
                      borderColor: 'color-mix(in srgb, var(--color-peach) 40%, transparent)',
                      background: 'color-mix(in srgb, var(--color-peach) 10%, transparent)',
                    }
                  : {
                      color: 'var(--color-mauve)',
                      borderColor: 'color-mix(in srgb, var(--color-mauve) 40%, transparent)',
                      background: 'color-mix(in srgb, var(--color-mauve) 10%, transparent)',
                    }
              }
            >
              {note.state === 'open' ? 'open' : note.addressedIn ? `updated in ${note.addressedIn}` : 'updated'}
            </span>
          ) : (
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {closedLabel(note)}
            </span>
          )}
          {/* Only the two cases the user has to be WARNED about are drawn: a box
              the PAGE claims (its own voice, never the app's — the 2026-08-14
              adversarial review) and one that needs re-pointing. A note sitting
              where the app itself measured it says nothing. */}
          {status?.text && (
            <span
              className={`text-[10px] px-1 py-0.5 rounded border ${
                status.kind === 'ghost' ? 'text-yellow border-yellow/40 bg-yellow/10' : 'text-blue border-blue/40 bg-blue/10'
              }`}
              title={status.kind === 'reported' ? PAGE_REPORTED_TITLE : undefined}
            >
              {status.text}
            </span>
          )}
          {(note.images ?? []).map((_, i) => (
            <ImageTile key={i} index={i + 1} prefix="note-image" />
          ))}
          {note.sketch && (
            <span className="inline-flex items-center gap-1 text-[10px]" style={{ color: 'var(--color-mauve)' }} data-testid="note-drawing-chip">
              <PencilMark /> drawing
            </span>
          )}
        </div>
        {/* Alternatives the agent attached, as READ-ONLY labels. They used to be
            buttons: clicking one approved the note and named the winner. That
            click is gone with every other per-note verdict (W6) — the user picks
            in chat, which the agent records with canvas_pick. */}
        {note.state === 'addressed' && note.variants && note.variants.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5" data-testid="note-variant-chips">
            {note.variants.map((variant) => (
              <span
                key={variant.key}
                className="px-1.5 py-0.5 text-[10px] rounded border border-green/40 text-green max-w-full truncate"
                title={`The agent built alternative ${variant.key}. Tell it which one you want.`}
                data-testid={`note-variant-${variant.key}`}
              >
                {variant.key} · {variant.label}
              </span>
            ))}
          </div>
        )}
        {!live && pickedVariantLabel(note) && (
          <div className="text-[9.5px] mt-1 truncate" style={{ color: 'var(--color-green)' }} data-testid="review-closed-picked-variant">
            {pickedVariantLabel(note)}
          </div>
        )}
        {/* The residual risk, said out loud on the row it applies to: on an
            agent-closed note the same party did the work AND ended the
            conversation about it. A chat PICK is excluded — there the user
            themselves named the winner. */}
        {!live && note.closedBy === 'agent' && note.closedFrom === 'addressed' && note.pickSource !== 'chat' && (
          <div className="text-[9.5px] mt-1" style={{ color: 'var(--text-muted)' }} data-testid="review-closed-agent-both">
            the agent marked this addressed and closed it — nobody else checked it
          </div>
        )}
        {!live && (
          <div className="mt-1.5">
            <button
              onClick={() => void reopenNote(sessionId, note.id)}
              className="px-1.5 py-0.5 text-[10px] rounded border focus-ring"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
              title="Put this note back in play, exactly where it was before it was closed"
              data-testid="review-reopen-note"
            >
              Reopen
            </button>
          </div>
        )}
      </div>
    )
  }

  /**
   * One ROUND, live or settled.
   *
   * Live is the peach-edged card with the OPEN pill — there is meant to be one,
   * and a user Reopen can legitimately make a second. Settled is the same card
   * without the peach, drawn inside the folded History and wearing the outcome
   * instead of the pill.
   *
   * Both carry a "Closed · N" sub-list, because BOTH can hold settled notes: a
   * live round accumulates them when the agent closes one on the user's word
   * (`canvas_verdict`), and dropping those rows would take the note's text and
   * its Reopen with them. It folds by default on a live round (the live notes
   * are the point there) and is open on a settled one (they are all it has).
   */
  const roundCard = (group: ReviewGroup): React.JSX.Element => {
    const live = group.waitingOn === 'agent'
    const collapsed = isGroupCollapsed(group)
    const key = overrideKey(group.review.id)
    const closedShown = closedOpen[key] ?? !live
    return (
      <div
        key={group.review.id}
        className="rounded-[11px] overflow-hidden"
        style={{
          border: live
            ? '1px solid color-mix(in srgb, var(--color-peach) 35%, var(--border-subtle))'
            : '1px solid var(--border-subtle)',
          background: live ? 'var(--surface-chrome)' : undefined,
        }}
        data-testid="review-group"
        data-review={group.review.id}
      >
        <button
          type="button"
          onClick={() => toggleGroup(group)}
          aria-expanded={!collapsed}
          className="w-full flex items-center gap-2 px-3 py-2 text-left focus-ring"
          style={live ? { background: 'color-mix(in srgb, var(--color-peach) 6%, transparent)' } : undefined}
          data-testid="review-group-toggle"
        >
          <Caret open={!collapsed} />
          <span
            className={live ? 'text-[12px] font-bold' : 'text-[11.5px] font-semibold shrink-0'}
            style={{ color: live ? 'var(--text-primary)' : 'var(--text-secondary)' }}
          >
            {group.review.id.replace('R', 'Review #')}
          </span>
          <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
            on {group.review.versionId}
            {reviewTime(group.review) ? ` · ${reviewTime(group.review)}` : ''}
          </span>
          {live ? (
            <span
              className="ml-auto shrink-0 text-[9.5px] font-extrabold rounded-full px-2 py-px"
              style={{ background: 'var(--color-peach)', color: 'var(--surface-chrome)' }}
              data-testid="round-open-pill"
            >
              OPEN
            </span>
          ) : (
            <span className="ml-auto shrink-0 text-[9.5px] font-semibold" style={{ color: 'var(--text-muted)' }}>
              {roundOutcomeLabel(group, canvasVersions)}
            </span>
          )}
        </button>
        {!collapsed && (
          <>
            {group.notes.map((note) => noteRow(note, live))}
            {group.closedNotes.length > 0 && (
              <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <button
                  type="button"
                  onClick={() => setClosedOpen((p) => ({ ...p, [key]: !(p[key] ?? !live) }))}
                  aria-expanded={closedShown}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left focus-ring"
                  data-testid="review-closed-toggle"
                >
                  {/* NEVER THE SAME NUMBER TWICE. When the agent closed every
                      one of them, "Closed · 3" and "3 on your instruction" are
                      two labels for one fact — so they become one line. The chip
                      stays a separate element only when the counts genuinely
                      differ, which is the only case where reading both tells you
                      something. */}
                  {group.agentClosedCount === group.closedNotes.length ? (
                    <span
                      className="text-[10px]"
                      style={{ color: 'var(--color-mauve)' }}
                      title="Closed by the agent on your instruction — not approved. Reopen any of them below."
                      data-testid="review-agent-closed-chip"
                    >
                      Closed · {group.closedNotes.length} — on your instruction
                    </span>
                  ) : (
                    <>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        Closed · {group.closedNotes.length}
                      </span>
                      {group.agentClosedCount > 0 && (
                        <span
                          className="text-[9.5px] px-1 py-px rounded border"
                          style={{
                            color: 'var(--color-mauve)',
                            borderColor: 'color-mix(in srgb, var(--color-mauve) 40%, transparent)',
                          }}
                          title="Closed by the agent on your instruction — not approved. Reopen any of them below."
                          data-testid="review-agent-closed-chip"
                        >
                          {group.agentClosedCount} on your instruction
                        </span>
                      )}
                    </>
                  )}
                  <div className="flex-1" />
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {closedShown ? 'hide' : 'show'}
                  </span>
                </button>
                {closedShown && group.closedNotes.map((note) => noteRow(note, false))}
              </div>
            )}
            {/* THE ONLY REVIVAL there is, at the round level. Nothing automatic
                may wake a settled round — not a render, not a resolve, not a
                reload — so the user needs one gesture that does, where they can
                see what they are bringing back. */}
            {!live && (
              <div className="px-3 py-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <button
                  onClick={() => void reopenRound(sessionId, canvasId, group.review.id)}
                  className="px-1.5 py-0.5 text-[10px] rounded border focus-ring"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                  title="Put this whole round back in play — every note on it goes live again, exactly where it was"
                  data-testid="review-reopen-round"
                >
                  Reopen round
                </button>
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  /** Why there is no composer, in plain words — never "already decided
   *  (rejected)", which reads like an error code for a thing the user did. */
  const closedVersionLine = (): string => {
    if (version.draft) return 'This version is still being drafted.'
    const verdict = version.verdict
    if (!verdict) return 'This version is not open for review.'
    switch (verdict.state) {
      case 'approved':
        return `${version.id} is approved.`
      case 'rejected': {
        // Name the render that ANSWERED it when there is one — that is the thing
        // the user can go and look at — and only fall back to the wait when the
        // agent has not made it yet. A plan was never rejected: the user asked
        // for revisions, and the line says the word the button said.
        const word = version.mode === 'plan' ? 'went back for revisions' : 'was rejected'
        const answered = answeringVersion(canvasVersions, version.id)
        return answered
          ? `${version.id} ${word} — ${answered.id} answers it.`
          : `${version.id} ${word} — the agent is working on the next version.`
      }
      case 'dismissed':
        return `${version.id} was closed without a review.`
      case 'withdrawn':
        return `${version.id} was withdrawn.`
      case 'superseded':
        return `${version.id} was replaced by a newer version.`
    }
  }

  const rejectNeedsNote = decision === 'reject' && draftNotes.length === 0
  const submitDisabled =
    !versionOpen || decision === null || rejectNeedsNote || submitting || (decision === 'approve' && approveBlock !== null)

  return (
    <div
      ref={panelRef}
      className="w-[352px] shrink-0 flex flex-col min-h-0 text-[12px]"
      style={{ borderLeft: '1px solid var(--border-subtle)', background: 'var(--surface-panel)' }}
    >
      <div
        className="flex items-center gap-2 px-3.5 py-2.5 shrink-0"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <span className="text-[12.5px] font-bold" style={{ color: 'var(--text-primary)' }}>
          Review
        </span>
        <div className="flex-1" />
        {onHide && (
          <DismissButton
            onClick={onHide}
            label="Hide the review panel"
            title="Hide the review panel — the page widens; a thin rail brings it back"
            text="hide"
            data-testid="canvas-panel-hide"
          />
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 canvas-review-scroll px-3 pt-3 pb-1 flex flex-col gap-2.5">
        {/* ── History, folded, at the TOP ──
            Settled rounds are the past. They stay — every note readable, every
            round reopenable — but they fold away, because a pile of settled
            rounds above the live one is exactly what buried the work. */}
        {settledGroups.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              aria-expanded={historyOpen}
              className="flex items-center gap-2 px-3 py-2.5 rounded-[11px] text-left focus-ring"
              style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
              data-testid="canvas-history-folded"
            >
              <span>History</span>
              <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                {settledGroups.length} earlier {settledGroups.length === 1 ? 'round' : 'rounds'} · settled
              </span>
              <div className="flex-1" />
              <Caret open={historyOpen} />
            </button>
            {historyOpen && settledGroups.map(roundCard)}
          </>
        )}

        {liveGroups.map(roundCard)}

        {/* ── This run (M3, Testing mode) ──
            The same unsent notes as below, drawn as EVIDENCE: the screen each
            one locked, what was said about it, and where on the site it
            happened. A test run is a sequence of moments, and a list of
            sentences with no pictures is the wrong shape for reading one
            back. */}
        {testing && draftNotes.length > 0 && (
          <div className="rounded-[10px] overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }} data-testid="canvas-run-notes">
            <div
              className="px-3 py-2 text-[10px] font-extrabold tracking-[0.13em] uppercase"
              style={{ color: 'var(--text-muted)' }}
            >
              This run · {draftNotes.length} {draftNotes.length === 1 ? 'note' : 'notes'}
            </div>
            {draftNotes.map((note) => {
              const stamp = note.evidence?.stamp
              const preview = evidencePreviews[note.id]
              // ONE clock in the product (M3): the shared formatter the MCP
              // serializer and the recall view both use, trimmed to HH:MM
              // because a row this dense does not need the seconds. A second
              // implementation here is exactly how the pane and the agent come
              // to print different times for the same moment.
              const time = stamp ? trailClockTime(stamp.capturedAt).slice(0, 5) : ''
              return (
                <div
                  key={note.id}
                  className="flex items-center gap-2.5 px-3 py-2"
                  style={{
                    borderTop: '1px solid var(--border-subtle)',
                    background: editingId === note.id ? 'var(--surface-raised)' : undefined,
                  }}
                  data-testid="draft-note"
                  onMouseEnter={() => note.focus && setPanelHighlight(sessionId, { rect: note.focus.bboxPage, kind: 'anchored' })}
                  onMouseLeave={() => setPanelHighlight(sessionId, null)}
                >
                  <span
                    className="shrink-0 w-[34px] h-[24px] rounded-[5px] overflow-hidden inline-flex items-center justify-center"
                    style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
                    data-testid="run-note-thumb"
                  >
                    {preview ? (
                      <img src={preview} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden style={{ color: 'var(--text-muted)' }}>
                        <rect x="3" y="6" width="18" height="13" rx="2" />
                        <circle cx="12" cy="12.5" r="3.5" />
                      </svg>
                    )}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-[11.5px]" style={{ color: 'var(--text-primary)' }}>
                    {note.note.trim().length > 0 ? note.note : 'the screen, as it was'}
                  </span>
                  {(stamp?.route || time) && (
                    // The route is the PAGE's word for where this happened, so
                    // it is attributed exactly like every other page-reported
                    // string in the pane; the clock is the host's own.
                    <span
                      className="shrink-0 text-[9.5px]"
                      style={{ color: 'var(--text-muted)' }}
                      title={stamp?.route ? PAGE_REPORTED_TITLE : undefined}
                      data-testid="run-note-meta"
                    >
                      {stamp?.route ? `${PAGE_REPORTED_MARK} ${stamp.route}` : ''}
                      {stamp?.route && time ? ' · ' : ''}
                      {time}
                    </span>
                  )}
                  <button
                    onClick={() => setEditing(sessionId, note.id)}
                    className="shrink-0 text-[10px] focus-ring rounded px-1"
                    style={{ color: 'var(--text-secondary)' }}
                    title="Edit this note"
                    data-testid="draft-note-edit"
                  >
                    edit
                  </button>
                  <button
                    onClick={() => void deleteNote(sessionId, note.id)}
                    className="shrink-0 text-[10px] focus-ring rounded px-1"
                    style={{ color: 'var(--text-secondary)' }}
                    title="Delete this note — its screenshot goes with it"
                    data-testid="draft-note-delete"
                  >
                    delete
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {/* ── Your notes ──
            Written, not sent. They are the user's own and stay editable until
            the round goes out, which is why they sit apart from the round above
            rather than inside it. */}
        {!testing && draftNotes.length > 0 && (
          <div className="rounded-[10px] overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }} data-testid="your-notes">
            <div className="px-3 py-2 text-[11px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
              Your notes
            </div>
            {draftNotes.map((note) => (
              <div
                key={note.id}
                className="px-3 py-2"
                style={{
                  borderTop: '1px solid var(--border-subtle)',
                  background: editingId === note.id ? 'var(--surface-raised)' : undefined,
                }}
                data-testid="draft-note"
                onMouseEnter={() => note.focus && setPanelHighlight(sessionId, { rect: note.focus.bboxPage, kind: 'anchored' })}
                onMouseLeave={() => setPanelHighlight(sessionId, null)}
              >
                {note.note.trim().length > 0 && (
                  <div className="whitespace-pre-wrap leading-[1.5]" style={{ color: 'var(--text-primary)' }}>
                    {note.note}
                  </div>
                )}
                {note.focus && <FocusLabel focus={note.focus} className="block truncate mt-1" />}
                <div className="flex items-center gap-2 flex-wrap mt-1.5">
                  <span className="text-[9.5px] tracking-[0.08em]" style={{ color: 'var(--text-muted)' }}>
                    {note.scope.toUpperCase()}
                  </span>
                  {(note.images ?? []).map((_, i) => (
                    <ImageTile key={i} index={i + 1} prefix="note-image" />
                  ))}
                  {note.sketch && (
                    <span className="inline-flex items-center gap-1 text-[10px]" style={{ color: 'var(--color-mauve)' }}>
                      <PencilMark /> drawing
                    </span>
                  )}
                  <div className="flex-1" />
                  <button
                    onClick={() => setEditing(sessionId, note.id)}
                    className="text-[10px] focus-ring rounded px-1"
                    style={{ color: 'var(--text-secondary)' }}
                    title="Edit this note"
                    data-testid="draft-note-edit"
                  >
                    edit
                  </button>
                  <button
                    onClick={() => void deleteNote(sessionId, note.id)}
                    className="text-[10px] focus-ring rounded px-1"
                    style={{ color: 'var(--text-secondary)' }}
                    title="Delete this note"
                    data-testid="draft-note-delete"
                  >
                    delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── The compose area ──
          Never dead. Either the composer and the decision, or one line saying
          what is happening instead. */}
      {filed ? (
        <div className="px-3 py-3 shrink-0" style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--surface-chrome)' }}>
          <div className="text-[11.5px]" style={{ color: 'var(--text-secondary)' }} data-testid="canvas-filed-waiting">
            {filed.decision === 'reject'
              ? `${filed.reviewId ? filed.reviewId.replace('R', 'Review #') : 'Your review'} filed · waiting on the agent to render ${nextVersion ?? 'the next version'}`
              : approvedLine}
          </div>
          <button
            onClick={() => {
              // Leaving EARLY is race-safe by construction: cancel the store's
              // pending landing first, then do the one navigation.
              useExcalidrawStore.getState().cancelSubmitReturn(sessionId)
              onReturnToTerminal()
            }}
            className="mt-1.5 text-[11px] underline underline-offset-2 focus-ring rounded"
            style={{ color: 'var(--brand)' }}
            title="Returning automatically — click to go now"
            data-testid="canvas-return-to-terminal"
          >
            Return to terminal
          </button>
        </div>
      ) : !versionOpen ? (
        <div
          className="px-3 py-3 shrink-0 text-[11.5px]"
          style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--surface-chrome)', color: 'var(--text-muted)' }}
          data-testid="canvas-version-closed-line"
        >
          {closedVersionLine()}
        </div>
      ) : (
        <>
          {/* ── Composer ── */}
          <div
            className="px-3 py-3 shrink-0 flex flex-col gap-2"
            style={{ borderTop: '1px solid var(--border-subtle)' }}
          >
            <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {(editingNote ? editingNote.focus : focus) ? (
                <FocusLabel
                  focus={(editingNote ? editingNote.focus : focus)!}
                  className="truncate flex-1"
                />
              ) : (
                <>
                  <span
                    className="text-[9.5px] rounded px-2 py-0.5 shrink-0"
                    style={{ border: '1px dashed var(--border-subtle)', color: 'var(--text-secondary)' }}
                  >
                    whole page
                  </span>
                  <span className="truncate flex-1">click an element or drag a region to target</span>
                </>
              )}
              {!editingNote && focus && (
                <>
                  {canExpand && (
                    <button
                      onClick={() => expandFocus(sessionId)}
                      className="px-1 py-0.5 text-[10px] rounded border focus-ring shrink-0"
                      style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                      title="Expand the selection to the parent element (ArrowUp)"
                      data-testid="composer-expand-focus"
                    >
                      parent
                    </button>
                  )}
                  <DismissButton
                    onClick={() => clearFocus(sessionId)}
                    label="Clear the target"
                    title="Clear the selection (Esc)"
                    size={8}
                    data-testid="composer-clear-focus"
                  />
                </>
              )}
            </div>
            {/* What this note will LOCK (M3). The chip is the visible half of
                the pause: the shield says the site is frozen, this says what
                the freeze bought. Said in four words — the promise itself lives
                on the shield, once. */}
            {testing && evidence?.pending && !editingNote && (
              <div
                className="flex items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-[11px] font-semibold"
                style={{
                  color: 'var(--color-green)',
                  background: 'color-mix(in srgb, var(--color-green) 10%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--color-green) 40%, transparent)',
                }}
                data-testid="composer-evidence"
              >
                {evidence.pending.previewDataUrl ? (
                  <img
                    src={evidence.pending.previewDataUrl}
                    alt=""
                    className="h-[24px] w-[34px] rounded-[4px] object-cover shrink-0"
                    style={{ border: '1px solid color-mix(in srgb, var(--color-green) 40%, transparent)' }}
                  />
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className="shrink-0">
                    <rect x="3" y="6" width="18" height="13" rx="2" />
                    <circle cx="12" cy="12.5" r="3.5" />
                  </svg>
                )}
                captured with this note
              </div>
            )}
            {testing && evidence?.notice && !editingNote && (
              <div className="text-[10.5px]" style={{ color: 'var(--color-peach)' }} data-testid="composer-evidence-notice">
                {evidence.notice}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={activeText}
              // Putting the caret in the box IS starting a note (M3). Focus
              // rather than the first keystroke: the screen the user is about
              // to describe is the one in front of them NOW, not the one that
              // survives however long they take to find the first word.
              onFocus={() => beginNoteEvidence()}
              onChange={(e) => {
                // An EDIT writes to its own buffer and never to the composer:
                // the note's words are not the half-written note, and letting
                // them become it is how Cancel used to leave a phantom draft.
                if (editingNote) {
                  editTextRef.current = e.target.value
                  setEditText(e.target.value)
                  return
                }
                composerRef.current.noteText = e.target.value
                dirtyRef.current = true
                setNoteText(e.target.value)
              }}
              placeholder={editingNote ? 'Edit this note…' : 'Write a note for the agent…'}
              rows={3}
              className="w-full resize-y rounded-[9px] px-2.5 py-2 text-[12px] focus:outline-none"
              style={{
                background: 'var(--surface-chrome)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-primary)',
              }}
              data-testid="composer-textarea"
            />
            {activeImages.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap" data-testid="composer-images">
                {activeImages.map((img, i) => (
                  <ImageTile key={i} index={i + 1} pngBase64={img.pngBase64} onRemove={() => removeImage(i)} />
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }} data-testid="composer-paste-hint">
                {activeImages.length === 0
                  ? 'Ctrl+V adds images — Image 1, Image 2…'
                  : 'Ctrl+V pastes another image — inserts ' + imageMarker(activeImages.length + 1) + ' here'}
              </span>
              {unattachedStrokeCount > 0 && !editingNote && (
                <span className="inline-flex items-center gap-1 text-[10px]" style={{ color: 'var(--color-mauve)' }} data-testid="composer-strokes-ride">
                  <PencilMark /> {unattachedStrokeCount} {unattachedStrokeCount === 1 ? 'stroke' : 'strokes'} will ride this note
                </span>
              )}
              <div className="flex-1" />
              {editingNote && (
                <button
                  onClick={cancelEdit}
                  className="px-2 py-1 text-[11px] rounded-[8px] border focus-ring"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                  data-testid="composer-cancel-edit"
                >
                  Cancel
                </button>
              )}
              {/* Testing mode's Cancel (M3): the note is paused over a frozen
                  site, so there has to be a way out that is not "save it
                  anyway". Only while something is actually being written —
                  a Cancel beside an empty composer cancels nothing. */}
              {testing && !editingNote && (evidence?.pending || canAddNote) && (
                <button
                  onClick={cancelComposerNote}
                  className="px-2.5 py-1 text-[11px] rounded-[8px] border focus-ring"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                  title="Throw this note away — the captured screen goes with it (Esc)"
                  data-testid="composer-cancel-note"
                >
                  Cancel
                </button>
              )}
              <button
                onClick={() => void saveNote()}
                disabled={!canAddNote}
                className="px-3.5 py-1.5 text-[12px] font-semibold rounded-[8px] border focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
                // In Testing the save is the ACTION on this screen — it locks
                // the evidence and unfreezes the site — so it wears the accent
                // the mock gives it rather than sitting quiet beside Cancel.
                style={
                  testing && !editingNote
                    ? { borderColor: 'var(--color-peach)', background: 'var(--color-peach)', color: 'var(--surface-chrome)' }
                    : { borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }
                }
                data-testid="composer-add-note"
              >
                {editingNote ? 'Save' : testing ? 'Save note' : 'Add note'}
              </button>
            </div>
            {pasteError && (
              <div className="text-[10.5px]" style={{ color: 'var(--color-red)' }} data-testid="composer-paste-error">
                {pasteError}
              </div>
            )}
            {/* A ceiling the user can HIT should be a sentence, not silence. The
                draft still saves — its words, its target and its images — and the
                drawing stays where they made it for as long as the pane is open. */}
            {sketchTooLarge && (
              <div className="text-[10.5px]" style={{ color: 'var(--text-secondary)' }} data-testid="composer-sketch-too-large">
                drawing too large to keep with the draft — it stays on the canvas while the pane is open
              </div>
            )}
          </div>

          {/* ── Decision ── */}
          <div
            className="px-3 py-3 shrink-0 flex flex-col gap-2"
            style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--surface-chrome)' }}
          >
            {submitError && (
              <div className="text-[10px]" style={{ color: 'var(--color-red)' }} data-testid="canvas-submit-error">
                {submitError}
              </div>
            )}
            <div className="flex gap-2" data-testid="decision-row">
              <button
                onClick={() => {
                  const next = decision === 'approve' ? null : ('approve' as const)
                  // The ref is the composer's truth for every save that fires
                  // outside render, so it moves with the state, not after it.
                  composerRef.current.decision = next
                  dirtyRef.current = true
                  setDecision(next)
                }}
                disabled={approveBlock !== null}
                className="flex-1 text-center text-[12.5px] font-semibold rounded-[9px] py-2 border transition-colors focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
                style={
                  decision === 'approve'
                    ? { background: 'var(--color-green)', borderColor: 'var(--color-green)', color: 'var(--surface-chrome)' }
                    : { borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }
                }
                title={approveBlock ?? undefined}
                data-testid="decision-approve"
              >
                {labels.approve}
              </button>
              <button
                onClick={() => {
                  const next = decision === 'reject' ? null : ('reject' as const)
                  composerRef.current.decision = next
                  dirtyRef.current = true
                  setDecision(next)
                }}
                className="flex-1 text-center text-[12.5px] font-semibold rounded-[9px] py-2 border transition-colors focus-ring"
                style={
                  decision === 'reject'
                    ? { background: 'var(--color-red)', borderColor: 'var(--color-red)', color: 'var(--surface-chrome)' }
                    : { borderColor: 'color-mix(in srgb, var(--color-red) 40%, transparent)', color: 'var(--color-red)' }
                }
                data-testid="decision-reject"
              >
                {labels.reject}
              </button>
            </div>
            {rejectNeedsNote && (
              <div className="text-[10.5px] font-semibold" style={{ color: 'var(--color-red)' }} data-testid="reject-needs-note">
                {version.mode === 'plan'
                  ? 'Revisions need a note — tell the agent what to change.'
                  : "A reject needs a note — tell the agent what's wrong."}
              </div>
            )}
            {/* WHY Approve is dead, on the surface rather than in a tooltip. A
                disabled button with no sentence beside it is the one thing this
                gate must not become. */}
            {approveBlock && (
              <div className="text-[10.5px]" style={{ color: 'var(--text-secondary)' }} data-testid="canvas-approve-blocked">
                Approve is unavailable: {approveBlock}.
              </div>
            )}
            {/* APPROVE MEANS NOTHING OWED, said before the click rather than
                discovered after it. Notes filed with an approval become
                observations: the agent reads them, nothing comes back. Not on a
                plan — there, a note blocks the approval outright. */}
            {version.mode !== 'plan' && decision === 'approve' && draftNotes.length > 0 && (
              <div className="text-[10.5px]" style={{ color: 'var(--text-secondary)' }} data-testid="canvas-approve-observations-warning">
                approve only if none needs work — they&apos;ll be recorded as observations
              </div>
            )}
            <button
              onClick={() => void doSubmit()}
              disabled={submitDisabled}
              className="w-full text-center text-[12.5px] font-bold rounded-[9px] py-2.5 border transition-all focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
              style={
                submitDisabled
                  ? { borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }
                  : decision === 'reject'
                    ? {
                        background: 'var(--color-red)',
                        borderColor: 'var(--color-red)',
                        color: 'var(--surface-chrome)',
                        boxShadow: '0 0 0 3px color-mix(in srgb, var(--color-red) 22%, transparent)',
                      }
                    : {
                        background: 'var(--color-green)',
                        borderColor: 'var(--color-green)',
                        color: 'var(--surface-chrome)',
                        boxShadow: '0 0 0 3px color-mix(in srgb, var(--color-green) 22%, transparent)',
                      }
              }
              title={
                decision === null
                  ? version.mode === 'plan'
                    ? 'Decide first — approve the plan, or submit revisions'
                    : 'Decide first — approve or reject'
                  : 'Send this review to the agent'
              }
              data-testid="canvas-submit"
            >
              {submitting ? 'Submitting…' : submitLabel(version, decision, draftNotes.length)}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
