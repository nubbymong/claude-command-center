import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import CanvasEmptyState from './CanvasEmptyState'
import { CanvasLibrary } from './CanvasLibrary'
import CanvasSubjectPicker from './CanvasSubjectPicker'
import CanvasFiledStrip from './CanvasFiledStrip'
import CanvasNotesPanel from './CanvasNotesPanel'
import CanvasCompleteButton from './CanvasCompleteButton'
import CanvasHistoryControl from './CanvasHistoryControl'
import CanvasXrayReadout from './CanvasXrayReadout'
import { useCanvasStore } from '../stores/canvasStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useExcalidrawStore } from '../stores/excalidrawStore'
import {
  MAX_RESOLVE_ANCHORS,
  CanvasHitInfo,
  CanvasViewportInfo,
  CanvasVersion,
  canvasContentUrl,
  type AnchorRef,
  type CanvasHoverReportingResult,
} from '../../shared/canvas'
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
import { openReviewsOf, openSubmittedNotesOf, useCanvasReviewStore } from '../stores/canvasReviewStore'
import { useCanvasTotalsStore } from '../stores/canvasTotalsStore'

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
 *  rectangle + arrow = Region. Stroke-only, sized for a 26px chip. */
function ToolIcon({ kind }: { kind: 'inspect' | 'sketch' | 'region' }) {
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
  return (
    <svg {...common}>
      <rect x="4" y="6" width="12" height="10" rx="1" strokeDasharray="3 2.4" />
      <path d="M18 14l3 7-3.2-1.2L16 22z" />
    </svg>
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

  // The library lives HERE, above the empty-state branch, not inside the
  // surface. Deleting the canvas you are looking at empties the pane, which
  // used to unmount the very overlay the delete button was in — a destructive
  // control that destroys its own host, mid-action.
  if (!canvasState?.canvasId || !activeVersion) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
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
    <div className="flex-1 flex flex-col min-h-0 relative">
      {/* Above the surface, so the one thing that happened without asking is
          the first thing read. */}
      <CanvasFiledStrip sessionId={sessionId} />
      <CanvasSurface
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

function CanvasSurface({ sessionId, canvasId, title: canvasTitle, version, versions, onOpenLibrary, isActive }: SurfaceProps) {
  const togglePane = useExcalidrawStore((s) => s.togglePane)
  // #478: the submit hand-back in flight — the close control disables so the
  // submit-triggered transition is the only driver of pane state.
  const returning = useExcalidrawStore((s) => !!s.submitReturnBySession[sessionId])
  // #476: viewing a canvas already signed off. The review panel (and its rail)
  // stay away — nothing is owed on it by invariant, and note-taking on a
  // completed subject is off until the user Reopens it.
  const viewingCompleted = useCanvasStore((s) => !!s.bySessionId[sessionId]?.completed)
  const mode = useCanvasStore((s) => s.bySessionId[sessionId]?.interactionMode ?? 'browse')
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

  const focus = useCanvasReviewStore((s) => s.bySessionId[sessionId]?.focus ?? null)
  const marqueeArmed = useCanvasReviewStore((s) => s.bySessionId[sessionId]?.marqueeArmed ?? false)
  const panelHighlight = useCanvasReviewStore((s) => s.bySessionId[sessionId]?.panelHighlight ?? null)
  const reviewSession = useCanvasReviewStore((s) => s.bySessionId[sessionId])
  const setMarqueeArmed = useCanvasReviewStore((s) => s.setMarqueeArmed)

  // #476: the MODES go with the chips. interactionMode/marqueeArmed are
  // per-session renderer state that survives the detach and the adopt, so
  // without this a pane opened onto a completed canvas could arrive with the
  // glass live in Sketch and no panel to receive the strokes.
  useEffect(() => {
    if (!viewingCompleted) return
    setInteractionMode(sessionId, 'browse')
    setMarqueeArmed(sessionId, false)
  }, [viewingCompleted, sessionId, setInteractionMode, setMarqueeArmed])

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

  /** A reported content click (browse mode) becomes a locked selection: ask
   *  the frame for the chain at that point, then lock its deepest entry. The
   *  page's own click behaviour already happened — the bridge only observed.
   *  Coalesced to ONE outstanding inspect: a click cannot be answered twice,
   *  and the RPC layer's per-frame cap is a backstop, not the design. */
  const inspectAndLock = useCallback(
    async (pageX: number, pageY: number) => {
      const target = iframeRef.current?.contentWindow
      if (!target || inspectPendingRef.current) return
      inspectPendingRef.current = true
      try {
        const raw = await askCanvasFrame(target, canvasId, { type: 'inspect', x: pageX, y: pageY }, 5000)
        const { chain } = safeInspectResult(raw)
        if (chain.length > 0) {
          useCanvasReviewStore.getState().lockFocus(sessionId, chain, versionIdRef.current)
        }
      } catch {
        /* frame busy or navigating — the hover chip still works */
      } finally {
        inspectPendingRef.current = false
      }
    },
    [canvasId, sessionId],
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
        },
        onViewport: (vp) => {
          setViewport(vp)
          setHover(null)
          viewportRef.current = vp
          repinGlass()
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
        onContentClick: (pageX, pageY) => {
          // Click-to-lock (spec §6 step 3) — browse mode only; in draw mode the
          // glass owns the pointer and a frame click cannot happen anyway.
          // Under x-ray Off a click selects nothing: the page was asked for as a
          // normal browser tab, and a tab does not turn a click into a selection
          // (#367 left this open; see xrayClickSelects).
          if (!xrayClickSelects(xrayModeRef.current)) return
          if (modeRef.current === 'browse') void inspectAndLock(pageX, pageY)
        },
        onContentKey: handleReportedKey,
        onContentZoom: applyZoom,
        onFlood: () => setBridgeFlooded(true),
      },
    })
  }, [repinGlass, canvasId, inspectAndLock, handleReportedKey, applyZoom, syncHoverReporting])

  // The same two keys, host-side, for when the HOST document has keyboard
  // focus (after touching the panel or the chrome). Never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.key === 'Escape') {
        handleReportedKey('Escape')
      } else if (e.key === 'ArrowUp' && useCanvasReviewStore.getState().bySessionId[sessionId]?.focus) {
        e.preventDefault()
        handleReportedKey('ArrowUp')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessionId, handleReportedKey])

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
  const elsewhereOpen = useCanvasTotalsStore((s) => {
    const t = s.bySessionId[sessionId]
    return t?.loaded ? Math.max(0, t.openReviews - t.onActive) : 0
  })
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
  const glassInitialData = useMemo(
    () => ({ appState: { viewBackgroundColor: 'transparent' } }) as never,
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
      ? { color: 'text-mauve', label: 'Sketch', hint: 'the glass takes the pointer; draw over the content, then attach the strokes to a note' }
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
        {/* WHAT this canvas is of, and the way to the others. A session authors
            many canvases, so the pane has to say which one you are looking at
            and let you reach the rest. */}
        <CanvasSubjectPicker
          sessionId={sessionId}
          canvasId={canvasId}
          title={canvasTitle}
          onOpenLibrary={onOpenLibrary}
        />
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
        {/* Two-level history (item C, phase 4): a per-artifact version stepper
            + a History ▾ picker, replacing the flat version select. A single
            version of a single artifact renders neither (the control returns
            null), so the empty-state chrome stays quiet. */}
        <CanvasHistoryControl
          versions={versions}
          activeVersionId={version.id}
          onSelectVersion={(id) => void setActiveVersion(sessionId, id)}
          onArchive={(artifact) => {
            // Reversible: the store returns the new state and pushes a change,
            // but refresh here makes the picker update without the round-trip.
            void window.electronAPI.canvas
              .archiveArtifact({ canvasId, versionId: artifact.key, archived: !artifact.archived })
              .then(() => useCanvasStore.getState().refresh(sessionId))
          }}
          onDelete={(artifact) => {
            void window.electronAPI.canvas
              .deleteArtifact({ canvasId, versionId: artifact.key })
              .then(() => useCanvasStore.getState().refresh(sessionId))
          }}
        />
        {/* What is still owed on THIS canvas. From one, unlike the Canvas
            button's pill: in here you are already looking at the thing, so one
            outstanding round is worth naming rather than hiding. */}
        {openReviewCount > 0 && (
          <span
            className="shrink-0 flex items-center gap-1.5 text-[11px] font-semibold rounded-full px-2 py-0.5"
            style={{
              color: 'var(--color-peach)',
              background: 'color-mix(in srgb, var(--color-peach) 13%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-peach) 40%, transparent)',
            }}
            title="Sent for review and not closed out. A review closes when every note in it has your verdict."
            data-testid="canvas-pane-open-reviews"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {openReviewCount} review{openReviewCount === 1 ? '' : 's'} open
          </span>
        )}
        {/* ...and on the canvases you are NOT looking at. Muted, not peach: it
            is a pointer to the picker, not a second alarm. */}
        {elsewhereOpen > 0 && (
          <span
            className="shrink-0 text-[11px] rounded-full px-2 py-0.5 border"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}
            title={`${elsewhereOpen} more review${elsewhereOpen === 1 ? '' : 's'} open on other canvases of this session — the subject picker lists each canvas with its count`}
            data-testid="canvas-pane-open-reviews-elsewhere"
          >
            +{elsewhereOpen} elsewhere
          </span>
        )}
        <button
          onClick={onOpenLibrary}
          className="shrink-0 text-[11.5px] rounded px-1.5 py-0.5 bg-[var(--surface-panel)] text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:text-[var(--text-primary)] transition-colors focus-ring"
          title="Every canvas in this project — open one here, or delete it"
          data-testid="canvas-library-open"
        >
          Library
        </button>
        <div className="flex-1" />
        {/* Tools — Inspect / Sketch / Region (item C): app-family chips that
            decide who owns the pointer. The X-ray setting rides the Inspect
            chip, since it only governs what Inspect does; Sketch and Region
            visibly pause both. */}
        <div className="shrink-0 flex items-center gap-1.5" role="group" aria-label="Canvas tools" data-testid="canvas-tool-chips">
          {/* Inspect + X-Ray as ONE capsule (#469, canvas-picked option A):
              a single bordered control, so the modes read as Inspect's own
              setting — and the feature is NAMED on the control (owner note:
              "we should be calling it X-Ray"). Locked to Stealth on a plan
              (owner call, 2026-08-23) — the boxes-on-page x-ray adds nothing
              over a document of steps, and Off would break note anchoring —
              so the segments are shown, not hidden, but inert with a lock. */}
          <div
            // No overflow-hidden: .focus-ring is an outward box-shadow and
            // clipping it left keyboard focus invisible (review HIGH). The end
            // children carry their own inner radii instead.
            className="flex items-stretch h-[26px] rounded-md border transition-colors"
            style={{ borderColor: inspectActive ? 'color-mix(in srgb, var(--brand) 52%, transparent)' : 'var(--border-subtle)' }}
            data-testid="canvas-inspect-capsule"
          >
            <button
              onClick={() => {
                setMarqueeArmed(sessionId, false)
                setInteractionMode(sessionId, 'browse')
              }}
              aria-pressed={inspectActive}
              className={`flex items-center gap-1.5 px-2.5 rounded-l-[5px] text-[12px] leading-none transition-colors focus-ring ${
                inspectActive ? 'font-semibold text-[var(--brand)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              style={{ background: inspectActive ? 'color-mix(in srgb, var(--brand) 15%, transparent)' : 'color-mix(in srgb, var(--surface-panel) 60%, transparent)' }}
              title="Inspect — the content is live; hover identifies elements, click selects"
              data-testid="canvas-tool-inspect"
            >
              <ToolIcon kind="inspect" />
              Inspect
            </button>
            <span
              aria-hidden
              className="w-px self-stretch"
              style={{ background: inspectActive ? 'color-mix(in srgb, var(--brand) 35%, transparent)' : 'var(--border-subtle)' }}
            />
            <div
              className={`flex items-center rounded-r-[5px] text-[11px] ${inspectPaused ? 'opacity-40' : ''}`}
              style={{ background: inspectActive ? 'color-mix(in srgb, var(--brand) 6%, transparent)' : 'color-mix(in srgb, var(--surface-panel) 60%, transparent)' }}
              role="group"
              aria-label="X-Ray mode"
              data-testid="canvas-xray-mode"
              title={planLocked ? 'X-Ray is locked to Stealth on a plan — a document of steps needs no boxes on the page, and Off would break note anchoring.' : undefined}
            >
              <span
                className="pl-2 pr-1 text-[9px] font-bold tracking-[0.08em] leading-none"
                style={{ color: 'var(--text-secondary)' }}
                aria-hidden
              >
                X-RAY
              </span>
              {CANVAS_XRAY_MODE_OPTIONS.map((option) => {
                const selected = xrayMode === option.value
                return (
                  <button
                    key={option.value}
                    onClick={() => { if (!planLocked) setXrayMode(option.value) }}
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
          <button
            onClick={() => {
              setMarqueeArmed(sessionId, false)
              setInteractionMode(sessionId, 'draw')
            }}
            aria-pressed={sketchActive}
            disabled={viewingCompleted}
            className={chipClass(sketchActive, false)}
            style={chipStyle(sketchActive)}
            title={viewingCompleted ? 'This canvas is signed off — Reopen it to annotate again' : 'Sketch — the glass takes the pointer; draw over the content, then attach the strokes to a note'}
            data-testid="canvas-tool-sketch"
          >
            <ToolIcon kind="sketch" />
            Sketch
          </button>
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
        </div>
        {/* Subject-level sign-off (#476): with the leave actions, away from the
            per-round controls in the panel. Shows the Completed chip + Reopen
            when the user is viewing a canvas already signed off. */}
        <CanvasCompleteButton sessionId={sessionId} canvasId={canvasId} title={canvasTitle} />
        <button
          onClick={() => togglePane(sessionId)}
          disabled={returning}
          aria-label="Close Agent Canvas"
          title={returning ? 'Returning to the terminal…' : 'Close Agent Canvas'}
          className="shrink-0 p-[5px] rounded leading-none text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-panel)] transition-colors focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
            <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
          </svg>
        </button>
      </div>

      {/* Mode strip — always says whose surface the pointer is on and what to
          do with it (owner feedback 2026-08-13: nothing said what mode the
          canvas was in). */}
      <div className="flex items-center gap-2 px-3 py-1 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] text-[11px] shrink-0">
        <span className={`font-semibold uppercase tracking-wide shrink-0 ${modeStrip.color}`}>{modeStrip.label}</span>
        <span className="text-[var(--text-secondary)] truncate">{modeStrip.hint}</span>
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
            style={{ pointerEvents: mode === 'draw' && !marqueeArmed ? 'auto' : 'none' }}
            data-canvas-layer="glass"
          >
            <Excalidraw
              excalidrawAPI={(api) => {
                glassApiRef.current = api
                repinGlass()
              }}
              theme="light"
              initialData={glassInitialData}
              // Version-stamp every element the first time it appears (C1):
              // whatever version is on screen owns it from then on.
              onChange={(els) => {
                for (const el of els) {
                  if (!el.isDeleted && !sketchVersionRef.current.has(el.id)) {
                    sketchVersionRef.current.set(el.id, versionIdRef.current)
                  }
                }
              }}
              onScrollChange={handleGlassScrolled}
              // Outside draw mode the glass is inert: view mode drops the tool
              // island so nothing floats over the page being reviewed. Zen
              // mode + the glass-scoped CSS keep draw mode down to the tools.
              viewModeEnabled={mode !== 'draw' || marqueeArmed}
              zenModeEnabled
              UIOptions={glassUIOptions}
            />
          </div>
          {/* Transient highlight overlay — plain divs, never Excalidraw elements
              (D7): browse hover, the locked selection, panel-driven highlights.
              Clipped to the stage so a box for offscreen page coords cannot
              paint over the surrounding chrome. */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden" data-canvas-layer="overlay">
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
          </div>
        </div>

        {/* Notes panel — docked (spec D3) — with the stealth x-ray readout
            below it when that mode is on (#367). The readout is a SIBLING, not
            a section of the panel: it belongs to the stage's pointer, not to
            the review, and keeping it out means the panel's own file is
            untouched by this change. The panel keeps its own width and left
            border; this column just stacks the two. */}
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
                version={version}
                getGlassApi={() => glassApiRef.current}
                getAllSketchElements={() => [
                  ...(glassApiRef.current?.getSceneElements() ?? []),
                  ...foreignSketchStashRef.current.values(),
                ]}
                onReturnToTerminal={() => togglePane(sessionId)}
                isActive={isActive}
                onHide={() => setPanelHidden(true)}
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
