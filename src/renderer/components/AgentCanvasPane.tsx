import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Excalidraw, restoreElements } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import CanvasEmptyState from './CanvasEmptyState'
import { CanvasLibrary, clearCanvasReadonlyView, useCanvasReadonlyRequest } from './CanvasLibrary'
import CanvasFiledStrip from './CanvasFiledStrip'
import CanvasNotesPanel from './CanvasNotesPanel'
import CanvasCompleteButton from './CanvasCompleteButton'
import CanvasHistoryControl from './CanvasHistoryControl'
import CanvasXrayReadout from './CanvasXrayReadout'
import CanvasPauseShield from './CanvasPauseShield'
import CanvasEvidenceRecall from './CanvasEvidenceRecall'
import { DismissButton } from './ui/DismissButton'
import { useCanvasStore, type CanvasSketchScene } from '../stores/canvasStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { useExcalidrawStore } from '../stores/excalidrawStore'
import {
  MAX_PACK_NAME_CHARS,
  MAX_RESOLVE_ANCHORS,
  CanvasHitInfo,
  CanvasViewportInfo,
  CanvasVersion,
  canvasContentUrl,
  defaultPackName,
  verdictLabel,
  type AnchorRef,
  type CanvasHoverReportingResult,
  type CanvasSnapshotResult,
  type CanvasState,
  type EvidenceCaptureRefusal,
  type StampTarget,
} from '../../shared/canvas'
import { sanitizeSnapshotResult } from '../../shared/canvas-snapshot-sanitize'
import { baselineFromSnapshot, buildEvidenceStamp, type StampBaseline } from '../canvas/canvas-state-stamp'
import {
  markTrailNoteSaved,
  recordTrailEvent,
  recordTrailScroll,
  resetTrail,
  trailForRun,
  trailSinceLastNote,
} from '../canvas/canvas-trail'
import { contentPageRectToStage, stageToContentPagePoint, glassNeedsRepin, glassScrollForContent } from '../utils/canvas-coords'
import { formatCanvasZoom, frameStyleForZoom, stepCanvasZoom } from '../utils/canvas-zoom'
import { safeAnchorResolutions, safeInspectResult } from '../utils/canvas-geometry-guard'
import { registerCanvasFrame } from '../canvas/canvas-snapshot-host'
import { askCanvasFrame, framesInFlight, MAX_FRAME_REQUESTS_IN_FLIGHT } from '../canvas/canvas-frame-rpc'
import { createCanvasInboundChannel } from '../canvas/canvas-inbound-channel'
import { PAGE_REPORTED_MARK, PAGE_REPORTED_TITLE } from '../canvas/page-reported'
import {
  CANVAS_XRAY_MODE_OPTIONS,
  resolveCanvasXrayMode,
  xrayClickSelects,
  xrayDrawsOnPage,
  xrayHoverIsLive,
  xrayReadsOutInPanel,
  type CanvasXrayMode,
} from '../canvas/xray-mode'
import { draftAnnotationsOf, openReviewsOf, openSubmittedNotesOf, useCanvasReviewStore } from '../stores/canvasReviewStore'

/** How long a frame may sit silent before the pane stops claiming it is
 *  loading. A 404, a CSP-blocked bridge script and a crashed page otherwise
 *  look exactly like a slow one — forever. */
const FRAME_READY_TIMEOUT_MS = 8000

/** How long the frame gets to acknowledge an x-ray mode change (#367). Short:
 *  nothing waits on the answer — the host's own gate is what enforces the mode,
 *  and this request only asks the page to stop doing work it need not do. */
const HOVER_REPORTING_TIMEOUT_MS = 3000

/** How many times one intent may be re-sent to a frame that will not confirm
 *  it. The reconcile retries whenever a request settles without the frame
 *  agreeing, so without a cap a page that answers wrongly (or a saturated RPC
 *  cap) would set the host's call rate. A new document and a new intent each
 *  reset it, so this bounds futile retries, never the feature. */
const MAX_HOVER_REPORTING_ATTEMPTS = 3

/** How long the reconcile waits before looking again when the request could not
 *  be SENT at all — the frame's request channel was full, or the send window
 *  below was spent. Both conditions clear on their own in well under a second,
 *  so this is a pause, not a backoff. */
const HOVER_REPORTING_RETRY_MS = 250

/** How many times one attempt may be deferred that way before the pane stops
 *  looking. Bounded because the timer is the HOST's own loop: without a cap a
 *  frame that stays saturated would be polled for the life of the document. */
const MAX_HOVER_REPORTING_DEFERRALS = 12

/**
 * The ceiling on hoverReporting requests actually posted to a frame in one
 * rolling window — the flood budget for this channel.
 *
 * The per-intent attempt budget bounds futile RETRIES; it cannot bound a page
 * that manufactures new intents. `ready` is a page-authored message and every
 * `ready` is a new document with a fresh budget, so a page that simply re-emits
 * it multiplied the host's send rate by the attempt budget — three requests
 * became eighteen after five extra readys (independent review of #405). This
 * bounds the rate whatever drives it; over the ceiling the reconcile waits for
 * the window rather than spending an attempt.
 */
const MAX_HOVER_REPORTING_SENDS_PER_WINDOW = 12
const HOVER_REPORTING_SEND_WINDOW_MS = 1000

/** resolveAnchors RPCs one resolution intent may spend (#368, N1). The frame
 *  can refuse or sit on a resolve forever, and the settle-time retry would
 *  otherwise re-arm it indefinitely — a page-controlled call rate, the exact
 *  class MAX_HOVER_REPORTING_ATTEMPTS exists for. A new intent (zoom, version,
 *  or note set changed) is a fresh budget. */
const MAX_RESOLVE_ATTEMPTS = 3

/**
 * How long the frame gets to describe itself for an evidence STAMP (M3).
 *
 * Much shorter than a `canvas_snapshot`'s 25 s, because a person is waiting: the
 * user has just started typing a note and the site is about to freeze under a
 * shield. A frame that cannot answer in four seconds gives a stamp without a
 * tree — the viewport, the zoom and the host's clock — which is less evidence,
 * not none, and far better than a composer that hangs.
 */
const EVIDENCE_SNAPSHOT_TIMEOUT_MS = 4000

/** Why a capture was refused, in the user's words. A closed vocabulary maps to
 *  a closed set of sentences — nothing free-text from main reaches the UI. */
function captureRefusalWords(reason: EvidenceCaptureRefusal | undefined): string {
  switch (reason) {
    case 'pack-full':
      return 'Evidence limit reached — delete a note or end the run.'
    case 'rate':
      return 'That was too quick after the last capture — try again in a moment.'
    case 'not-uat':
    case 'not-owner':
      return 'This run cannot take screenshots — write the note without one.'
    default:
      return 'Could not capture the page — try again.'
  }
}

/** The page's own account of what was clicked, as the trail stores identity. */
function stampTargetFromHit(hit: CanvasHitInfo | null): StampTarget | null {
  if (!hit) return null
  return { role: hit.role, name: hit.name, ...(hit.uxId ? { uxId: hit.uxId } : {}) }
}

/**
 * The session's CONFIG LABEL, derived exactly as main derives it (M3).
 *
 * A test pack's default name is built from this and then from the canvas title,
 * and it is built TWICE — once here for the pane and the History picker, once in
 * main for the MCP serializer and the Library. Two derivations from different
 * inputs is one pack wearing two names, so both rules main applies are repeated
 * here: TerminalView sends `customName || label || 'default'` into the spawn
 * record, and main reads the literal `'default'` as "this session has no config
 * name" rather than as a name.
 *
 * Returns a primitive, so the selector cannot churn identities.
 */
function useSessionConfigLabel(sessionId: string): string | undefined {
  return useSessionStore((s) => {
    const session = s.sessions.find((x) => x.id === sessionId)
    const label = session?.customName?.trim() || session?.label || 'default'
    return label === 'default' ? undefined : label
  })
}

/** Is the user TYPING here — an editable, or xterm's helper textarea? The
 *  zoom-chord scope test (N3): typing focus refuses the hover claim; any
 *  other focus does not. */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return (el as HTMLElement).isContentEditable === true
}

/**
 * The canvas MODE, in the product's own vocabulary.
 *
 * The pane already used the word "mode" for something else entirely — the
 * interaction mode (Browse / Draw / Region), which decides where clicks land —
 * while the thing the user calls a mode (a mockup, the live site, and in time a
 * plan) was only implied by a small grey word beside the version id. Two
 * different meanings of one word, and the one the user thinks in was the
 * quieter of the two. This badge says which KIND of thing is on the canvas,
 * using the same words as the library so they name the same concept in both
 * places.
 */
function canvasModeBadge(version: CanvasVersion): { label: string; title: string; tone: string } {
  if (version.source.mode === 'uat') {
    return { label: 'Live site', title: 'A built site, served for UI testing', tone: 'var(--color-green)' }
  }
  // Plan gets its own tone as well as its own word. The badge is how you tell,
  // at a glance and from across the pane, whether the thing you are annotating
  // is a picture of a screen or a commitment about work -- and the notes you
  // write on each are different in kind.
  return version.mode === 'plan'
    ? { label: 'Plan', title: 'A plan of work, for review before it starts', tone: 'var(--color-mauve)' }
    : { label: 'Mockup', title: 'A standalone mockup document', tone: 'var(--border-subtle)' }
}

/**
 * The MODE, as the redesigned chrome's leading title (item C): the word the
 * user thinks in — PLAN / MOCKUP / TESTING — in its own colour, with a keel
 * line under the bar echoing it. This is the same fact `canvasModeBadge`
 * carried as a small badge; the redesign promotes it to the title because it is
 * the first thing that should read, and because a plan, a mockup and a live
 * test are annotated differently.
 */
function canvasModeLockup(version: CanvasVersion): { word: string; color: string } {
  if (version.source.mode === 'uat') return { word: 'TESTING MODE', color: 'var(--color-green)' }
  return version.mode === 'plan'
    ? { word: 'PLAN MODE', color: 'var(--color-mauve)' }
    : { word: 'MOCKUP MODE', color: 'var(--color-blue)' }
}

/** The tool-chip glyphs (item C): eye = Inspect, pencil = Sketch, dashed
 *  rectangle + arrow = Region, sliders = Tools. Stroke-only, sized for a 26px
 *  chip, and drawn rather than typed — the repo takes no emoji in JSX. */
function ToolIcon({ kind }: { kind: 'inspect' | 'sketch' | 'region' | 'tools' }) {
  const common = { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  if (kind === 'inspect') {
    return (
      <svg {...common}>
        <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    )
  }
  if (kind === 'sketch') {
    return (
      <svg {...common}>
        <path d="M4 20l3.5-.8L19 7.7a2 2 0 0 0-2.8-2.8L4.8 16.4z" />
      </svg>
    )
  }
  if (kind === 'tools') {
    return (
      <svg {...common}>
        <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
        <circle cx="16" cy="7" r="2" />
        <circle cx="10" cy="17" r="2" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <rect x="4" y="6" width="12" height="10" rx="1" strokeDasharray="3 2.4" />
      <path d="M18 14l3 7-3.2-1.2L16 22z" />
    </svg>
  )
}

/**
 * READ-ONLY (M4) — the one thing that must be legible about a foreign canvas.
 *
 * Worded as a fact about whose work it is, not as a permission error: the user
 * has not been refused anything, they are looking at a finished artefact that
 * belongs to another session. A padlock is drawn rather than typed — the repo
 * takes no emoji in JSX.
 */
function ReadOnlyChip(): React.JSX.Element {
  return (
    <span
      className="shrink-0 inline-flex items-center gap-1 text-[9px] font-bold tracking-[0.06em] rounded px-1.5 py-[3px]"
      style={{
        color: 'var(--text-secondary)',
        background: 'var(--surface-sunken)',
        border: '1px solid var(--border-subtle)',
      }}
      title="Another session made this and signed it off. You can look through it; only its own session can reopen it."
      data-testid="canvas-readonly-chip"
    >
      <svg width="9" height="11" viewBox="0 0 10 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="1.5" y="5" width="7" height="6" rx="1.2" />
        <path d="M3.2 5V3.4a1.8 1.8 0 0 1 3.6 0V5" />
      </svg>
      READ-ONLY · another session&apos;s work
    </span>
  )
}

interface Props {
  sessionId: string
  /**
   * Is this the pane the user is looking at? Every session mounts its own and
   * the rest are hidden with CSS, so the component cannot tell on its own.
   *
   * Only the notes panel uses it, and only to decide whether an addressed round
   * has actually been SEEN — the signal that releases the agent's close-out
   * barrier. Defaults to false, which fails closed: a caller that does not know
   * never claims the user saw anything.
   */
  isActive?: boolean
}

/**
 * Agent Canvas (spec D2/D3): the per-session review surface. With no rendered
 * content it IS the classic Excalidraw scratchpad (nothing the old Draw pane
 * did is lost); once an agent renders a version, the pane becomes the canvas —
 * content iframe below, Excalidraw glass above, transient highlight overlay
 * on top (D7: the glass is a sibling, never injected into content), and the
 * notes panel docked at the right (P3).
 *
 * The draw/browse toggle is THE control of this surface (spec §6): browse
 * gives the pointer to the content (hover reports element names through the
 * bridge; click locks a selection); draw gives the pointer to the glass. The
 * glass is pinned 1:1 over the content — scene scroll is bound to the
 * content's scroll — so marks stay on what they annotate while the page
 * scrolls.
 */
export default function AgentCanvasPane({ sessionId, isActive = false }: Props) {
  const canvasState = useCanvasStore((s) => s.bySessionId[sessionId])
  const refresh = useCanvasStore((s) => s.refresh)
  const clearUnseenRender = useCanvasStore((s) => s.clearUnseenRender)
  const togglePane = useExcalidrawStore((s) => s.togglePane)
  const [libraryOpen, setLibraryOpen] = useState(false)

  useEffect(() => {
    void refresh(sessionId)
  }, [sessionId, refresh])

  // Seeing the pane IS seeing the render: the button's attention pulse ends
  // here, including for a version that arrives while the pane is already up.
  useEffect(() => {
    clearUnseenRender(sessionId)
  }, [sessionId, canvasState?.activeVersionId, clearUnseenRender])

  // The DISPLAY version, not always the active one: while the agent drafts
  // (#366) the active version points at work-in-progress the user has asked
  // not to see, so the pane keeps showing the last READY version until the
  // deliberate ready-mark promotes the draft.
  const activeVersion = useMemo(() => {
    if (!canvasState) return null
    const active = canvasState.versions.find((v) => v.id === canvasState.activeVersionId) ?? null
    if (!active?.draft) return active
    return [...canvasState.versions].reverse().find((v) => !v.draft) ?? null
  }, [canvasState])

  // Only drafts so far: nothing is ready for review, and the empty state alone
  // would read as "no canvas at all" — say what is actually happening.
  const draftPending = !!canvasState?.versions.some((v) => v.draft)

  /**
   * READ-ONLY VIEW (M4) — a completed canvas this session does not own.
   *
   * Memorialised work is shared to the project Library, so any session on the
   * project may LOOK at it; nothing about ownership moves, and Reopen (which
   * restores obligations) stays the owner's. The request arrives from the
   * Library, which is mounted both here and inside the front page — see the
   * note on `requestCanvasReadonlyView` for why it is published rather than
   * passed as a prop.
   *
   * The state comes from `canvas:getReadonly`, which is completed-only and
   * project-scoped in main. This branch is the BELT: main refuses every
   * mutating channel for a caller that does not own the canvas, and the surface
   * below additionally offers none of them.
   */
  const readonlyCanvasId = useCanvasReadonlyRequest(sessionId)
  const [readonlyState, setReadonlyState] = useState<CanvasState | null>(null)
  const [readonlyVersionId, setReadonlyVersionId] = useState<string | null>(null)
  const [readonlyFailed, setReadonlyFailed] = useState(false)

  useEffect(() => {
    setReadonlyState(null)
    setReadonlyVersionId(null)
    setReadonlyFailed(false)
    if (!readonlyCanvasId) return
    let live = true
    void (async () => {
      try {
        const state = await window.electronAPI.canvas.getReadonly({ sessionId, canvasId: readonlyCanvasId })
        if (!live) return
        if (!state) {
          setReadonlyFailed(true)
          return
        }
        setReadonlyState(state)
        // The version main points at, else the newest ready one — a read-only
        // viewer has no active-version of its own to move.
        const ready = [...state.versions].reverse().find((v: CanvasVersion) => !v.draft) ?? null
        const active = state.versions.find((v: CanvasVersion) => v.id === state.activeVersionId && !v.draft) ?? null
        setReadonlyVersionId((active ?? ready)?.id ?? null)
      } catch {
        if (live) setReadonlyFailed(true)
      }
    })()
    return () => {
      live = false
    }
  }, [readonlyCanvasId, sessionId])

  const readonlyVersion = useMemo(
    () => readonlyState?.versions.find((v) => v.id === readonlyVersionId) ?? null,
    [readonlyState, readonlyVersionId],
  )

  const leaveReadonly = useCallback(() => {
    clearCanvasReadonlyView(sessionId)
    setLibraryOpen(true)
  }, [sessionId])

  /**
   * The read-only view dies with the pane.
   *
   * It is a VIEW, not session state: the request slot outlives this component
   * (it is module state, so the Library can raise it from either of its two
   * mount points), and App unmounts the pane on close. Without this, closing
   * the pane while looking at somebody else's finished canvas left the slot
   * set, and the next time the user opened their canvas they got the foreign
   * one back instead of their own work — with no obvious way to tell why.
   * `‹ Library` clears it too, but that is the deliberate exit; this covers
   * every other way out.
   */
  useEffect(() => () => clearCanvasReadonlyView(sessionId), [sessionId])

  if (readonlyCanvasId) {
    return (
      <div className="flex-1 flex flex-col min-h-0 relative pane-fade-in" data-testid="canvas-pane-root">
        {readonlyState && readonlyVersion ? (
          <CanvasSurface
            // Keyed by the FOREIGN canvas, so stepping from one read-only
            // canvas to another remounts every per-version mechanism (the
            // sketch stash, the version-stamp maps) exactly as a Library
            // "open here" does.
            key={`readonly:${readonlyCanvasId}`}
            readOnly
            sessionId={sessionId}
            canvasId={readonlyCanvasId}
            title={readonlyState.title}
            version={readonlyVersion}
            versions={readonlyState.versions}
            // The displayed version is LOCAL here: `setActiveVersion` would
            // move the session's own canvas, which is not the one on screen.
            onSelectVersion={setReadonlyVersionId}
            onOpenLibrary={leaveReadonly}
            isActive={isActive}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center" data-testid="canvas-readonly-unavailable">
            <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              {readonlyFailed
                ? 'That canvas is not readable from this session — it may have been deleted, or it belongs to another project.'
                : 'Opening…'}
            </p>
            <button
              onClick={leaveReadonly}
              className="text-[11.5px] rounded px-2 py-0.5 border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-ring"
            >
              Back to the Library
            </button>
          </div>
        )}
      </div>
    )
  }

  // The library lives HERE, above the empty-state branch, not inside the
  // surface. Deleting the canvas you are looking at empties the pane, which
  // used to unmount the very overlay the delete button was in — a destructive
  // control that destroys its own host, mid-action.
  if (!canvasState?.canvasId || !activeVersion) {
    return (
      // `pane-fade-in` (W23): the canvas half of the swap. The class is static
      // because the element is created BY the swap — mounting is the trigger.
      <div className="flex-1 flex flex-col min-h-0 pane-fade-in" data-testid="canvas-pane-root">
        <CanvasFiledStrip sessionId={sessionId} />
        {draftPending && (
          <div
            className="shrink-0 px-3 py-1.5 text-[11px] border-b"
            style={{
              color: 'var(--text-secondary)',
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--status-warning) 8%, transparent)',
            }}
            data-testid="canvas-draft-pending"
          >
            The agent is preparing a draft here — nothing is ready for your review yet.
          </div>
        )}
        <CanvasEmptyState sessionId={sessionId} onClose={() => togglePane(sessionId)} />
        {libraryOpen && (
          <CanvasLibrary sessionId={sessionId} onClose={() => setLibraryOpen(false)} onOpened={() => setLibraryOpen(false)} />
        )}
      </div>
    )
  }
  return (
    <div className="flex-1 flex flex-col min-h-0 relative pane-fade-in" data-testid="canvas-pane-root">
      {/* Above the surface, so the one thing that happened without asking is
          the first thing read. */}
      <CanvasFiledStrip sessionId={sessionId} />
      <CanvasSurface
        // Keyed by CANVAS (quality MED-2): a Library "open here" swaps the
        // canvas under a mounted surface, and every per-version mechanism
        // (the armed decision, the sketch stash, version-stamp maps) keys on
        // version ids that repeat across canvases — v1 exists on all of them.
        // Remounting is the one reset that cannot miss a ref.
        key={canvasState.canvasId}
        sessionId={sessionId}
        canvasId={canvasState.canvasId}
        title={canvasState.title}
        version={activeVersion}
        versions={canvasState.versions}
        onOpenLibrary={() => setLibraryOpen(true)}
        isActive={isActive}
      />
      {libraryOpen && (
        <CanvasLibrary sessionId={sessionId} onClose={() => setLibraryOpen(false)} onOpened={() => setLibraryOpen(false)} />
      )}
    </div>
  )
}

interface SurfaceProps {
  sessionId: string
  canvasId: string
  /** The canvas's SUBJECT. Undefined for a canvas rendered before titles. */
  title?: string
  version: CanvasVersion
  versions: CanvasVersion[]
  /** Owned by the pane, not by this surface: the library has to outlive a
   *  delete that empties the pane. */
  onOpenLibrary: () => void
  /** Straight through to the notes panel — see AgentCanvasPane's Props. */
  isActive: boolean
  /**
   * READ-ONLY (M4): this canvas is a COMPLETED one the session does not own.
   *
   * A security-relevant UI contract, so it is a prop threaded through the one
   * surface rather than a fork: every mutating affordance is absent (not
   * disabled — a disabled control still reads as "this could apply"), and the
   * whole set is enumerated where each is suppressed. Main refuses each of
   * these channels for a foreign caller as well; this is the belt.
   */
  readOnly?: boolean
  /** READ-ONLY only: which version is displayed is the pane's local state here,
   *  because `setActiveVersion` would move the session's OWN canvas. */
  onSelectVersion?: (versionId: string) => void
}

interface HoverState {
  hit: CanvasHitInfo
}

interface MarqueeDrag {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Smallest marquee (stage px) that becomes a region — below this it was a
 *  click, not a drag. */
const MARQUEE_MIN_PX = 8

/** The glass's default stroke — a red that cannot be mistaken for part of the
 *  page it is drawn over (Catppuccin Latte red; the glass is always light).
 *  A literal, not `var(--color-red)`: this goes into Excalidraw's appState,
 *  which is data rather than CSS, and a token string there would be written
 *  verbatim into every element's `strokeColor` and painted as an invalid
 *  colour. */
const SKETCH_STROKE_COLOR = '#d20f39'

/** Excalidraw's FONT_FAMILY.Helvetica — the plain sans. Its default is the
 *  hand-drawn face, which is charming on a whiteboard and hard to read as a
 *  label pinned to someone's mockup. Written as the number the enum resolves
 *  to because appState is handed over as opaque initial data. */
const SKETCH_FONT_FAMILY = 2

/** How many elements a restored scene may carry. A stored scene comes back
 *  through `reviews.json`, which carries no MAC of its own, so the count is
 *  bounded before anything is normalised: a file naming a million elements
 *  would otherwise spend the frame budget inside Excalidraw's restore. Well
 *  above any real annotation pass — a busy review is tens of strokes. */
const MAX_RESTORED_SKETCH_ELEMENTS = 2000

/** The belt's way of saying "the user cleared the glass" out loud. */
const EMPTY_SKETCH_SCENE: CanvasSketchScene = { scene: '[]', versions: {} }

function CanvasSurface({
  sessionId,
  canvasId,
  title: canvasTitle,
  version,
  versions,
  onOpenLibrary,
  isActive,
  readOnly = false,
  onSelectVersion,
}: SurfaceProps) {
  const togglePane = useExcalidrawStore((s) => s.togglePane)
  /**
   * Closing the pane, from wherever the gesture came.
   *
   * A read-only view must not survive the close: the request slot is module
   * state that outlives this tree, so leaving it set would show the user
   * somebody else's canvas the next time they opened their own. The pane's
   * unmount effect covers the same ground; this makes the deliberate gesture
   * self-contained rather than dependent on App still unmounting the pane.
   */
  const closePane = useCallback(() => {
    if (readOnly) clearCanvasReadonlyView(sessionId)
    togglePane(sessionId)
  }, [readOnly, sessionId, togglePane])
  // #478: the submit hand-back in flight — the close control disables so the
  // submit-triggered transition is the only driver of pane state.
  const returning = useExcalidrawStore((s) => !!s.submitReturnBySession[sessionId])
  // #476: viewing a canvas already signed off. The review panel (and its rail)
  // stay away — nothing is owed on it by invariant, and note-taking on a
  // completed subject is off until the user Reopens it.
  const viewingCompletedOwn = useCanvasStore((s) => !!s.bySessionId[sessionId]?.completed)
  /**
   * ANNOTATION IS OFF — the union of "signed off" and "someone else's".
   *
   * The two arrive by different routes and mean different things (one is undone
   * by Reopen, the other never transfers), but they suppress the same set, so
   * the chips and the panel test this rather than either flag on its own.
   */
  const viewingCompleted = viewingCompletedOwn || readOnly
  const sessionMode = useCanvasStore((s) => s.bySessionId[sessionId]?.interactionMode ?? 'browse')
  // A read-only surface is always BROWSE. The interaction mode is per-SESSION
  // state, so it belongs to the session's own canvas — a foreign document must
  // neither read it nor move it.
  const mode = readOnly ? 'browse' : sessionMode
  const setInteractionMode = useCanvasStore((s) => s.setInteractionMode)
  const setActiveVersion = useCanvasStore((s) => s.setActiveVersion)

  // X-ray hover mode (#367) — PER USER, so it comes from settings rather than
  // from the canvas store where the per-canvas interaction mode lives. Every
  // read goes through the resolver: an absent or hand-edited value is 'on'.
  // A PLAN page is always 'stealth' (owner call, 2026-08-23): the boxes-on-page
  // x-ray adds nothing over a document of steps, and Off would break note
  // anchoring — the panel readout keeps working, the page stays clean.
  const settingsXrayMode = resolveCanvasXrayMode(useSettingsStore((s) => s.settings.canvasXrayMode))
  const xrayMode: CanvasXrayMode = version.mode === 'plan' ? 'stealth' : settingsXrayMode

  // The review mirror is keyed by SESSION, so everything it holds describes the
  // session's OWN canvas. On a read-only surface that is a different canvas
  // entirely, and its focus box, its highlight and its armed region would be
  // painted over someone else's document — so they are dropped here rather than
  // at each use site.
  const ownFocus = useCanvasReviewStore((s) => s.bySessionId[sessionId]?.focus ?? null)
  const focus = readOnly ? null : ownFocus
  const ownMarqueeArmed = useCanvasReviewStore((s) => s.bySessionId[sessionId]?.marqueeArmed ?? false)
  const marqueeArmed = readOnly ? false : ownMarqueeArmed
  const ownPanelHighlight = useCanvasReviewStore((s) => s.bySessionId[sessionId]?.panelHighlight ?? null)
  const panelHighlight = readOnly ? null : ownPanelHighlight
  const ownReviewSession = useCanvasReviewStore((s) => s.bySessionId[sessionId])
  const reviewSession = readOnly ? undefined : ownReviewSession
  const setMarqueeArmed = useCanvasReviewStore((s) => s.setMarqueeArmed)

  // #476: the MODES go with the chips. interactionMode/marqueeArmed are
  // per-session renderer state that survives the detach and the adopt, so
  // without this a pane opened onto a completed canvas could arrive with the
  // glass live in Sketch and no panel to receive the strokes.
  //
  // READ-ONLY never runs it: `mode` is already forced to browse locally, and
  // writing the session's own interaction state while looking at somebody
  // else's canvas would silently change the mode of the canvas underneath.
  useEffect(() => {
    if (readOnly || !viewingCompleted) return
    setInteractionMode(sessionId, 'browse')
    setMarqueeArmed(sessionId, false)
  }, [readOnly, viewingCompleted, sessionId, setInteractionMode, setMarqueeArmed])

  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  /** The pane's root element — the scope of the HOST-side zoom gesture (#368):
   *  a Ctrl+wheel over the chrome, the glass or the notes panel zooms the
   *  content, and the zoom chords apply only while the pane is hovered or holds
   *  focus, so a terminal's shortcuts in another pane are never contested. */
  const paneRootRef = useRef<HTMLDivElement | null>(null)
  const glassApiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  /**
   * C1 (owner bug report 2026-08-26): sketches belong to the version they
   * were drawn on. Every glass element is stamped with the version on screen
   * when it first appears; on a version switch, foreign-version elements are
   * lifted out of the live scene into the stash (and restored when their
   * version comes back). The submit path reads the UNION, so a note's sketch
   * still exports whichever version is currently displayed.
   */
  const sketchVersionRef = useRef(new Map<string, string>())
  const foreignSketchStashRef = useRef(new Map<string, ReturnType<ExcalidrawImperativeAPI['getSceneElements']>[number]>())
  /** The last scene the glass REPORTED, kept so a read after the glass has been
   *  torn down still has an answer (W20 — see allSketchElements). */
  const lastSceneRef = useRef<ReturnType<ExcalidrawImperativeAPI['getSceneElements']>[number][]>([])
  /** Has this canvas ever held a mark in this mount? Only then is an empty
   *  glass a DELETION worth parking, rather than a canvas nobody drew on. */
  const hadSketchElementsRef = useRef(false)
  /**
   * A fingerprint of the live element set, so the revision below counts CHANGES
   * rather than callbacks. Excalidraw fires `onChange` for camera moves and
   * selection as well as edits, and the pane repins the camera constantly — a
   * counter driven by the callback alone would re-render the panel on every
   * scroll of the page underneath.
   *
   * Ids plus each element's own version counters: that is what Excalidraw
   * itself uses to decide an element changed, so a drag's intermediate states
   * register (the stroke is growing) while a pure camera move does not.
   */
  const sketchFingerprintRef = useRef('')
  /** The rAF holding one pending bump, so a drag is one re-render per frame
   *  rather than one per mouse move. */
  const sketchBumpFrameRef = useRef<number | null>(null)
  const repinPendingRef = useRef(false)
  const viewportRef = useRef<CanvasViewportInfo | null>(null)
  const modeRef = useRef(mode)
  const xrayModeRef = useRef(xrayMode)
  const versionIdRef = useRef(version.id)
  /**
   * What the CURRENT document says it is doing about hover reporting. A bridge
   * starts reporting, so a freshly loaded frame is `true` and only a mode that
   * disagrees costs a round-trip. Written from the frame's ANSWER, never from
   * the send.
   *
   * `'unknown'` is a real third state, not a spelling of `true`. A request that
   * settles without a boolean — refused, timed out, answered with something the
   * frame did not have to mean — leaves the host with NO account of what the
   * frame is doing, and leaving the last belief standing there is a lie the
   * reconcile then acts on: the bridge applies hoverReporting and only then
   * replies (canvas/bridge), so an Off whose ack is dropped has quieted a frame
   * the host still believes is loud. Flip to On and desire (true) matched
   * belief (true), the reconcile short-circuited, and the frame stayed quiet for
   * the life of the document — x-ray On drawing nothing and clicks selecting
   * nothing, with no report left to repair from (fix-delta verification, #405).
   * Unknown never equals what is wanted, so it always re-sends.
   */
  const frameHoverReportingRef = useRef<boolean | 'unknown'>(true)
  /** One hoverReporting request in flight at a time. */
  const hoverReportingPendingRef = useRef(false)
  /**
   * Which document the in-flight request is about.
   *
   * Bumped on every `ready`. An answer is only believed about the document it
   * was asked of: an in-frame navigation replaces the bridge while a request is
   * parked, and letting the old document's answer land on the new one's state
   * re-opened the exact bug e608cf32 closed, through the other door (independent
   * review of #405).
   */
  const frameGenerationRef = useRef(0)
  /**
   * Attempts spent on the current intent. A frame can refuse (the RPC's
   * in-flight cap), time out, or answer something other than what it was asked
   * — and the reconcile below retries — so something has to stop a page that
   * will never comply from choosing the host's call rate. The budget belongs to
   * one intent, so it bounds futile retries rather than the feature.
   */
  const hoverReportingAttemptsRef = useRef(0)
  /** Which intent that budget belongs to: `<document generation>:<wanted>`. A
   *  new document or a new answer to want is a new intent and a fresh budget.
   *  Kept as one derived key so there is a single place that decides, rather
   *  than a reset at each call site — `ready` and the effect that follows it
   *  are the same intent, and resetting in both handed it a double budget. */
  const hoverReportingIntentRef = useRef('')
  /** How many times the CURRENT attempt has been deferred because the request
   *  could not be posted at all. Reset when one is actually dispatched, and
   *  with the intent. */
  const hoverReportingDeferralsRef = useRef(0)
  /** The one outstanding deferral timer, so a deferral cannot fan out. */
  const hoverReportingRetryTimerRef = useRef<number | null>(null)
  /** The rolling send window: requests posted since `start`. */
  const hoverReportingWindowRef = useRef({ start: 0, sent: 0 })
  /** Self-reference for the post-settle reconcile, held in a ref so the
   *  recursion does not depend on which render's binding was captured. */
  const syncHoverReportingRef = useRef<() => void>(() => {})
  /** One outstanding inspect per frame — a page-driven click cannot open a
   *  second one while the first is unanswered. */
  const inspectPendingRef = useRef(false)
  /** The zoom the last successful resolution pass ran under (#368): a pass
   *  belongs to a layout, and a zoom step changes the layout. */
  const resolvedZoomRef = useRef(1)
  /** ONE resolveAnchors in flight from the resolution effect (A1); the skip
   *  flag records that the guard turned something away, so the settle can
   *  schedule the retry. */
  const resolvePendingRef = useRef(false)
  const resolveSkippedRef = useRef(false)
  const [resolveRetryNonce, setResolveRetryNonce] = useState(0)
  /** The retry's attempt budget, per intent (version + zoom + note set). The
   *  frame can refuse or never answer a resolve, and the settle-time retry
   *  re-arms it — so without a budget a page that never complies chooses the
   *  host's call rate forever (the same reason hover reporting carries
   *  MAX_HOVER_REPORTING_ATTEMPTS; independent review, N1). A new intent — the
   *  user zooming again, a version switch, a note added — is a fresh budget. */
  const resolveIntentRef = useRef('')
  const resolveAttemptsRef = useRef(0)

  const [bridgeReady, setBridgeReady] = useState(false)
  const bridgeReadyRef = useRef(false)
  /** The page flooded the bridge and its channel was dropped: live inspection
   *  is over for this load, and the user is told rather than left with a pane
   *  that has quietly stopped responding. */
  const [bridgeFlooded, setBridgeFlooded] = useState(false)
  const [viewport, setViewport] = useState<CanvasViewportInfo | null>(null)
  /** Content zoom (#368) — a ladder value, 1 when unzoomed. Pane-local like a
   *  browser tab's zoom: it survives version switches in this mount and resets
   *  when the pane closes. The iframe carries it as CSS zoom with its layout
   *  size compensated, so 1 content px paints as `zoom` stage px; every
   *  content↔stage conversion and the glass binding fold the factor in. */
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(1)
  const [hover, setHover] = useState<HoverState | null>(null)
  const [marqueeDrag, setMarqueeDrag] = useState<MarqueeDrag | null>(null)
  // Load health. `frameLoaded` is the browser's own load event (it fires for an
  // error document too, so it is not by itself a health signal); `loadTimedOut`
  // is what turns "still loading" into "this did not work".
  const [frameLoaded, setFrameLoaded] = useState(false)
  const [loadTimedOut, setLoadTimedOut] = useState(false)
  // Bumping this re-mounts the iframe: the retry affordance for a dead render.
  const [reloadNonce, setReloadNonce] = useState(0)
  // The review panel can be hidden (item C): the page takes the full width and
  // a thin rail keeps the outstanding count and the way back. Pane-local, like
  // the zoom — it resets when the pane closes.
  const [panelHidden, setPanelHidden] = useState(false)
  // Are Excalidraw's islands on screen (W17)? Draw mode only — outside it there
  // are none to hide. Shown by default: hiding the tools by default would make
  // draw mode look broken. Pane-local, like the zoom.
  const [toolsVisible, setToolsVisible] = useState(true)
  /**
   * How many times the glass's element set has changed in this mount (W20).
   *
   * The panel reads the unattached strokes through a plain function call, which
   * is not reactive — so without a value it can depend on, drawing changed
   * nothing it could see: "Add note" stayed disabled after a drawing until the
   * user toggled Sketch off and back on, and a drawing-only draft never reached
   * disk. A COUNTER, not the scene: the panel needs to know that it changed,
   * never what changed, and handing it elements would re-render it on identity
   * alone.
   */
  const [sketchRevision, setSketchRevision] = useState(0)

  // ── Testing mode: evidence, the pause, the trail (M3) ──────────────────────
  //
  // A note in Testing mode is a LOCKED EVIDENCE RECORD, so the pane has three
  // extra jobs the other modes never ask of it: freeze the site while a note is
  // written, screenshot the framed page as the note begins, and keep a running
  // record of what the user did. All three are gated on the version's own MODE
  // LABEL (`version.mode`), never on `source.mode` — a plan is served exactly as
  // a mockup is, and a mockup must never sprout a shield.
  const isTesting = version.mode === 'uat'
  const versionOpen = !version.draft && !version.verdict
  const isTestingRef = useRef(isTesting)
  isTestingRef.current = isTesting
  const versionOpenRef = useRef(versionOpen)
  versionOpenRef.current = versionOpen
  /**
   * READ-ONLY, readable from the bridge callbacks.
   *
   * The inbound channel is built once per document and its handlers close over
   * refs, so a prop alone cannot reach them — and this is the one flag that
   * MUST reach them: the content-click path is the only way into the pane's
   * write side that the user does not press a button for.
   */
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  /** The framed stage — the rectangle `capturePage` is asked for. Not the
   *  iframe: the frame's border and the layers over it are what the user sees
   *  as "the page under review". */
  const contentFrameRef = useRef<HTMLDivElement | null>(null)
  /** The capture waiting to be locked to a note, or null when the site is live.
   *  Its presence IS the paused state — one fact, so the shield and the
   *  composer's chip can never disagree. */
  const [pendingEvidence, setPendingEvidence] = useState<{ evidenceId: string; previewDataUrl?: string } | null>(null)
  const pendingEvidenceRef = useRef(pendingEvidence)
  pendingEvidenceRef.current = pendingEvidence
  /** Why the last capture did not happen, in the user's words. The note can
   *  still be written — an evidence pack with a gap beats a refused note. */
  const [evidenceNotice, setEvidenceNotice] = useState<string | null>(null)
  /** One capture at a time. A focus, a paste and a stroke can all arrive in the
   *  same breath and each of them starts a note. */
  const evidenceBusyRef = useRef(false)
  /**
   * Host layers are hidden for the shot.
   *
   * `capturePage` photographs the WINDOW, so everything the host paints over the
   * frame lands in the picture: the hover box, the locked-selection label, the
   * marquee — and the glass, whose strokes the recall view lays back over the
   * shot from their own PNG and would otherwise draw twice.
   */
  const [capturingEvidence, setCapturingEvidence] = useState(false)
  /**
   * The run's BASELINE field lengths, taken when this version first reported in.
   *
   * This is what turns "there is text in this box" into "the user changed this
   * box during the test" without either string ever existing outside the page.
   */
  const baselineRef = useRef<StampBaseline | null>(null)
  const baselineForRef = useRef<string | null>(null)
  /** The panel's "cancel this note", registered by the panel so Escape on the
   *  shield does exactly what the composer's Cancel does. */
  const cancelNoteRef = useRef<(() => void) | null>(null)
  /** The pack-name chip, mid-rename. Pane-local like the zoom: a rename in
   *  flight is not worth persisting, and abandoning it is the common case. */
  const [renamingPack, setRenamingPack] = useState(false)
  const [packDraft, setPackDraft] = useState('')

  const contentUrl = useMemo(
    () => canvasContentUrl(canvasId, version.id, version.source.entry),
    [canvasId, version],
  )

  viewportRef.current = viewport
  modeRef.current = mode
  xrayModeRef.current = xrayMode
  versionIdRef.current = version.id
  zoomRef.current = zoom

  // C1: swap the glass to the displayed version's sketches. Foreign-version
  // elements are stashed (not deleted — the submit path reads the union and a
  // return to their version restores them); elements never stamped (drawn
  // before this shipped) are adopted by the version on screen.
  useEffect(() => {
    const api = glassApiRef.current
    if (!api) return
    const live = api.getSceneElements()
    const keep: (typeof live)[number][] = []
    let changed = false
    for (const el of live) {
      const stamp = sketchVersionRef.current.get(el.id) ?? version.id
      if (stamp === version.id) {
        sketchVersionRef.current.set(el.id, stamp)
        keep.push(el)
      } else {
        foreignSketchStashRef.current.set(el.id, el)
        changed = true
      }
    }
    for (const [id, el] of foreignSketchStashRef.current) {
      if (sketchVersionRef.current.get(id) === version.id) {
        keep.push(el)
        foreignSketchStashRef.current.delete(id)
        changed = true
      }
    }
    if (changed) api.updateScene({ elements: keep })
  }, [version.id])

  // ── The glass, as something that survives the pane (W20) ──────────────────
  // Sketches used to live for exactly as long as the mounted Excalidraw did:
  // glance at the terminal mid-review and every mark was gone, with no warning
  // and nothing to undo. Two mechanisms bring them back. The panel PERSISTS the
  // scene (it owns the composer-draft IPC, so the strokes ride the draft note
  // they were drawn for); the pane keeps an in-memory stash per canvas as a
  // belt, so the common case — pane closed and reopened in the same breath —
  // restores in the same frame instead of waiting on a disk read.

  /** Every mark this canvas holds: the live scene PLUS the other versions'
   *  marks lifted out by the swap above. Both paths that leave the pane —
   *  persist and submit — need the union, or a version switch made after
   *  drawing silently drops half of it. */
  const allSketchElements = useCallback((): ReturnType<ExcalidrawImperativeAPI['getSceneElements']>[number][] => {
    let live: ReturnType<ExcalidrawImperativeAPI['getSceneElements']>[number][] = []
    try {
      live = [...(glassApiRef.current?.getSceneElements() ?? [])]
    } catch {
      /* see the fallback below — a torn-down glass, asked one last question */
    }
    // The api outlives the component that handed it over, and the LAST read of
    // it is the one that matters: the panel persists on its own unmount, and it
    // is a later sibling than the glass, so by then Excalidraw's fiber is gone
    // and its answer may be nothing at all. Falling back to the last scene it
    // reported means the save that closes the pane still carries the marks.
    // Safe against resurrection: `onChange` fires for a deletion too, so an
    // emptied glass empties this as well and the fallback has nothing to give.
    if (live.length === 0 && lastSceneRef.current.length > 0) live = [...lastSceneRef.current]
    return [...live, ...foreignSketchStashRef.current.values()]
  }, [])

  /** A restore asked for before the glass existed. The panel reads its draft
   *  over IPC and can answer either side of Excalidraw's api callback, so the
   *  scene waits here rather than being dropped. */
  const pendingRestoreRef = useRef<CanvasSketchScene | null>(null)
  /** The belt has already been unrolled for this mount — so a re-render, or a
   *  second api callback, cannot re-apply a scene the user has since edited. */
  const beltAppliedRef = useRef(false)

  /** Serialise the glass for whoever is persisting it. Null when there is
   *  nothing to save, so an empty glass never overwrites a stored scene. */
  const getSketchSceneForPersist = useCallback((): CanvasSketchScene | null => {
    const all = allSketchElements()
    if (all.length === 0) return null
    const versions: Record<string, string> = {}
    for (const el of all) {
      // The stamp, not the version on screen: an element restored into a
      // different version's view must keep the version it was drawn on, which
      // is the whole point of the stash.
      const stamp = sketchVersionRef.current.get(el.id)
      if (stamp) versions[el.id] = stamp
    }
    return { scene: JSON.stringify(all), versions }
  }, [allSketchElements])

  /**
   * Put a serialised scene back on the glass.
   *
   * A MERGE by element id, not a replacement: what is already on the glass
   * wins. On a fresh mount there is nothing live and this is exactly a restore;
   * later — a slow IPC answer landing after the user has started drawing — it
   * cannot undo a stroke they just made.
   *
   * Everything here is UNTRUSTED SHAPE. The scene comes back from
   * `reviews.json`, which carries no MAC of its own, and an element that is
   * merely the wrong shape does not fail politely: Excalidraw reads it during
   * render, throws, and takes the App-wide error boundary with it — on every
   * mount of that canvas, which is a canvas the user can no longer open. So the
   * list is capped, run through Excalidraw's OWN `restoreElements` normaliser
   * (the same one its file import uses, which fills defaults and discards what
   * it cannot repair), and the whole thing is wrapped: malformed is DROPPED,
   * never fatal.
   *
   * Returns whether the glass ACTUALLY moved — true only when at least one
   * element was added and Excalidraw took it. The panel arms an
   * ignore-the-next-revision flag before calling this, because a restore it
   * asked for is not the user drawing; a restore that changes nothing produces
   * no `onChange`, so a flag armed on faith stays armed and eats the dirty-mark
   * of the user's first REAL stroke. Every no-op path below says so: nothing
   * parsed, no glass yet, everything already known, all of it another version's,
   * or dropped by the normaliser.
   */
  const restoreSketchScene = useCallback(
    (saved: CanvasSketchScene): boolean => {
      let parsed: unknown
      try {
        parsed = JSON.parse(saved.scene)
      } catch {
        return false
      }
      if (!Array.isArray(parsed)) return false
      const api = glassApiRef.current
      if (!api) {
        pendingRestoreRef.current = saved
        return false
      }
      // Sift BEFORE the normaliser, not after. `restoreElements` reads
      // `element.type` on every entry with no null guard, so one `null` or bare
      // number in the list throws — and the catch below would then discard the
      // whole scene, losing every good stroke to one bad neighbour. Dropping an
      // entry has to cost that entry only. The cap comes after the sift so a
      // file padded with junk cannot spend the budget keeping real marks out.
      const candidates = parsed.filter(
        (el): el is Record<string, unknown> =>
          !!el && typeof el === 'object' && !Array.isArray(el) && typeof (el as { id?: unknown }).id === 'string',
      )
      let normalised: ReturnType<typeof restoreElements> = []
      try {
        // `null` local elements: this is a restore of a stored scene, not a
        // reconciliation against a live one — the merge below is ours, by id.
        normalised = restoreElements(candidates.slice(0, MAX_RESTORED_SKETCH_ELEMENTS) as never, null)
      } catch {
        // A scene that cannot even be normalised is not worth a broken canvas.
        return false
      }
      for (const [id, stamp] of Object.entries(saved.versions ?? {})) {
        if (typeof id === 'string' && typeof stamp === 'string' && !sketchVersionRef.current.has(id)) {
          sketchVersionRef.current.set(id, stamp)
        }
      }
      const live = api.getSceneElements()
      const known = new Set<string>([...live.map((el) => el.id), ...foreignSketchStashRef.current.keys()])
      const keep = [...live]
      for (const el of normalised) {
        if (!el || typeof el.id !== 'string' || known.has(el.id)) continue
        known.add(el.id)
        const stamp = sketchVersionRef.current.get(el.id) ?? versionIdRef.current
        sketchVersionRef.current.set(el.id, stamp)
        // Marks made on another version go straight to the stash, exactly as
        // the version swap would have put them there.
        if (stamp === versionIdRef.current) keep.push(el)
        else foreignSketchStashRef.current.set(el.id, el)
      }
      if (keep.length === live.length) return false
      try {
        api.updateScene({ elements: keep })
      } catch {
        // The glass refused the scene — the pane still opens, empty-handed, and
        // nothing changed, so the caller must not believe it did.
        return false
      }
      return true
    },
    [],
  )

  /**
   * Which marks on the DISPLAYED version are not yet spoken for by a note.
   *
   * The panel used to make the user press "attach selected sketch" — an extra
   * deliberate step for something they had just drawn on purpose. Now the
   * strokes ride the note automatically, which only works if the pane can say
   * which ones are still free: the attached set is what stops the next note
   * taking the previous note's drawing a second time.
   */
  const getUnattachedSketchElementIds = useCallback((): string[] => {
    const api = glassApiRef.current
    if (!api) return []
    // Two sources, because the in-memory set is only half the truth. It is
    // renderer memory, so a restart empties it — and the draft notes it was
    // tracking come BACK from disk with their strokes still named in
    // `sketch.excalidrawElementIds`. Without the second source the marks a
    // draft note already carries read as free again after a restart, and the
    // next note takes them a second time. The notes are the durable record;
    // the set is the fast path for this session.
    const session = useCanvasReviewStore.getState().bySessionId[sessionId]
    const attached = new Set(useCanvasStore.getState().sketchByCanvasId[canvasId]?.attached ?? [])
    if (session) {
      for (const note of draftAnnotationsOf(session)) {
        for (const id of note.sketch?.excalidrawElementIds ?? []) attached.add(id)
      }
    }
    return api
      .getSceneElements()
      .filter((el) => {
        if (el.isDeleted || attached.has(el.id)) return false
        // The live scene already holds only the displayed version's marks, but
        // say it anyway: an element drawn before stamping existed defaults to
        // the version on screen, and a note must never claim another's.
        return (sketchVersionRef.current.get(el.id) ?? versionIdRef.current) === versionIdRef.current
      })
      .map((el) => el.id)
  }, [canvasId, sessionId])

  const markSketchElementsAttached = useCallback(
    (ids: string[]) => {
      useCanvasStore.getState().markSketchAttached(canvasId, ids)
    },
    [canvasId],
  )

  /**
   * The glass reported a scene: bump the revision if the ELEMENTS moved, at
   * most once per frame. Both halves matter — the fingerprint keeps a camera
   * repin from re-rendering the panel at all, and the frame throttle keeps a
   * freehand drag from doing it per mouse move.
   */
  const noteGlassChanged = useCallback(
    (living: readonly { id: string; version?: number; versionNonce?: number }[]) => {
      const fingerprint = living.map((el) => `${el.id}:${el.version ?? 0}:${el.versionNonce ?? 0}`).join(',')
      if (fingerprint === sketchFingerprintRef.current) return
      sketchFingerprintRef.current = fingerprint
      if (sketchBumpFrameRef.current !== null) return
      sketchBumpFrameRef.current = requestAnimationFrame(() => {
        sketchBumpFrameRef.current = null
        setSketchRevision((n) => n + 1)
      })
    },
    [],
  )

  // A pending bump must not outlive the pane — it would set state on a pane the
  // user has closed.
  useEffect(() => {
    return () => {
      if (sketchBumpFrameRef.current !== null) {
        cancelAnimationFrame(sketchBumpFrameRef.current)
        sketchBumpFrameRef.current = null
      }
    }
  }, [])

  // The belt, tied off. Unmount parks the union in the store; nothing is written
  // to disk here — that is the panel's job, and doing it twice would race it.
  //
  // An emptied glass parks an EMPTY scene, never `null`. Null means "no belt,
  // fall through to disk", and for a canvas the user had just cleared that is
  // the one answer that resurrects the strokes they deleted. The belt is the
  // authority for the rest of the session, so it has to be able to say "none".
  useEffect(() => {
    return () => {
      const scene = getSketchSceneForPersist()
      useCanvasStore
        .getState()
        .stashSketchScene(canvasId, scene ?? (hadSketchElementsRef.current ? EMPTY_SKETCH_SCENE : null))
    }
  }, [canvasId, getSketchSceneForPersist])

  // Keep the glass pinned to the content: scene scroll ≡ −content scroll, scene
  // zoom ≡ the content zoom (canvas-coords.glassScrollForContent). Applied on
  // every viewport event and every zoom step, and re-applied if Excalidraw
  // itself pans/zooms the scene (wheel or space-drag on the glass in draw mode)
  // — the canvas glass has no free camera, the content is the camera.
  const repinGlass = useCallback(() => {
    const api = glassApiRef.current
    const vp = viewportRef.current
    if (!api || !vp || repinPendingRef.current) return
    repinPendingRef.current = true
    requestAnimationFrame(() => {
      repinPendingRef.current = false
      const currentVp = viewportRef.current
      if (!currentVp || !glassApiRef.current) return
      glassApiRef.current.updateScene({ appState: glassScrollForContent(currentVp, zoomRef.current) } as never)
    })
  }, [])

  /** Walk the zoom ladder (+in / −out); `reset` snaps to 1. The one choke
   *  point for every zoom source — host wheel, host chords, the chip, and the
   *  frame relay — so the guards here bind all of them. A zoom step reflows
   *  the content, so it is refused while a marquee drag is in flight: the
   *  drag's corners were sampled against the old layout and committing them
   *  against the new one places the region wrong, with no fingerprint to
   *  recover from (independent review, C3). */
  const applyZoom = useCallback(
    (intent: { steps: number; reset: boolean }) => {
      if (marqueeDragRef.current) return
      setZoom((z) => (intent.reset ? 1 : stepCanvasZoom(z, intent.steps)))
    },
    [],
  )

  // The glass must follow the zoom in the same frame discipline it follows the
  // scroll — its zoom is part of the same binding.
  useEffect(() => {
    repinGlass()
  }, [zoom, repinGlass])

  /** Ask the frame to describe itself, sanitised, or null when it will not or
   *  cannot. Never throws: a stamp without a tree is still a stamp. */
  const snapshotForEvidence = useCallback(async (): Promise<CanvasSnapshotResult | null> => {
    const target = iframeRef.current?.contentWindow
    if (!target || !bridgeReadyRef.current) return null
    try {
      const raw = await askCanvasFrame(target, canvasId, { type: 'snapshot', analysis: false }, EVIDENCE_SNAPSHOT_TIMEOUT_MS)
      // Sanitised HERE, exactly as the snapshot host does before its own reply
      // crosses IPC — this tree is assembled by the page under review.
      return sanitizeSnapshotResult(raw, undefined, { scoped: false })
    } catch {
      return null
    }
  }, [canvasId])

  /**
   * Take the run's baseline once, on this version's first bridge `ready`.
   *
   * Guarded by version id rather than by a boolean: `ready` fires again on every
   * in-frame navigation, and a baseline re-taken after the user has filled the
   * form would report every changed field as untouched — the exact fact the
   * stamp exists to carry.
   */
  const captureBaseline = useCallback(() => {
    if (!isTestingRef.current) return
    const versionId = versionIdRef.current
    if (baselineForRef.current === versionId) return
    baselineForRef.current = versionId
    void snapshotForEvidence().then((snapshot) => {
      if (versionIdRef.current !== versionId) return
      baselineRef.current = snapshot ? baselineFromSnapshot(snapshot) : null
    })
  }, [snapshotForEvidence])

  /**
   * A note is starting: freeze the site and lock a picture of it.
   *
   * Order matters and every step of it is load-bearing. The host's own layers go
   * first (they would be IN the photograph); a frame is allowed to pass so the
   * removal has painted; the rectangle is measured from the live DOM rather than
   * remembered, because the pane is resizable; the stamp is taken before the
   * shot so the two describe the same instant; and the shield is mounted LAST —
   * mounted first, it would be the thing the screenshot captured.
   */
  const beginEvidence = useCallback(() => {
    // READ-ONLY FIRST, and stated rather than implied (adversarial pass).
    // The two conditions below happen to be false on the read-only surfaces we
    // render today, but they are conditions about a RUN, not about ownership:
    // `versionOpen` is `!draft && !verdict`, and a reject-fix-approve history
    // leaves earlier versions verdict-less, so stepping back through one would
    // have satisfied both and sent an `evidenceCapture` for somebody else's
    // canvas. Main refuses it — and a refused write is still a write attempted
    // from a surface whose contract is that it makes none.
    if (readOnlyRef.current) return
    if (!isTestingRef.current || !versionOpenRef.current) return
    if (pendingEvidenceRef.current || evidenceBusyRef.current) return
    evidenceBusyRef.current = true
    setEvidenceNotice(null)
    setCapturingEvidence(true)
    setHover(null)
    void (async () => {
      try {
        await new Promise<void>((resolve) => {
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
          else setTimeout(resolve, 16)
        })
        const rect = contentFrameRef.current?.getBoundingClientRect()
        if (!rect || rect.width < 1 || rect.height < 1) {
          setEvidenceNotice(captureRefusalWords('capture-failed'))
          return
        }
        const versionId = versionIdRef.current
        const snapshot = await snapshotForEvidence()
        const stamp = buildEvidenceStamp({
          snapshot,
          baseline: baselineRef.current,
          viewport: viewportRef.current,
          zoom: zoomRef.current,
          at: new Date().toISOString(),
        })
        const result = await window.electronAPI.canvas.evidenceCapture({
          sessionId,
          canvasId,
          versionId,
          // Window CSS pixels; main clamps it to the window's own content
          // bounds, so a stale measurement can never widen the shot.
          rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          // No `dpr` argument: the device pixel ratio is already on the stamp's
          // viewport, and the stamp is the record. One number crossing the seam
          // twice is one number that can disagree with itself.
          stamp,
          trail: trailSinceLastNote(canvasId, versionId),
        })
        if (result?.ok) setPendingEvidence({ evidenceId: result.evidenceId, previewDataUrl: result.previewDataUrl })
        else setEvidenceNotice(captureRefusalWords(result?.reason))
      } catch {
        setEvidenceNotice(captureRefusalWords('capture-failed'))
      } finally {
        evidenceBusyRef.current = false
        setCapturingEvidence(false)
      }
    })()
  }, [canvasId, sessionId, snapshotForEvidence])

  /** The note was abandoned: the pending shot is deleted and the site is live
   *  again. Fire-and-forget — main sweeps unlocked pending files anyway, so a
   *  failed discard costs disk, never correctness. */
  const discardEvidence = useCallback(() => {
    const pending = pendingEvidenceRef.current
    pendingEvidenceRef.current = null
    setPendingEvidence(null)
    setEvidenceNotice(null)
    if (!pending) return
    void window.electronAPI.canvas
      .evidenceDiscard({ sessionId, canvasId, evidenceId: pending.evidenceId })
      .catch(() => {})
  }, [canvasId, sessionId])

  /** The note took it: main has moved the file onto the note, so the pane stops
   *  holding it, the shield comes down, and the trail is cut here. */
  const lockEvidence = useCallback(
    (annotationId: string) => {
      pendingEvidenceRef.current = null
      setPendingEvidence(null)
      setEvidenceNotice(null)
      markTrailNoteSaved(canvasId, versionIdRef.current, annotationId)
    },
    [canvasId],
  )

  /** A capture that outlived a pane switch, handed back by the restored
   *  composer draft. The preview data URL does not survive with it — only the
   *  reply that minted it carried one — so the composer says the screen is held
   *  without showing it. */
  const adoptEvidence = useCallback((evidenceId: string) => {
    if (!isTestingRef.current) return
    setPendingEvidence((current) => (current?.evidenceId === evidenceId ? current : { evidenceId }))
  }, [])

  /** A reported content click (browse mode) becomes a locked selection: ask
   *  the frame for the chain at that point, then lock its deepest entry. The
   *  page's own click behaviour already happened — the bridge only observed.
   *  Coalesced to ONE outstanding inspect: a click cannot be answered twice,
   *  and the RPC layer's per-frame cap is a backstop, not the design. */
  const inspectAndLock = useCallback(
    async (pageX: number, pageY: number) => {
      // Not on a read-only surface, whatever the version looks like. Locking a
      // selection writes `focus` into THIS session's review mirror — with a
      // chain read out of a foreign document and stamped with a foreign version
      // id — and then starts a note. Neither belongs to a canvas the session
      // does not own, and neither is prevented by the run-shaped guards inside
      // `beginEvidence`. Browsing and hovering still work; only the lock stops.
      if (readOnlyRef.current) return
      const target = iframeRef.current?.contentWindow
      if (!target || inspectPendingRef.current) return
      inspectPendingRef.current = true
      try {
        const raw = await askCanvasFrame(target, canvasId, { type: 'inspect', x: pageX, y: pageY }, 5000)
        const { chain } = safeInspectResult(raw)
        if (chain.length > 0) {
          useCanvasReviewStore.getState().lockFocus(sessionId, chain, versionIdRef.current)
          // Choosing a target IS starting a note (M3): in Testing mode the site
          // freezes here, so the shot shows the screen the user was pointing at
          // rather than whatever it became while they found their words.
          beginEvidence()
        }
      } catch {
        /* frame busy or navigating — the hover chip still works */
      } finally {
        inspectPendingRef.current = false
      }
    },
    [canvasId, sessionId, beginEvidence],
  )

  /**
   * Look again shortly, because the request could not be POSTED — not because
   * the frame said anything. Deliberately not an attempt: an attempt is a thing
   * the frame was actually asked, and spending the budget on a condition inside
   * the HOST clears it in three microtasks and wedges the intent (see the
   * dispatch checks below).
   */
  const deferHoverReconcile = useCallback(() => {
    if (hoverReportingRetryTimerRef.current !== null) return
    if (hoverReportingDeferralsRef.current >= MAX_HOVER_REPORTING_DEFERRALS) return
    hoverReportingDeferralsRef.current += 1
    hoverReportingRetryTimerRef.current = window.setTimeout(() => {
      hoverReportingRetryTimerRef.current = null
      syncHoverReportingRef.current()
    }, HOVER_REPORTING_RETRY_MS)
  }, [])

  /** Requests still postable in the current send window, rolling it over when
   *  it has expired. Reading it is what advances the window; posting is what
   *  spends it. */
  const hoverReportingSendBudget = useCallback((now: number) => {
    const w = hoverReportingWindowRef.current
    if (now - w.start >= HOVER_REPORTING_SEND_WINDOW_MS) {
      w.start = now
      w.sent = 0
    }
    return MAX_HOVER_REPORTING_SENDS_PER_WINDOW - w.sent
  }, [])

  // A deferral timer must not outlive the pane: it holds the reconcile, which
  // would post into a frame the user has closed.
  useEffect(() => {
    return () => {
      if (hoverReportingRetryTimerRef.current !== null) {
        window.clearTimeout(hoverReportingRetryTimerRef.current)
        hoverReportingRetryTimerRef.current = null
      }
    }
  }, [])

  /**
   * Bring the frame's belief about hover reporting in line with the x-ray mode
   * (#367).
   *
   * The host already ignores what it does not want, so this is not the gate —
   * it is what makes Off free for the PAGE: a bridge told to stop does no hit
   * test, no measurement and no postMessage per mousemove. Sent only when the
   * frame's belief disagrees, so the common case (x-ray on, the bridge's own
   * default) costs no round-trip at all.
   *
   * What the frame is doing is recorded from its ANSWER, never from the send. A
   * request can be refused before it is ever posted — canvas-frame-rpc caps
   * requests in flight at four, and a snapshot, an inspect and a resolveAnchors
   * can already be outstanding when the user reaches for the switch — and
   * marking it sent anyway left the host permanently certain it had quieted a
   * frame that was never told (Copilot review, #405).
   *
   * And the reconcile happens when the request SETTLES, not when the page next
   * reports. An earlier revision repaired from the symptom — a report arriving
   * in a mode that wants none — which cannot see the failure that matters:
   * flip the mode while a request is parked and the flip is dropped by the
   * in-flight guard, the parked answer lands, and the frame stays quiet for the
   * life of the document with x-ray showing nothing at all. Silence is not a
   * symptom, so nothing is allowed to wait for one (independent review, #405).
   */
  const syncHoverReporting = useCallback(() => {
    const enabled = xrayHoverIsLive(xrayModeRef.current)
    // Recorded BEFORE the nothing-to-do check, so that passing through a mode
    // the frame already agrees with still counts as changing the intent. Keyed
    // after it, "Off (gave up) -> On -> Off" read as the same intent as the
    // first Off and the second one got no attempts at all — the user asking
    // again is the clearest signal there is that they want it to work.
    const intent = `${frameGenerationRef.current}:${enabled}`
    if (hoverReportingIntentRef.current !== intent) {
      hoverReportingIntentRef.current = intent
      hoverReportingAttemptsRef.current = 0
      hoverReportingDeferralsRef.current = 0
    }
    // Unknown is never equal to what is wanted, so a frame the host has no
    // account of is always asked again rather than short-circuited here.
    if (frameHoverReportingRef.current === enabled) return
    if (hoverReportingPendingRef.current) return
    if (hoverReportingAttemptsRef.current >= MAX_HOVER_REPORTING_ATTEMPTS) return
    const target = iframeRef.current?.contentWindow
    if (!target) return
    // ── Two ways the request cannot be posted AT ALL, neither of which is the
    //    frame's doing, and neither of which spends an attempt.
    //
    // The first is the RPC's in-flight cap: over it the request is refused
    // before a listener exists, and that refusal is a synchronous rejection —
    // which the post-settle reconcile below then fires on, spending the whole
    // budget in three microtasks on a condition that clears in milliseconds.
    // (Reachable: the resolution pass has no in-flight guard of its own, so a
    // few note edits inside its ten-second window saturate the cap.) The
    // second is this channel's own send window. Both clear on their own, so the
    // reconcile waits for them instead of counting them against the frame
    // (fix-delta verification, #405).
    if (framesInFlight(target) >= MAX_FRAME_REQUESTS_IN_FLIGHT || hoverReportingSendBudget(Date.now()) <= 0) {
      deferHoverReconcile()
      return
    }
    const generation = frameGenerationRef.current
    hoverReportingPendingRef.current = true
    hoverReportingAttemptsRef.current += 1
    hoverReportingDeferralsRef.current = 0
    hoverReportingWindowRef.current.sent += 1
    askCanvasFrame(target, canvasId, { type: 'hoverReporting', enabled }, HOVER_REPORTING_TIMEOUT_MS)
      .then(
        (raw) => {
          // Believed only about the document it was asked of, and only as the
          // frame's own account of itself — the reply is page-authored, so a
          // non-boolean is no answer at all and the host is left not knowing.
          if (generation !== frameGenerationRef.current) return
          const answered = (raw as CanvasHoverReportingResult | null | undefined)?.enabled
          frameHoverReportingRef.current = typeof answered === 'boolean' ? answered : 'unknown'
        },
        () => {
          /* Never landed: refused by the in-flight cap, a frame mid-navigation,
             a page that answers nothing, an ack lost or too late. The bridge
             APPLIES the change and only then replies, so a request that does
             not come back leaves the host with no account of the frame at all —
             recorded as exactly that, because carrying the old belief forward is
             what let a dropped ack strand the frame quiet for the life of the
             document. The mode still holds meanwhile: the host-side gate is what
             enforces it, not this request. */
          if (generation !== frameGenerationRef.current) return
          frameHoverReportingRef.current = 'unknown'
        },
      )
      .finally(() => {
        // Cleared for EVERY generation: a stale answer that is no longer
        // believed must still release the in-flight slot, or one navigation
        // mid-request would wedge the switch for the life of the pane.
        hoverReportingPendingRef.current = false
        syncHoverReportingRef.current()
      })
  }, [canvasId, deferHoverReconcile, hoverReportingSendBudget])
  syncHoverReportingRef.current = syncHoverReporting

  const handleReportedKey = useCallback(
    (key: string) => {
      const store = useCanvasReviewStore.getState()
      if (key === 'Escape') {
        if (store.bySessionId[sessionId]?.marqueeArmed) store.setMarqueeArmed(sessionId, false)
        else store.clearFocus(sessionId)
        setMarqueeDrag(null)
      } else if (key === 'ArrowUp') {
        if (store.bySessionId[sessionId]?.focus) store.expandFocus(sessionId)
      }
    },
    [sessionId],
  )

  // Bridge listener. Messages are accepted only from OUR iframe's window and
  // only in the canvas namespace — but the bridge and the page's own scripts
  // share that window, so those two checks cannot tell them apart. `ready`,
  // `viewport` and `pointer` are reports the host merely paints (spec D8,
  // §5.4); `contentClick` and `contentKey` MUTATE host state, and the channel
  // gates them on what the host can see for itself (see
  // canvas-inbound-channel). Delivery is coalesced per animation frame and the
  // channel is dropped past a flood budget.
  useEffect(() => {
    return createCanvasInboundChannel({
      canvasId,
      getFrameWindow: () => iframeRef.current?.contentWindow ?? null,
      getFrameElement: () => iframeRef.current,
      handlers: {
        onReady: () => {
          bridgeReadyRef.current = true
          setBridgeReady(true)
          // Every `ready` is a NEW document with a NEW bridge, and a new bridge
          // reports by default. An in-frame navigation (a link inside the
          // content) replaces the document without changing `contentUrl` or the
          // reload nonce, so this is the ONLY signal that the frame has
          // forgotten what it was told — without the reset, x-ray Off stopped
          // quieting the page after the first link click, and the pane looked
          // right only because the host gate was still dropping the reports
          // (Copilot review, #405).
          //
          // The generation bump is what stops the PREVIOUS document's parked
          // answer from landing on this one's state and undoing this reset.
          frameGenerationRef.current += 1
          frameHoverReportingRef.current = true
          syncHoverReporting()
          // The run's baseline, once per version — see captureBaseline.
          captureBaseline()
        },
        onViewport: (vp) => {
          setViewport(vp)
          setHover(null)
          viewportRef.current = vp
          repinGlass()
          // The trail's scroll entries come from here, coalesced to one per
          // pause. Testing only: nothing else in the product reads a trail, and
          // recording one for a mockup would be work nobody asked for.
          if (isTestingRef.current) recordTrailScroll(canvasId, versionIdRef.current, vp.scrollY)
        },
        // X-ray Off is enforced HERE, not only by the request that asked the
        // bridge to go quiet (#367). The bridge shares a realm with the page it
        // reports on and may ignore that request — or never have received it —
        // so the mode the user chose is applied to what actually arrives.
        onPointer: (hit) => {
          if (!xrayHoverIsLive(xrayModeRef.current)) {
            setHover(null)
            return
          }
          setHover(hit ? { hit } : null)
        },
        onContentClick: (pageX, pageY, hit) => {
          // The TRAIL is recorded first and unconditionally (M3): it is a
          // record of what the user did, and x-ray is a setting about what the
          // pane DRAWS. Stopping the trail in x-ray Off would mean the mode a
          // careful tester picks — the one that leaves the page alone — is the
          // one that silently throws their reproduction away.
          if (isTestingRef.current) {
            recordTrailEvent(canvasId, versionIdRef.current, { kind: 'click', target: stampTargetFromHit(hit) })
          }
          // Click-to-lock (spec §6 step 3) — browse mode only; in draw mode the
          // glass owns the pointer and a frame click cannot happen anyway.
          // Under x-ray Off a click selects nothing: the page was asked for as a
          // normal browser tab, and a tab does not turn a click into a selection
          // (#367 left this open; see xrayClickSelects).
          if (!xrayClickSelects(xrayModeRef.current)) return
          if (modeRef.current === 'browse') void inspectAndLock(pageX, pageY)
        },
        onTypedInto: (hit) => {
          // WHICH field, once per focus session. The bridge is where the
          // keylogger line is drawn; this is the host repeating that it only
          // ever receives an identity.
          if (!isTestingRef.current) return
          const target = stampTargetFromHit(hit)
          if (target) recordTrailEvent(canvasId, versionIdRef.current, { kind: 'typed', target })
        },
        onNavigated: (route) => {
          if (!isTestingRef.current) return
          recordTrailEvent(canvasId, versionIdRef.current, { kind: 'navigate', route })
        },
        onContentKey: handleReportedKey,
        onContentZoom: applyZoom,
        onFlood: () => setBridgeFlooded(true),
      },
    })
  }, [repinGlass, canvasId, inspectAndLock, handleReportedKey, applyZoom, syncHoverReporting, captureBaseline])

  // A full-document navigation inside the frame, pushed by main from its own
  // `will-frame-navigate` guard (M3). The bridge cannot report this one: the
  // document carrying it is being replaced.
  useEffect(() => {
    return window.electronAPI.canvas.onFrameNavigated((event) => {
      if (event.sessionId !== sessionId || event.canvasId !== canvasId) return
      if (!isTestingRef.current) return
      recordTrailEvent(canvasId, versionIdRef.current, { kind: 'navigate', route: event.route })
    })
  }, [sessionId, canvasId])

  // A version change ends the run the trail was recording, and invalidates the
  // baseline the field classification is measured against. Both are per-version
  // facts, and carrying either across would make the next run's evidence
  // describe the previous one's page.
  const trailVersionRef = useRef(version.id)
  useEffect(() => {
    const previous = trailVersionRef.current
    if (previous === version.id) return
    trailVersionRef.current = version.id
    resetTrail(canvasId, previous)
    baselineRef.current = null
    baselineForRef.current = null
    // A capture belongs to the screen it was taken of. Stepping to another
    // version while one is pending would let it lock onto a note about a
    // different build.
    discardEvidence()
  }, [canvasId, version.id, discardEvidence])

  // The same two keys, host-side, for when the HOST document has keyboard
  // focus (after touching the panel or the chrome). Never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      // The shield's Escape wins, and it is decided HERE so the ordering against
      // the focus/marquee Escape is in one place rather than split between two
      // listeners racing on the same key. While a note is paused, Escape is what
      // the composer's Cancel is: the capture goes, the words go, the site is
      // live again.
      //
      // Deliberately ABOVE the typing guard, which everything else here obeys.
      // The composer is exactly where the user's hands are while a note is
      // paused, so an Escape that only worked when they were NOT writing would
      // be an escape from the shield they could not reach — and the shield says
      // out loud that Escape is the way out. A control that names its own key
      // has to honour it from the place the key is pressed.
      if (e.key === 'Escape' && pendingEvidenceRef.current) {
        e.preventDefault()
        const cancel = cancelNoteRef.current
        if (cancel) cancel()
        else discardEvidence()
        return
      }
      if (typing) return
      if (e.key === 'Escape') {
        handleReportedKey('Escape')
      } else if (e.key === 'ArrowUp' && useCanvasReviewStore.getState().bySessionId[sessionId]?.focus) {
        e.preventDefault()
        handleReportedKey('ArrowUp')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessionId, handleReportedKey, discardEvidence])

  // ── Content zoom, host side (#368) ─────────────────────────────────────────
  // Ctrl+wheel anywhere over the pane's own chrome — the header, the glass in
  // draw mode, the notes panel — zooms the content, exactly as the same gesture
  // over the frame does via the bridge relay. Capture phase so the glass's own
  // Excalidraw wheel handling (scene zoom, which the repin would fight) never
  // sees the ctrl-chord; a plain wheel is untouched. Native listener because
  // React's synthetic wheel is passive and could not preventDefault.
  useEffect(() => {
    const root = paneRootRef.current
    if (!root) return
    let accum = 0
    const onWheel = (e: WheelEvent) => {
      // ctrlKey on every platform: a trackpad pinch reports as ctrl+wheel on
      // macOS too. altKey excluded: AltGr on Windows layouts reports ctrl+alt.
      if (!e.ctrlKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      // DOM_DELTA_LINE counts lines (~3/notch), DOM_DELTA_PAGE counts pages
      // (~1/notch); anything else is pixels.
      const notch = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 1 : 100
      accum += e.deltaY
      let steps = 0
      while (accum >= notch) {
        accum -= notch
        steps -= 1
      }
      while (accum <= -notch) {
        accum += notch
        steps += 1
      }
      if (steps !== 0) applyZoom({ steps, reset: false })
    }
    root.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => root.removeEventListener('wheel', onWheel, { capture: true })
  }, [applyZoom])

  // The zoom chords, host side: Ctrl+= / Ctrl+- / Ctrl+0 (Cmd on macOS, the
  // platform's own zoom chord). The app registers no zoom accelerators of its
  // own (no View menu), so nothing is contested today; the scope rule is what
  // keeps it that way. Focus INSIDE the pane always claims the chord (typing
  // in the notes composer included — a browser zooms while you type). Hover
  // claims it only while nothing OUTSIDE the pane holds focus: Chromium keeps
  // `:hover` on the last pointer position, so a pointer parked over the pane
  // must not eat a chord the user is typing into the terminal (independent
  // review, C6).
  useEffect(() => {
    const isMac = navigator.platform.startsWith('Mac')
    const onKey = (e: KeyboardEvent) => {
      const chord = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!chord || e.altKey) return
      const intent =
        e.key === '=' || e.key === '+'
          ? { steps: 1, reset: false }
          : e.key === '-' || e.key === '_'
            ? { steps: -1, reset: false }
            : e.key === '0'
              ? { steps: 0, reset: true }
              : null
      if (!intent) return
      const root = paneRootRef.current
      if (!root) return
      const active = document.activeElement
      let engaged = root.contains(active)
      if (!engaged && !isTypingTarget(active)) {
        // Hover claims the chord unless the user is TYPING somewhere else —
        // an editable, or a terminal (xterm focuses a helper textarea, so the
        // same test covers it). Focus merely resting on a button elsewhere
        // does not un-claim a chord aimed at the hovered pane (N3).
        try {
          engaged = root.matches(':hover')
        } catch {
          engaged = false
        }
      }
      if (!engaged) return
      e.preventDefault()
      applyZoom(intent)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [applyZoom])

  // The user changed the mode: bring the frame in line with it. (A frame that
  // is not ready yet is told on its `ready` instead — see the channel above.)
  useEffect(() => {
    if (!bridgeReady) return
    syncHoverReporting()
  }, [xrayMode, bridgeReady, syncHoverReporting])

  // Switching x-ray off drops whatever was hovered at that instant, so nothing
  // is left painted over a page the user just asked to see plainly.
  useEffect(() => {
    if (!xrayHoverIsLive(xrayMode)) setHover(null)
  }, [xrayMode])

  // New version (or a retry) → the frame reloads; bridge state starts over.
  useEffect(() => {
    bridgeReadyRef.current = false
    // Bumped for the same reason `ready` bumps it: this is a NEW document, and
    // the request parked against the old one must not land on the reset below
    // and undo it. (The reset without the bump was the one place the two were
    // not kept together — fix-delta verification, #405.)
    frameGenerationRef.current += 1
    frameHoverReportingRef.current = true
    setBridgeReady(false)
    setViewport(null)
    setHover(null)
    setMarqueeDrag(null)
    setFrameLoaded(false)
    setLoadTimedOut(false)
    setBridgeFlooded(false)
  }, [contentUrl, reloadNonce])

  // …and a frame that never reports in stops pretending to load. Without this
  // a 404, a CSP-blocked bridge script or a crashed page all read as "slow"
  // indefinitely, which is the one thing the user cannot act on.
  useEffect(() => {
    if (bridgeReady) return
    const timer = window.setTimeout(() => setLoadTimedOut(true), FRAME_READY_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [contentUrl, reloadNonce, bridgeReady])

  const retryFrame = useCallback(() => setReloadNonce((n) => n + 1), [])

  // Publish this frame so `canvas_snapshot` (main) has something to capture.
  // Only while mounted: with no live frame there is no rendered page, and the
  // tool says so rather than inventing one.
  useEffect(() => {
    return registerCanvasFrame({
      sessionId,
      canvasId,
      versionId: version.id,
      getWindow: () => iframeRef.current?.contentWindow ?? null,
      // Read through the ref: this registration outlives a re-render, and a
      // captured boolean would freeze at its mount-time value.
      isReady: () => bridgeReadyRef.current,
    })
  }, [sessionId, canvasId, version.id])

  // Leaving browse mode drops the transient hover immediately (the overlay is
  // for pointing at content, not for decorating the glass).
  useEffect(() => {
    if (mode !== 'browse') setHover(null)
  }, [mode])

  // ── Resolution pass (spec §6 step 2, D12: one per turn) ───────────────────
  // Re-anchor the open notes of submitted reviews against the version on
  // screen: every note's anchors go out in ONE request, first hit per note
  // wins (ux-id is stored ahead of the fingerprint). Notes made against THIS
  // version need no pass; regions and generals have nothing to re-anchor.
  const openNotes = useMemo(() => (reviewSession ? openSubmittedNotesOf(reviewSession) : []), [reviewSession])
  const openReviewCount = useMemo(() => (reviewSession ? openReviewsOf(reviewSession).length : 0), [reviewSession])
  // Open reviews on the session's OTHER canvases (item 29): the count above is
  // honest about this canvas and blind to the rest; this names the rest, and
  // points at the subject picker where each is listed with its own count.
  const openNotesKey = useMemo(() => openNotes.map((n) => n.id).join(','), [openNotes])

  useEffect(() => {
    if (!bridgeReady) return
    const target = iframeRef.current?.contentWindow
    if (!target) return
    const store = useCanvasReviewStore.getState()
    const current = store.bySessionId[sessionId]?.resolution
    // A zoom step reflows the content (#368) — the CSS viewport narrows or
    // widens like a browser tab's — so page-space boxes measured under another
    // zoom are stale: the pass runs again, same-version notes AND the live
    // locked focus included, which is what lets a note placed at 150 %
    // re-anchor at 100 %.
    const zoomChanged = resolvedZoomRef.current !== zoom
    const prior = current?.versionId === version.id ? current.byAnnotation : {}
    const done = zoomChanged ? {} : prior
    const pending = openNotes.filter(
      (n) => (zoomChanged || n.versionId !== version.id) && n.focus && n.focus.targets.length > 0 && !(n.id in done),
    )
    // The live element lock goes stale under the same reflow; its box is
    // re-pointed through the same pass (S3). Read at arm time and guarded by
    // reference on the way back, so a lock the user changed meanwhile is
    // never touched.
    const liveFocus = zoomChanged ? (store.bySessionId[sessionId]?.focus ?? null) : null
    const liveFocusTargets = liveFocus && liveFocus.targets.length > 0 ? liveFocus.targets : null
    if (pending.length === 0 && !liveFocusTargets) {
      resolvedZoomRef.current = zoom
      return
    }
    // The attempt budget belongs to ONE intent; asking about anything new is a
    // new budget (mirrors the hover-reporting intent key above).
    const intent = `${version.id}:${zoom}:${openNotesKey}`
    if (resolveIntentRef.current !== intent) {
      resolveIntentRef.current = intent
      resolveAttemptsRef.current = 0
    }
    // ONE resolve in flight from this effect, ever (A1). The RPC layer caps a
    // frame at four requests; without this guard a page that provokes passes
    // (zoom intents are page-relayable) and never answers them could hold all
    // four slots and starve inspect, hover reporting and snapshots. With it,
    // this path holds at most one — the retry nonce below picks up whatever
    // was skipped once the outstanding call settles.
    if (resolvePendingRef.current) {
      resolveSkippedRef.current = true
      return
    }

    let cancelled = false
    const run = async () => {
      const flat: AnchorRef[] = []
      const spans: Array<{ id: string; start: number; count: number }> = []
      // The live focus rides FIRST: it is the thing the user is actively
      // holding, so the anchor cap must never be what drops it. '~focus'
      // cannot collide with a note id (ids match CANVAS_ANNOTATION_ID_RE,
      // /^a[0-9]{1,9}$/, enforced on load) and never enters `merged` — its
      // result goes to updateFocusBox.
      if (liveFocusTargets) {
        spans.push({ id: '~focus', start: 0, count: liveFocusTargets.length })
        flat.push(...liveFocusTargets)
      }
      for (const note of pending) {
        const targets = note.focus!.targets
        if (flat.length + targets.length > MAX_RESOLVE_ANCHORS) break
        spans.push({ id: note.id, start: flat.length, count: targets.length })
        flat.push(...targets)
      }
      if (flat.length === 0) {
        resolvedZoomRef.current = zoom
        return
      }
      resolvePendingRef.current = true
      resolveAttemptsRef.current += 1
      try {
        const raw = await askCanvasFrame(target, canvasId, { type: 'resolveAnchors', anchors: flat }, 10_000)
        if (cancelled) return
        // Checked against the anchors WE sent, not merely counted against them:
        // the page writes this reply and it decides what the checklist tells
        // the reviewer about their own open notes.
        const results = safeAnchorResolutions(raw, flat)
        // Merged over the PRIOR entries, never over a wiped map: a pass the
        // anchor cap truncated must not demote the tail's notes from a located
        // box to "locating…" — past the cap they keep their previous (old-zoom)
        // boxes, which is exactly the pre-#368 behaviour for them (C1).
        const merged = { ...prior }
        for (const span of spans) {
          const slice = results.slice(span.start, span.start + span.count)
          const hit = slice.find((r) => r.found) ?? null
          if (span.id === '~focus') {
            if (hit && liveFocus) useCanvasReviewStore.getState().updateFocusBox(sessionId, liveFocus, hit.box)
          } else {
            merged[span.id] = hit
          }
        }
        resolvedZoomRef.current = zoom
        useCanvasReviewStore.getState().setResolution(sessionId, { versionId: version.id, byAnnotation: merged })
      } catch {
        /* frame gone or slow — the checklist keeps its ghosts */
      } finally {
        resolvePendingRef.current = false
        // Whatever this run could not cover — a pass the in-flight guard
        // skipped, or a zoom that moved again while it was out — gets another
        // look, INSIDE the intent's attempt budget. On success the drift
        // clears and nothing fires; on failure the budget is what stops a
        // frame that never answers from choosing the host's call rate (N1) —
        // three attempts per intent, then the checklist keeps its ghosts
        // until the user asks something new.
        // A recorded skip always retries: the guard turned away a whole effect
        // run over a HOST condition (this pass being out), possibly for a NEW
        // intent whose budget is not this one's — the re-armed effect re-keys
        // the intent and its own budget bounds any RPC it issues. Drift alone
        // retries only inside this intent's budget.
        const skipped = resolveSkippedRef.current
        resolveSkippedRef.current = false
        const driftRetry =
          resolvedZoomRef.current !== zoomRef.current && resolveAttemptsRef.current < MAX_RESOLVE_ATTEMPTS
        // The skip retry fires REGARDLESS of `cancelled`: a skip is recorded
        // by a LATER effect run, and React has already cancelled this one by
        // then — gating it on !cancelled made the path unreachable and
        // silently dropped a zoom step that landed mid-pass (final review,
        // M1). The bump is a component-level setState, not a stale write, and
        // the re-armed effect re-keys its own intent and budget.
        if (skipped || (!cancelled && driftRetry)) {
          setResolveRetryNonce((n) => n + 1)
        }
      }
    }
    // Debounced only when the zoom moved it: rapid ladder steps supersede each
    // other rather than racing one resolve per rung through the RPC cap.
    const timer = window.setTimeout(() => void run(), zoomChanged ? 300 : 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [bridgeReady, version.id, openNotesKey, sessionId, canvasId, zoom, resolveRetryNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleGlassScrolled = useCallback(() => {
    const vp = viewportRef.current
    const api = glassApiRef.current
    if (!vp || !api) return
    const appState = api.getAppState()
    if (glassNeedsRepin(appState, vp, zoomRef.current)) repinGlass()
  }, [repinGlass])

  // ── Marquee (spec §6 step 3: rectangle for region notes) ──────────────────
  // The live drag also sits in a ref: mouse-up needs the final rectangle
  // synchronously, and doing work inside a setState updater would re-run it
  // under StrictMode's double-invoke.

  const marqueeDragRef = useRef<MarqueeDrag | null>(null)
  marqueeDragRef.current = marqueeDrag

  const marqueeMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Primary button only (W19). `onMouseDown` fires for every button, so a
    // right-click over the stage started a region drag that then swallowed the
    // context-menu gesture and left a rectangle armed behind the menu that
    // never came. A secondary click is not a drag, here or anywhere.
    if (e.button !== 0) return
    const bounds = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - bounds.left
    const y = e.clientY - bounds.top
    setMarqueeDrag({ x0: x, y0: y, x1: x, y1: y })
  }, [])

  const marqueeMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const bounds = e.currentTarget.getBoundingClientRect()
    setMarqueeDrag((drag) => (drag ? { ...drag, x1: e.clientX - bounds.left, y1: e.clientY - bounds.top } : null))
  }, [])

  const marqueeMouseUp = useCallback(() => {
    const drag = marqueeDragRef.current
    const vp = viewportRef.current
    setMarqueeDrag(null)
    if (!drag || !vp) return
    const left = Math.min(drag.x0, drag.x1)
    const top = Math.min(drag.y0, drag.y1)
    const width = Math.abs(drag.x1 - drag.x0)
    const height = Math.abs(drag.y1 - drag.y0)
    if (width >= MARQUEE_MIN_PX && height >= MARQUEE_MIN_PX) {
      // The zoom folds into the same slot the pinch scale occupies: 1 content
      // px is `scale × zoom` stage px (#368).
      const effVp = { ...vp, scale: vp.scale * zoomRef.current }
      const p0 = stageToContentPagePoint({ x: left, y: top }, effVp)
      const p1 = stageToContentPagePoint({ x: left + width, y: top + height }, effVp)
      useCanvasReviewStore
        .getState()
        .setRegionFocus(sessionId, { x: p0.x, y: p0.y, width: p1.x - p0.x, height: p1.y - p0.y }, versionIdRef.current)
    } else {
      useCanvasReviewStore.getState().setMarqueeArmed(sessionId, false)
    }
  }, [sessionId])

  /** The viewport the STAGE actually paints under: the frame's own report with
   *  the pane's zoom folded into the scale slot — 1 content px is
   *  `scale × zoom` stage px (#368). Everything that converts content page
   *  coords to stage pixels reads this one, so a box drawn on an element stays
   *  on it at every zoom. */
  const stageViewport = useMemo(
    () => (viewport ? { ...viewport, scale: viewport.scale * zoom } : null),
    [viewport, zoom],
  )

  const hoverStageRect = useMemo(() => {
    if (!hover || !stageViewport) return null
    return contentPageRectToStage(hover.hit.box, stageViewport)
  }, [hover, stageViewport])

  /** Which layer the pointer is on — the same three-way the glass and marquee
   *  layers are wired from, named once so the stealth readout can tell the user
   *  why hovering the content is doing nothing. */
  const pointerOwner = marqueeArmed ? 'marquee' : mode === 'draw' ? 'glass' : 'content'

  /** The hover box AS PAINTED on the stage. Null in every posture that must
   *  leave the content alone — the glass owning the pointer, a marquee being
   *  dragged, and now x-ray Stealth and Off (#367), where the hover is either
   *  read out beside the stage or not resolved at all. */
  const stageHoverRect = mode === 'browse' && !marqueeArmed && xrayDrawsOnPage(xrayMode) ? hoverStageRect : null

  const focusStageRect = useMemo(() => {
    if (!focus || !stageViewport) return null
    // C1 (owner bug report 2026-08-26): the lock is stamped with the version
    // it was made on, but this paint was version-blind — a region drawn on v5
    // repainted verbatim over v6's different layout. Draw it ONLY on its own
    // version; stepping back brings it back, and a new ready version leaves
    // it where it was made.
    if (focus.versionId !== version.id) return null
    return contentPageRectToStage(focus.bboxPage, stageViewport)
  }, [focus, stageViewport, version.id])

  /** An element lock's label came out of an inspect reply — the page's own
   *  account of what the user clicked. A region's came from the marquee. */
  const focusIsPageReported = (focus?.targets.length ?? 0) > 0

  const highlightStageRect = useMemo(() => {
    if (!panelHighlight || !stageViewport) return null
    return contentPageRectToStage(panelHighlight.rect, stageViewport)
  }, [panelHighlight, stageViewport])

  const hoverLabel = useMemo(() => {
    if (!hover) return ''
    const { role, name, tag, uxId } = hover.hit
    const base = role || tag
    const withName = name ? `${base} "${name}"` : base
    return uxId ? `${withName} · ${uxId}` : withName
  }, [hover])

  // The glass always renders LIGHT: its strokes sit over real page content
  // (usually light), and Excalidraw's dark theme would colour-invert them.
  //
  // The two item defaults are what a REVIEW mark should look like before the
  // user touches anything (W18). Excalidraw's own defaults are a dark grey
  // stroke and its hand-drawn font, both of which read as part of the page when
  // they are drawn over one: a red mark is unmistakably an annotation, and a
  // plain sans is legible at the size a label on a mockup ends up.
  const glassInitialData = useMemo(
    () =>
      ({
        appState: {
          viewBackgroundColor: 'transparent',
          currentItemStrokeColor: SKETCH_STROKE_COLOR,
          currentItemFontFamily: SKETCH_FONT_FAMILY,
        },
      }) as never,
    [],
  )

  // The glass is an annotation layer, not the Excalidraw app: no welcome
  // screen, no image tool (file dialogs don't belong over a page under
  // review); the leftover chrome is hidden by the glass-scoped CSS.
  const glassUIOptions = useMemo(() => ({ welcomeScreen: false, tools: { image: false } }), [])

  // What Inspect actually does depends on the x-ray mode now, and the hint is
  // the only thing that says so — a user who switched x-ray off and still read
  // "hover to inspect, click to select" would reasonably think it had failed.
  // The label carries the x-ray state (Inspect · Stealth) so the strip and the
  // chip agree on one glance.
  const inspectHint =
    xrayMode === 'off'
      ? 'the page is live and plain — X-Ray is off, so hovering and clicking do nothing here'
      : xrayMode === 'stealth'
        ? 'hovering names the element in the panel and draws nothing on the page · click selects · ↑ parent · Esc clears'
        : 'hover to inspect, click to select · ↑ parent · Esc clears'

  const modeStrip = marqueeArmed
    ? { color: 'text-peach', label: 'Region', hint: 'drag a rectangle over the area — Esc cancels' }
    : mode === 'draw'
      ? {
          color: 'text-mauve',
          label: 'Sketch',
          // W16: the strokes ride the next note by themselves, so the hint no
          // longer sends the user to a button that is gone. It says instead how
          // to get the page back, which is the thing draw mode takes away.
          hint: 'drawing over the page — what you draw rides your next note · press Sketch again to use the page',
        }
      : {
          color: 'text-blue',
          label: xrayMode === 'on' ? 'Inspect' : `Inspect · ${xrayMode === 'off' ? 'Off' : 'Stealth'}`,
          hint: inspectHint,
        }

  /** Per USER, so it is written straight to settings rather than to any canvas
   *  state (#367). Fire-and-forget: the store applies the change synchronously
   *  and the persist is the config saver's problem, exactly as every other
   *  settings toggle in the app does it. */
  const setXrayMode = (next: CanvasXrayMode) => {
    void useSettingsStore.getState().updateSettings({ canvasXrayMode: next })
  }

  const modeLockup = canvasModeLockup(version)

  /**
   * The test pack's name (M3).
   *
   * The user's own when they have set one, and otherwise DERIVED on every read
   * rather than stored — see `defaultPackName`. A default written into the
   * record at capture time would still say "build 4" after the build label
   * moved on.
   *
   * The inputs have to be the SAME inputs main derives from, or one pack has two
   * names: the MCP serializer builds this from the session's config label first
   * and the canvas title second, so the pane does too. (Main reads the label off
   * the spawn record; this reads it live, so a session renamed mid-run moves the
   * pane's default a moment before the agent's. Both are derived, neither is
   * stored, and a rename mid-run is the user's own gesture — the alternative is
   * an IPC round trip for a label.)
   */
  const buildLabel = version.source.mode === 'uat' ? version.source.buildLabel : undefined
  const packConfigName = useSessionConfigLabel(sessionId)
  const derivedPackName = useMemo(
    () => defaultPackName({ configName: packConfigName, title: canvasTitle, buildLabel, versionId: version.id, at: version.createdAt }),
    [packConfigName, canvasTitle, buildLabel, version.id, version.createdAt],
  )
  const packName = version.packName ?? derivedPackName

  const commitPackName = useCallback(() => {
    const next = packDraft.trim()
    setRenamingPack(false)
    // An emptied box is not a name — it is "go back to the derived default",
    // which is what null means to the store.
    if (next === (version.packName ?? '')) return
    // Nor is the derived default, typed back at us. The box is seeded with it,
    // so Enter on an untouched name would PERSIST the derivation — freezing
    // today's build label and today's date into the record for good, which is
    // the one thing `defaultPackName` exists to avoid.
    if (!version.packName && next === derivedPackName) return
    void useCanvasStore.getState().setPackName(sessionId, version.id, next.length > 0 ? next : null)
  }, [packDraft, sessionId, version.id, version.packName, derivedPackName])

  /**
   * How many OBSERVATIONS ride each version's decided round (M3).
   *
   * `verdictLabel` can say "PASSED WITH OBSERVATIONS", and without this it never
   * would: a pass carrying notes reads as a plain pass, which hides that the
   * user wrote something the agent was meant to read. Counted from the review
   * mirror, per version, and handed to History as a lookup — the control has no
   * business reaching into a store for it.
   */
  const observationsByVersion = useMemo(() => {
    const out: Record<string, number> = {}
    if (!reviewSession || reviewSession.canvasId !== canvasId) return out
    const approvedRounds = new Set(
      reviewSession.reviews.filter((r) => r.status !== 'draft' && r.decision === 'approve').map((r) => r.id),
    )
    for (const annotation of reviewSession.annotations) {
      if (!approvedRounds.has(annotation.reviewId)) continue
      if (annotation.state !== 'observation') continue
      out[annotation.versionId] = (out[annotation.versionId] ?? 0) + 1
    }
    return out
  }, [reviewSession, canvasId])

  // Which tool owns the pointer (item C): Inspect = browse, Sketch = draw,
  // Region = the marquee. These are the same three states the pointer layers
  // already switch on (pointerOwner); the chips are their presentation.
  const inspectActive = mode === 'browse' && !marqueeArmed
  const sketchActive = mode === 'draw' && !marqueeArmed
  const regionActive = marqueeArmed
  // Sketch and Region take the pointer off the content, so Inspect — and the
  // X-ray setting that only governs Inspect — visibly pause.
  const inspectPaused = !inspectActive
  const planLocked = version.mode === 'plan'

  /** A tool chip: app-family pill, accented when it owns the pointer, dimmed
   *  when another tool has paused it. */
  const chipClass = (active: boolean, paused: boolean) =>
    `flex items-center gap-1.5 h-[26px] px-2.5 rounded-md text-[12px] leading-none transition-colors focus-ring border ${
      active
        ? 'font-semibold text-[var(--brand)]'
        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
    } ${paused ? 'opacity-40' : ''}`
  const chipStyle = (active: boolean): React.CSSProperties =>
    active
      ? { background: 'color-mix(in srgb, var(--brand) 15%, transparent)', borderColor: 'color-mix(in srgb, var(--brand) 52%, transparent)' }
      : { background: 'color-mix(in srgb, var(--surface-panel) 60%, transparent)', borderColor: 'var(--border-subtle)' }

  // ── Recall: a submitted run opens as EVIDENCE, never as the live site ──────
  //
  // Once a test run has been submitted, the build it ran against is history —
  // its dist root may be revoked, its pages rebuilt, its bugs fixed. Re-serving
  // it would show a different build wearing the same version number, which is
  // worse than showing nothing. So a decided Testing version swaps the whole
  // stage for the pack the run produced.
  const submittedRound = useMemo(() => {
    if (!reviewSession || reviewSession.canvasId !== canvasId) return null
    return [...reviewSession.reviews].reverse().find((r) => r.versionId === version.id && r.status !== 'draft') ?? null
  }, [reviewSession, canvasId, version.id])
  // A zero-note PASS files no review at all — just the version's verdict — so
  // the verdict is the second door into recall rather than an alternative test.
  const userDecided = version.verdict?.state === 'approved' || version.verdict?.state === 'rejected'
  /**
   * READ-ONLY NEVER RECALLS (M4 seam, deliberate).
   *
   * Recall IS the run's notes, and no channel hands a non-owner another
   * session's annotations — `canvas:reviewGetState` is keyed by session, so it
   * answers about the CALLER's canvas, and `canvas:getReadonly` answers a
   * `CanvasState`, which carries versions and not reviews. Rendering the recall
   * with the empty note list that produces would print "this run was submitted
   * with no notes" over somebody else's pack, which is a claim about their work
   * that we cannot make. So a read-only pack says what is true instead, and
   * points at the Library, where its evidence images ARE readable
   * (`canvas:evidenceRead` is owner-or-project) and the row expands to show
   * them. When main starts returning the run's notes with the state, this
   * branch goes and `showRecall` covers it.
   *
   * ANY uat version, decided or not. The undecided case is not an exception:
   * the run's dist root is the OTHER session's build, so there is no live site
   * to serve either — the pack view is the only honest answer for both.
   */
  const readonlyPack = readOnly && isTesting
  const showRecall = !readOnly && isTesting && (!!submittedRound || userDecided)
  const recallNotes = useMemo(() => {
    if (!submittedRound || !reviewSession) return []
    const byId = new Map(reviewSession.annotations.map((a) => [a.id, a]))
    // The round's OWN order — the order the user wrote them in.
    return submittedRound.annotationIds.map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a)
  }, [submittedRound, reviewSession])
  const recallObservations = submittedRound
    ? submittedRound.decision === 'approve'
    : version.verdict?.state === 'approved'
  /**
   * Where "back" goes from a pack.
   *
   * The Library is the answer when there is nothing else on this canvas — the
   * mock's case, a run opened weeks later. But a canvas usually has more on it,
   * and recall replaces the whole stage (History control included): without
   * this, stepping onto a finished run would strand the user in it with the
   * Library overlay as the only exit. So when the canvas can still SHOW
   * something live, back is the canvas, and it goes there directly.
   */
  const liveEscapeVersion = useMemo(() => {
    const decidedTest = (v: CanvasVersion): boolean =>
      v.mode === 'uat' && (v.verdict?.state === 'approved' || v.verdict?.state === 'rejected')
    return [...versions].reverse().find((v) => !v.draft && v.id !== version.id && !decidedTest(v)) ?? null
  }, [versions, version.id])

  if (readonlyPack) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-[var(--surface-stage)]" data-testid="canvas-readonly-pack">
        <div
          className="h-[42px] shrink-0 flex items-center gap-2.5 px-3 bg-[var(--surface-chrome)]"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <button
            onClick={onOpenLibrary}
            className="shrink-0 flex items-center gap-1 text-[11.5px] rounded px-1.5 py-0.5 text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-panel)] transition-colors focus-ring"
            data-testid="canvas-readonly-pack-back"
          >
            <span aria-hidden className="text-[13px] leading-none">&lsaquo;</span> Library
          </button>
          <span className="min-w-0 truncate text-[12.5px] font-semibold text-[var(--text-primary)]">{packName}</span>
          <ReadOnlyChip />
          <div className="flex-1" />
          <DismissButton onClick={closePane} label="Close Agent Canvas" size={11} data-testid="canvas-readonly-pack-close" />
        </div>
        <div className="flex-1 flex items-center justify-center px-8 text-center">
          <p className="max-w-[420px] text-[12px] leading-[1.6]" style={{ color: 'var(--text-secondary)' }}>
            This test pack belongs to another session, so its notes stay with it. Its screenshots are in the Library —
            expand the row to look through them.
          </p>
        </div>
      </div>
    )
  }

  if (showRecall) {
    return (
      <CanvasEvidenceRecall
        sessionId={sessionId}
        canvasId={canvasId}
        version={version}
        packName={packName}
        // One function decides this word for the badge, History, the Library and
        // the MCP serializer, so a build the user pressed Fail on cannot read
        // back as APPROVED anywhere.
        verdict={verdictLabel(version, { observations: recallObservations ? recallNotes.length : 0 })}
        notes={recallNotes}
        observations={recallObservations}
        backLabel={liveEscapeVersion ? 'Canvas' : 'Library'}
        onBack={liveEscapeVersion ? () => void setActiveVersion(sessionId, liveEscapeVersion.id) : onOpenLibrary}
        onClose={closePane}
      />
    )
  }

  return (
    <div ref={paneRootRef} className="flex-1 flex flex-col min-h-0 bg-[var(--surface-stage)]">
      {/* Pane chrome — mode is the title (item C); the keel line under the bar
          carries the mode colour, and the tool chips on the right decide where
          the user's clicks land. */}
      <div className="relative h-[42px] shrink-0 flex items-center gap-2.5 px-3 bg-[var(--surface-chrome)]">
        <span
          aria-hidden
          className="absolute left-0 right-0 bottom-0 h-[2px]"
          style={{ background: `linear-gradient(90deg, ${modeLockup.color}, transparent 72%)` }}
          data-testid="canvas-mode-keel"
        />
        {/* C3 (canvas-approved header, 2026-08-26): Library is the way OUT —
            a back affordance at the far left, not a button floating mid-row. */}
        <button
          onClick={onOpenLibrary}
          className="shrink-0 flex items-center gap-1 text-[11.5px] rounded px-1.5 py-0.5 text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-panel)] transition-colors focus-ring"
          title="Every canvas in this project — open one here, or delete it"
          data-testid="canvas-library-open"
        >
          <span aria-hidden className="text-[13px] leading-none">&lsaquo;</span> Library
        </button>
        {/* Mode-as-title: the word the user thinks in, in its own colour. */}
        <span
          className="shrink-0 text-[13px] font-extrabold tracking-[0.09em] leading-none"
          style={{ color: modeLockup.color }}
          title={canvasModeBadge(version).title}
          data-testid="canvas-mode-word"
          data-canvas-mode={version.mode}
        >
          {modeLockup.word}
        </span>
        {/* WHAT this canvas is of — plain text (C3). Switching artifacts is
            the Library's job; the old subject dropdown and its "+N elsewhere"
            counter are gone. */}
        {canvasTitle && (
          <span
            className="min-w-0 truncate text-[12.5px] font-semibold text-[var(--text-primary)]"
            title={canvasTitle}
            data-testid="canvas-artifact-name"
          >
            {canvasTitle}
          </span>
        )}
        {/* READ-ONLY (M4): what the user is looking at, and why nothing here
            can be touched. Placed with the title rather than in a corner —
            "another session's work" is a fact about the SUBJECT. */}
        {readOnly && <ReadOnlyChip />}
        {/* The TEST PACK, named (M3). A run's evidence is a thing the user will
            come back to weeks later from the Library, and "v7" is not a name
            anybody recognises then. Click to rename in place; empty restores
            the derived default.
            MUTATION 1 of 8 suppressed by read-only: pack rename. The name still
            shows — it is what the pack is called — but as text. */}
        {isTesting && readOnly && (
          <span className="shrink-0 max-w-[280px] truncate text-[11.5px]" style={{ color: 'var(--text-secondary)' }} data-testid="canvas-pack-name-readonly">
            {packName}
          </span>
        )}
        {isTesting && !readOnly &&
          (renamingPack ? (
            <input
              autoFocus
              value={packDraft}
              maxLength={MAX_PACK_NAME_CHARS}
              onChange={(e) => setPackDraft(e.target.value)}
              onBlur={commitPackName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitPackName()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  setRenamingPack(false)
                }
              }}
              aria-label="Name this test pack"
              className="shrink-0 w-[220px] text-[11.5px] rounded-lg px-2 py-[3px] outline-none focus-ring"
              style={{
                background: 'var(--surface-sunken)',
                border: '1px solid var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              data-testid="canvas-pack-name-input"
            />
          ) : (
            <button
              onClick={() => {
                setPackDraft(version.packName ?? packName)
                setRenamingPack(true)
              }}
              className="shrink-0 inline-flex items-center gap-1.5 max-w-[280px] text-[11.5px] rounded-lg px-2.5 py-[3px] focus-ring transition-colors"
              style={{
                border: '1px dashed var(--border-subtle)',
                background: 'var(--surface-sunken)',
                color: 'var(--text-secondary)',
              }}
              title="Name this test pack — it is how you will find this run in the Library"
              data-testid="canvas-pack-name"
            >
              <span className="truncate">{packName}</span>
              {/* A drawn pencil: no emoji in JSX. */}
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ color: 'var(--text-muted)' }}>
                <path d="M4 20l3.5-.8L19 7.7a2 2 0 0 0-2.8-2.8L4.8 16.4z" />
              </svg>
            </button>
          ))}
        {/* Content zoom (#368) — shown only when it is not 1:1, click resets.
            The chip is the visibility the forged-zoom analysis leans on: a zoom
            the user did not ask for is never silent. */}
        {zoom !== 1 && (
          <button
            onClick={() => applyZoom({ steps: 0, reset: true })}
            data-testid="canvas-zoom-chip"
            title="Canvas zoom — Ctrl+wheel or Ctrl+= / Ctrl+- · click or Ctrl+0 to reset"
            className="shrink-0 text-[10px] rounded px-1.5 py-0.5 border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-panel)] transition-colors focus-ring"
          >
            {formatCanvasZoom(zoom)}
          </button>
        )}
        {/* ONE version control (C3): History with the stepper folded in and
            the pending pill riding it; its dropdown IS the version list. */}
        <CanvasHistoryControl
          versions={versions}
          activeVersionId={version.id}
          title={canvasTitle}
          // The same two inputs the pane's own pack name is derived from, in
          // the same order — one pack, one name, wherever it is written.
          configName={readOnly ? undefined : packConfigName}
          // Observations are counted off the session's OWN review mirror, so on
          // a foreign canvas the number would belong to a different run. Absent
          // reads as "none known" and History shows a plain PASSED.
          observationsByVersion={readOnly ? undefined : observationsByVersion}
          onSelectVersion={(id) => (readOnly ? onSelectVersion?.(id) : void setActiveVersion(sessionId, id))}
          // MUTATIONS 2 and 3 of 8 suppressed by read-only: artifact archive
          // and artifact delete. Both props are optional, so omitting them
          // removes the controls from the History dropdown entirely.
          onArchive={readOnly ? undefined : (artifact) => {
            // Reversible: the store returns the new state and pushes a change,
            // but refresh here makes the picker update without the round-trip.
            // `sessionId` is who is ASKING — main's owner guard (M4), not a
            // claim the renderer gets to make.
            void window.electronAPI.canvas
              .archiveArtifact({ sessionId, canvasId, versionId: artifact.key, archived: !artifact.archived })
              .then(() => useCanvasStore.getState().refresh(sessionId))
          }}
          onDelete={readOnly ? undefined : (artifact) => {
            void window.electronAPI.canvas
              .deleteArtifact({ sessionId, canvasId, versionId: artifact.key })
              .then(() => useCanvasStore.getState().refresh(sessionId))
          }}
        />
        {/* C3: the "N reviews open" chip and its "+N elsewhere" sibling are
            gone — the count lives in exactly one place (the toolbar Canvas
            button), and History carries the pending pill. */}
        <div className="flex-1" />
        {/* END TEST (M3) — the way out that is NOT a decision. Testing runs are
            long and interruptible: this closes the pane and leaves the run
            exactly as it stands, notes and all. The Pass/Fail buttons in the
            panel are the only things that end a run. */}
        {isTesting && versionOpen && !readOnly && (
          <button
            onClick={closePane}
            disabled={returning}
            className="shrink-0 text-[11.5px] rounded px-2 py-0.5 border transition-colors focus-ring disabled:opacity-40 disabled:cursor-default"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', background: 'var(--surface-panel)' }}
            title="Back to the terminal — the run stays open, with everything you have written so far"
            data-testid="canvas-end-test"
          >
            End test
          </button>
        )}
        {/* The ONE dismiss control (M2). Still disabled while the submit
            hand-back is in flight (#478): that transition owns the pane. */}
        <DismissButton
          onClick={closePane}
          disabled={returning}
          size={11}
          label="Close Agent Canvas"
          title={returning ? 'Returning to the terminal…' : 'Close Agent Canvas'}
          data-testid="canvas-pane-close"
          className="hover:bg-[var(--surface-panel)]"
        />
      </div>

      {/* C3 row 2 — the TOOLS row, on its own line (canvas-approved header):
          X-Ray's three modes under their real name (the "Inspect" chip died —
          browse is where any X-Ray click puts you), the annotate tools under
          their own label, the contextual hint inline where the old full-width
          mode strip was, and the artifact sign-off at the far right. */}
      <div className="flex items-center gap-2 px-3 py-1 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] text-[11px] shrink-0" role="group" aria-label="Canvas tools" data-testid="canvas-tool-chips">
        <div
          // No overflow-hidden: .focus-ring is an outward box-shadow and
          // clipping it left keyboard focus invisible (review HIGH). The end
          // children carry their own inner radii instead.
          className="flex items-stretch h-[24px] rounded-md border transition-colors shrink-0"
          style={{ borderColor: inspectActive ? 'color-mix(in srgb, var(--brand) 52%, transparent)' : 'var(--border-subtle)' }}
          data-testid="canvas-inspect-capsule"
        >
            <div
              className={`flex items-center rounded-[5px] text-[11px] ${inspectPaused ? 'opacity-40' : ''}`}
              style={{ background: inspectActive ? 'color-mix(in srgb, var(--brand) 6%, transparent)' : 'color-mix(in srgb, var(--surface-panel) 60%, transparent)' }}
              role="group"
              aria-label="X-Ray mode"
              data-testid="canvas-xray-mode"
              title={planLocked ? 'X-Ray is locked to Stealth on a plan — a document of steps needs no boxes on the page, and Off would break note anchoring.' : undefined}
            >
              <span
                className="pl-2 pr-1 text-[9px] font-bold tracking-[0.08em] leading-none"
                style={{ color: inspectActive ? 'var(--brand)' : 'var(--text-secondary)' }}
                aria-hidden
              >
                X-RAY
              </span>
              {CANVAS_XRAY_MODE_OPTIONS.map((option) => {
                const selected = xrayMode === option.value
                return (
                  <button
                    key={option.value}
                    onClick={() => {
                      // A click on any X-Ray segment is also the way back to
                      // browse (the old Inspect chip's job): the annotate
                      // tools release the pointer and the mode applies.
                      setMarqueeArmed(sessionId, false)
                      setInteractionMode(sessionId, 'browse')
                      if (!planLocked) setXrayMode(option.value)
                    }}
                    aria-pressed={selected}
                    disabled={planLocked}
                    className="px-2 self-stretch rounded-none last:rounded-r-[5px] leading-none transition-colors focus-ring disabled:cursor-default"
                    style={selected
                      ? { background: 'color-mix(in srgb, var(--brand) 18%, transparent)', color: 'var(--brand)', fontWeight: 600 }
                      : { color: 'var(--text-secondary)' }}
                    title={option.title}
                    data-testid={`canvas-xray-${option.value}`}
                  >
                    {option.label}
                  </button>
                )
              })}
              {planLocked && (
                // A DRAWN padlock, not the lock emoji (#449): the repo's rule
                // is no emoji in JSX — they render inconsistently across
                // platforms and esbuild rejects the \u{...} escape form anyway.
                <span className="px-1.5 inline-flex items-center" style={{ color: 'var(--text-muted)' }} aria-hidden>
                  <svg width="9" height="11" viewBox="0 0 10 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="1.5" y="5" width="7" height="6" rx="1.2" />
                    <path d="M3.2 5V3.4a1.8 1.8 0 0 1 3.6 0V5" />
                  </svg>
                </span>
              )}
            </div>
          </div>
          {/* MUTATIONS 4, 5 and 6 of 8 suppressed by read-only: Sketch, Tools
              and Region. The whole ANNOTATE group goes, label and all — a
              disabled chip still says "you could annotate this", and on
              somebody else's finished work that is not true. X-Ray stays: it
              only reads the page. */}
          {!readOnly && (
          <>
          <span aria-hidden className="w-px h-[16px] shrink-0" style={{ background: 'var(--border-subtle)' }} />
          <span className="text-[9px] font-bold tracking-[0.08em] shrink-0" style={{ color: 'var(--text-secondary)' }} aria-hidden>
            ANNOTATE
          </span>
          {/* W17: a TOGGLE, not a setter — and the fix for BOTH W24 and W19.
              Sketch used to be one-way: nothing in this row said "stop
              sketching", so the only way back to the content was a click on an
              X-Ray segment, which does not look like one. The glass then owned
              the pointer for the rest of the session (the mode is per-session
              state that outlives the pane), with two symptoms that were
              reported as separate bugs.

              W24 — a tall page would not scroll. In draw mode the interactive
              canvas covers the whole stage, the scrollbar included, so neither
              the wheel nor a drag on it ever reached the page; and the wheel
              did not even move the glass instead, because the repin snaps the
              scene back to the content's (unchanged) scroll.

              W19 — right-click did nothing. Excalidraw's context menu is fine;
              in BROWSE mode the glass is inert, so the gesture never reaches
              it, and there was no legible way to get into the mode where it
              would. Pressing Sketch again gives the pointer back. */}
          <button
            onClick={() => {
              setMarqueeArmed(sessionId, false)
              setInteractionMode(sessionId, sketchActive ? 'browse' : 'draw')
            }}
            aria-pressed={sketchActive}
            disabled={viewingCompleted}
            className={chipClass(sketchActive, false)}
            style={chipStyle(sketchActive)}
            title={
              viewingCompleted
                ? 'This canvas is signed off — Reopen it to annotate again'
                : sketchActive
                  ? 'Stop sketching — give the pointer back to the page (scrolling and clicking work again)'
                  : 'Sketch — the glass takes the pointer; draw over the content and the strokes ride your next note'
            }
            data-testid="canvas-tool-sketch"
          >
            <ToolIcon kind="sketch" />
            Sketch
          </button>
          {/* Only while drawing: outside draw mode Excalidraw renders no
              islands, so a control for hiding them would be a control for
              nothing. */}
          {sketchActive && (
            <button
              onClick={() => setToolsVisible((v) => !v)}
              aria-pressed={toolsVisible}
              className={chipClass(false, false)}
              style={chipStyle(false)}
              title={toolsVisible ? 'Hide the drawing tools — the page underneath, without leaving Sketch' : 'Show the drawing tools'}
              data-testid="canvas-tool-tools"
            >
              <ToolIcon kind="tools" />
              Tools
            </button>
          )}
          <button
            onClick={() => setMarqueeArmed(sessionId, !marqueeArmed)}
            aria-pressed={regionActive}
            disabled={!viewport || viewingCompleted}
            className={chipClass(regionActive, false)}
            style={chipStyle(regionActive)}
            title={viewingCompleted ? 'This canvas is signed off — Reopen it to annotate again' : 'Region — drag a rectangle to select an area for a note (Esc cancels)'}
            data-testid="canvas-tool-region"
          >
            <ToolIcon kind="region" />
            Region
          </button>
          </>
          )}
        {/* The contextual hint, inline where the old full-width mode strip
            was — the strip row itself is gone (C3). */}
        <span className={`font-semibold uppercase tracking-wide shrink-0 ${modeStrip.color}`}>{modeStrip.label}</span>
        <span className="text-[var(--text-secondary)] truncate" data-testid="canvas-tool-hint">{modeStrip.hint}</span>
        <div className="flex-1" />
        {/* Subject-level sign-off (#476) — far right of the tools row (C3). */}
        {/* The version ON SCREEN, so the button asks "is this artefact still
            open?" of the run the user is actually looking at — a canvas holds
            several, and the newest is not necessarily the displayed one.
            MUTATION 7 of 8 suppressed by read-only: Mark complete. Signing off
            somebody else's canvas is theirs to do, and it is already complete
            by the time it is visible here at all. */}
        {!readOnly && (
          <CanvasCompleteButton sessionId={sessionId} canvasId={canvasId} title={canvasTitle} displayedVersionId={version.id} />
        )}
      </div>

      <div className="relative flex-1 flex min-h-0">
        {/* Stage: the reviewed page in a framed card (item C) so the boundary
            between the agent's content and the app is unmistakable. The padded
            outer holds the "PAGE UNDER REVIEW" tag over the frame's top border;
            the inner frame is overflow-hidden, which is what keeps highlight
            boxes for offscreen page coords from bleeding over the chrome. The
            iframe, glass and overlay all fill this frame 1:1, so their pinning
            is unchanged — the frame is a smaller box they share, not a new
            coordinate space. */}
        <div className="flex-1 min-w-0 relative p-2.5">
          <span
            className="absolute z-10 top-2.5 left-5 -translate-y-1/2 px-2 py-px rounded text-[9.5px] tracking-[0.08em] pointer-events-none"
            style={{ background: 'var(--surface-stage)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
            data-testid="canvas-content-tag"
          >
            PAGE UNDER REVIEW
          </span>
          <div
            ref={contentFrameRef}
            className="absolute inset-2.5 rounded-lg overflow-hidden"
            style={{ border: '2px solid var(--border-subtle)', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.28)' }}
            data-testid="canvas-content-frame"
          >
          <iframe
            // Keyed on the URL so a version switch mounts a NEW element. Reusing
            // one iframe leaves the OLD document in contentWindow until the new
            // src commits, and versions share a canvas origin — so a snapshot
            // taken in that window would be answered by the previous version and
            // then stamped with the new version's id.
            // The nonce is the retry: same URL, new element, fresh load.
            key={`${contentUrl}#${reloadNonce}`}
            ref={iframeRef}
            src={contentUrl}
            title="Agent Canvas content"
            onLoad={() => setFrameLoaded(true)}
            // Same-origin is safe here: the frame's ccc-ux://<canvasId> origin is
            // never the app's own origin, so the content cannot reach the host
            // document; scripts+forms are what real pages need (spec §3.2, D14).
            sandbox="allow-scripts allow-same-origin allow-forms"
            // Delegate NOTHING. The parent's half of the permissions ceiling the
            // ccc-ux:// response header sets on the document itself, and the
            // same empty list the off-screen capture frame has carried since
            // 2026-08-15 — the two frames load the same untrusted documents, so
            // the visible one must not be the permissive path (camera, mic,
            // geolocation, display-capture) just because it has chrome to show a
            // prompt in.
            allow=""
            referrerPolicy="no-referrer"
            // The pre-paint frame is the APP's stage colour, not white: a white
            // flash in a dark pane read as a broken render every time a version
            // arrived. (The Excalidraw glass below stays theme="light" — that
            // one is deliberate, see the comment on glassInitialData.)
            className="absolute left-0 top-0 border-0 bg-[var(--surface-stage)]"
            // Content zoom (#368): percentage sizes self-compensate under
            // standardized CSS zoom, so 100% keeps the frame filling the stage
            // at every zoom while the content reflows to stage/zoom and paints
            // scaled — see frameStyleForZoom for the measured rule.
            style={frameStyleForZoom(zoom)}
          />
          {/* Glass — Excalidraw over the content, transparent board, pointer
              only in draw mode. A sibling overlay, never injected (D7). */}
          <div
            className="absolute inset-0"
            style={{
              pointerEvents: pointerOwner === 'glass' ? 'auto' : 'none',
              // Out of the SHOT, not out of the scene (M3). `capturePage`
              // photographs the window, and the recall view lays a note's
              // drawing back over its screenshot from the sketch's own PNG —
              // baking the strokes into the picture as well would draw every
              // mark twice. `visibility` rather than a remount: the glass keeps
              // its scene, its camera and its undo stack across the frame.
              visibility: capturingEvidence ? 'hidden' : undefined,
            }}
            data-canvas-layer="glass"
            // W24: `pointer-events: none` above is INHERITED, and Excalidraw's
            // own stylesheet re-declares the property on its islands — so the
            // host's word is not final until a rule says so. See the
            // `[data-glass-inert]` block in styles.css. The testid rides the
            // same condition so a VM pass can point at the one attribute that
            // decides whether the page under review can be scrolled at all.
            data-glass-inert={pointerOwner === 'glass' ? undefined : 'true'}
            data-testid={pointerOwner === 'glass' ? 'canvas-glass-live' : 'canvas-glass-inert'}
            // W17: the islands, out of the way, without leaving draw mode.
            data-glass-tools={toolsVisible ? 'shown' : 'hidden'}
          >
            <Excalidraw
              excalidrawAPI={(api) => {
                glassApiRef.current = api
                repinGlass()
                // The glass exists now, so anything that was waiting for it
                // goes on: first whatever the panel asked to restore, then —
                // only if nobody asked — the pane's own in-memory belt.
                const pending = pendingRestoreRef.current
                if (pending) {
                  pendingRestoreRef.current = null
                  beltAppliedRef.current = true
                  restoreSketchScene(pending)
                  return
                }
                if (beltAppliedRef.current) return
                beltAppliedRef.current = true
                const stashed = useCanvasStore.getState().sketchByCanvasId[canvasId]?.scene
                if (stashed) restoreSketchScene(stashed)
              }}
              theme="light"
              initialData={glassInitialData}
              // Version-stamp every element the first time it appears (C1):
              // whatever version is on screen owns it from then on.
              onChange={(els) => {
                let drewSomethingNew = false
                for (const el of els) {
                  if (!el.isDeleted && !sketchVersionRef.current.has(el.id)) {
                    sketchVersionRef.current.set(el.id, versionIdRef.current)
                    drewSomethingNew = true
                  }
                }
                const livingNow = els.filter((el) => !el.isDeleted)
                lastSceneRef.current = livingNow
                if (livingNow.length > 0) hadSketchElementsRef.current = true
                noteGlassChanged(livingNow)
                // A first stroke IS starting a note (M3). Gated on DRAW mode as
                // well as on the element being new, because a restore (a pane
                // toggle, a draft coming back) also puts elements the pane has
                // never stamped onto the glass — and that is not a user drawing.
                if (drewSomethingNew && modeRef.current === 'draw') beginEvidence()
              }}
              onScrollChange={handleGlassScrolled}
              // Outside draw mode the glass is inert: view mode drops every
              // island so nothing floats over the page being reviewed.
              viewModeEnabled={pointerOwner !== 'glass'}
              // Zen mode OFF (W18). It was on to keep draw mode down to the
              // tools, and what it actually dropped was the PROPERTIES island —
              // stroke colour, font family, font size, opacity — so a text mark
              // could be typed and then never coloured or resized, which read
              // as Excalidraw being broken inside the pane. The unwanted chrome
              // (main menu, sidebar triggers, help, footer) is hidden by the
              // glass-scoped CSS instead, which takes only what it names.
              zenModeEnabled={false}
              UIOptions={glassUIOptions}
            />
          </div>
          {/* Transient highlight overlay — plain divs, never Excalidraw elements
              (D7): browse hover, the locked selection, panel-driven highlights.
              Clipped to the stage so a box for offscreen page coords cannot
              paint over the surrounding chrome. */}
          <div
            className="absolute inset-0 pointer-events-none overflow-hidden"
            data-canvas-layer="overlay"
            // Hidden for the evidence shot — a hover box or a selection label
            // baked into a screenshot is the app's chrome masquerading as the
            // page's own (M3).
            style={{ visibility: capturingEvidence ? 'hidden' : undefined }}
          >
            {stageHoverRect && (
              <div
                className="absolute border-2 border-blue rounded-sm"
                style={{
                  left: stageHoverRect.x,
                  top: stageHoverRect.y,
                  width: stageHoverRect.width,
                  height: stageHoverRect.height,
                  background: 'color-mix(in srgb, var(--color-blue) 12%, transparent)',
                }}
              />
            )}
            {focusStageRect && (
              <>
                <div
                  data-testid="canvas-focus-box"
                  className="absolute border-2 border-peach rounded-sm"
                  style={{
                    left: focusStageRect.x,
                    top: focusStageRect.y,
                    width: focusStageRect.width,
                    height: focusStageRect.height,
                    background: 'color-mix(in srgb, var(--color-peach) 10%, transparent)',
                  }}
                />
                <div
                  className="absolute px-1.5 py-0.5 text-[10px] rounded bg-crust text-peach border border-peach/50 whitespace-nowrap max-w-[60%] overflow-hidden text-ellipsis"
                  style={{
                    left: Math.max(0, focusStageRect.x),
                    top: Math.max(0, focusStageRect.y - 22),
                  }}
                  // An element label is the PAGE's description of itself,
                  // assembled by the artifact under review. A region label is
                  // ours (its size, measured on the glass), so only the first
                  // carries the attribution.
                  title={focusIsPageReported ? PAGE_REPORTED_TITLE : undefined}
                >
                  {focusIsPageReported && <span className="text-overlay1">{PAGE_REPORTED_MARK} </span>}
                  {focus?.label} · ↑ parent · Esc
                </div>
              </>
            )}
            {/* Three kinds, and the difference is WHO measured the box.
                'anchored' is ours (the note's stored box, or a note written
                against the version on screen) and paints solid green;
                'reported' is where the page claims an old note re-anchors to
                and paints dashed blue — the app has no way to check it, so it
                must not wear the colour that means resolved; 'ghost' is the
                stale box of something that did not re-anchor. */}
            {highlightStageRect && (
              <div
                className={`absolute rounded-sm border-2 ${
                  panelHighlight?.kind === 'anchored'
                    ? 'border-green'
                    : panelHighlight?.kind === 'reported'
                      ? 'border-blue'
                      : 'border-overlay1'
                }`}
                style={{
                  left: highlightStageRect.x,
                  top: highlightStageRect.y,
                  width: highlightStageRect.width,
                  height: highlightStageRect.height,
                  borderStyle: panelHighlight?.kind === 'anchored' ? 'solid' : 'dashed',
                  background:
                    panelHighlight?.kind === 'anchored'
                      ? 'color-mix(in srgb, var(--color-green) 10%, transparent)'
                      : panelHighlight?.kind === 'reported'
                        ? 'color-mix(in srgb, var(--color-blue) 8%, transparent)'
                        : 'transparent',
                }}
              />
            )}
            {stageHoverRect && (
              <div
                className="absolute px-1.5 py-0.5 text-[10px] rounded bg-crust text-text border border-surface1 whitespace-nowrap max-w-[60%] overflow-hidden text-ellipsis"
                style={{
                  left: Math.max(0, stageHoverRect.x),
                  top: Math.max(0, stageHoverRect.y - 22),
                }}
                // Every word of this chip — role, name, tag, ux-id — is the
                // frame's `pointer` report about itself, so it is marked like
                // every other page-authored identity in the pane. It was the one
                // that was not: the locked label, the notes-panel labels and the
                // checklist all carry the attribution, while the readout the
                // reviewer actually reads while hunting an element printed the
                // artifact's account of itself in the app's own voice
                // (adversarial review, 2026-08-15). Unconditional, unlike the
                // locked label's marker — a hover is never a region.
                title={PAGE_REPORTED_TITLE}
              >
                <span className="text-overlay1">{PAGE_REPORTED_MARK} </span>
                {hoverLabel}
              </div>
            )}
          </div>
          {/* Marquee capture layer — owns the pointer only while armed, the
              same ownership pattern as the glass (D7). */}
          {marqueeArmed && (
            <div
              className="absolute inset-0 cursor-crosshair"
              data-canvas-layer="marquee"
              onMouseDown={marqueeMouseDown}
              onMouseMove={marqueeMouseMove}
              onMouseUp={marqueeMouseUp}
              onMouseLeave={() => setMarqueeDrag(null)}
            >
              {marqueeDrag && (
                <div
                  data-testid="canvas-marquee-rect"
                  className="absolute border-2 border-peach"
                  style={{
                    left: Math.min(marqueeDrag.x0, marqueeDrag.x1),
                    top: Math.min(marqueeDrag.y0, marqueeDrag.y1),
                    width: Math.abs(marqueeDrag.x1 - marqueeDrag.x0),
                    height: Math.abs(marqueeDrag.y1 - marqueeDrag.y0),
                    borderStyle: 'dashed',
                    background: 'color-mix(in srgb, var(--color-peach) 8%, transparent)',
                  }}
                />
              )}
            </div>
          )}
          {/* Load status. A dead render has to SAY so: before this, a 404, a
              CSP-blocked bridge script and a crashed page all sat on "Loading
              content…" forever, indistinguishable from a slow one. aria-live so
              the change reaches a screen reader, not just the eye. */}
          {/* The region itself is always mounted — a live region added to the
              DOM together with its first message is not reliably announced. */}
          <div
            className="absolute inset-x-0 bottom-2 px-3 flex justify-center pointer-events-none"
            role="status"
            aria-live="polite"
          >
            {!bridgeReady && !loadTimedOut && (
              <span className="px-2 py-0.5 text-[11px] rounded bg-[var(--surface-panel)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                Loading content…
              </span>
            )}
            {!bridgeReady && loadTimedOut && (
              <div className="pointer-events-auto flex items-center gap-2 max-w-full px-2.5 py-1.5 rounded-md bg-[var(--surface-overlay)] border border-[var(--border-strong)] shadow-lg">
                <span className="text-[11px] text-[var(--text-primary)] truncate">
                  {frameLoaded
                    ? "This version loaded but never reported in — its page didn't run, so notes can't anchor to it."
                    : "This version didn't load."}
                </span>
                <button
                  onClick={retryFrame}
                  className="shrink-0 px-2 py-0.5 text-[11px] font-medium rounded bg-[var(--surface-panel)] text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] transition-colors focus-ring"
                >
                  Retry
                </button>
              </div>
            )}
            {/* The channel was dropped for flooding. Said out loud: hover,
                click-to-lock and the checklist's re-anchor pass have all
                stopped, and a pane that silently stopped responding would read
                as the app being broken rather than the page misbehaving. */}
            {bridgeFlooded && (
              <div className="pointer-events-auto flex items-center gap-2 max-w-full px-2.5 py-1.5 rounded-md bg-[var(--surface-overlay)] border border-[var(--border-strong)] shadow-lg">
                <span className="text-[11px] text-[var(--text-primary)] truncate">
                  This page flooded the canvas bridge, so live inspection was switched off. The page is still shown.
                </span>
                <button
                  onClick={retryFrame}
                  className="shrink-0 px-2 py-0.5 text-[11px] font-medium rounded bg-[var(--surface-panel)] text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] transition-colors focus-ring"
                >
                  Reload page
                </button>
              </div>
            )}
          </div>
          {/* The PAUSE SHIELD, last child of the frame (M3): while a note is
              being written the site underneath it is frozen, so the words the
              user types are about the screen the note actually locked. Testing
              only — a mockup and a plan never sprout one. */}
          {/* Never on a read-only surface: the shield exists to freeze a site
              while the user writes a note about it, and a read-only pane has no
              composer to write one in — a shield there would be a dead overlay
              over somebody else's work. Belt to the two guards above. */}
          {isTesting && !readOnly && pendingEvidence && (
            <CanvasPauseShield
              onCancelHint="Esc cancels this note"
              // In draw mode the glass already covers the page and owns the
              // pointer, so the shield steps aside: a mark made while writing a
              // note belongs to that note, and freezing the annotation tool
              // along with the site would be the pause eating its own purpose.
              passThrough={pointerOwner === 'glass'}
            />
          )}
          </div>
        </div>

        {/* Notes panel — docked (spec D3) — with the stealth x-ray readout
            below it when that mode is on (#367). The readout is a SIBLING, not
            a section of the panel: it belongs to the stage's pointer, not to
            the review, and keeping it out means the panel's own file is
            untouched by this change. The panel keeps its own width and left
            border; this column just stacks the two. */}
        {/* MUTATION 8 of 8 suppressed by read-only: the whole review panel —
            composer, decision bar, per-note controls, reopen, evidence capture
            and the draft persistence behind them. `viewingCompleted` is the
            union (see its definition), so this one condition removes them all
            rather than eight separate guards that could drift apart. */}
        {viewingCompleted ? null : panelHidden ? (
          /* Collapsed rail (item C): the panel is away, the page has the width,
             and this keeps the outstanding count and the way back. */
          <button
            onClick={() => setPanelHidden(false)}
            data-testid="canvas-panel-rail"
            aria-label="Show the review panel"
            title="Show the review panel"
            className="shrink-0 w-[30px] flex flex-col items-center gap-2 py-2.5 border-l border-[var(--border-subtle)] bg-[var(--surface-chrome)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-ring"
          >
            <span aria-hidden>⟨</span>
            {openReviewCount > 0 && (
              <span
                className="text-[10px] font-bold rounded-full px-[5px] leading-[1.4]"
                style={{ background: 'var(--color-peach)', color: 'var(--surface-chrome)' }}
              >
                {openReviewCount}
              </span>
            )}
            <span className="text-[10px] tracking-[0.12em]" style={{ writingMode: 'vertical-rl' }} aria-hidden>
              REVIEW
            </span>
          </button>
        ) : (
          <div className="shrink-0 flex flex-col min-h-0 transition-[width] duration-[240ms] ease-out">
            <div className="flex-1 min-h-0 flex">
              <CanvasNotesPanel
                sessionId={sessionId}
                // The canvas the SURFACE is keyed by, not the one the review
                // mirror happens to hold: during a switch the two disagree for
                // a beat, and a composer draft written in that beat belongs to
                // the canvas the user just left.
                canvasId={canvasId}
                version={version}
                // W20/BLOCKER: the panel cannot watch the glass, so the pane
                // tells it THAT something changed. Without this nothing
                // re-rendered after a stroke and "Add note" stayed dead until
                // the user toggled Sketch off and on again.
                sketchRevision={sketchRevision}
                getGlassApi={() => glassApiRef.current}
                getAllSketchElements={allSketchElements}
                // W20: the glass belongs to the pane, the persistence belongs
                // to the panel (it owns the composer-draft IPC). These four are
                // the whole seam between them.
                getUnattachedSketchElementIds={getUnattachedSketchElementIds}
                markSketchElementsAttached={markSketchElementsAttached}
                getSketchSceneForPersist={getSketchSceneForPersist}
                restoreSketchScene={restoreSketchScene}
                onReturnToTerminal={closePane}
                isActive={isActive}
                onHide={() => setPanelHidden(true)}
                // Testing mode's evidence seam (M3). Absent in every other
                // mode, which is what makes "a mockup never captures anything"
                // structural rather than a condition somebody has to remember.
                evidence={
                  isTesting
                    ? {
                        pending: pendingEvidence,
                        notice: evidenceNotice,
                        begin: beginEvidence,
                        discard: discardEvidence,
                        lock: lockEvidence,
                        adopt: adoptEvidence,
                        registerCancel: (fn) => {
                          cancelNoteRef.current = fn
                        },
                        runTrail: () => trailForRun(canvasId, version.id),
                        endRun: () => resetTrail(canvasId, version.id),
                      }
                    : undefined
                }
              />
            </div>
            {xrayReadsOutInPanel(xrayMode) && (
              <CanvasXrayReadout
                hit={pointerOwner === 'content' ? (hover?.hit ?? null) : null}
                label={hoverLabel}
                pointerOwner={pointerOwner}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
