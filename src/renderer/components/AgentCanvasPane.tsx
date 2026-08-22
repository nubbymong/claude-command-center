import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import CanvasEmptyState from './CanvasEmptyState'
import { CanvasLibrary } from './CanvasLibrary'
import CanvasSubjectPicker from './CanvasSubjectPicker'
import CanvasFiledStrip from './CanvasFiledStrip'
import CanvasNotesPanel from './CanvasNotesPanel'
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
} from '../../shared/canvas'
import { contentPageRectToStage, stageToContentPagePoint, glassNeedsRepin, glassScrollForContent } from '../utils/canvas-coords'
import { safeAnchorResolutions, safeInspectResult } from '../utils/canvas-geometry-guard'
import { registerCanvasFrame } from '../canvas/canvas-snapshot-host'
import { askCanvasFrame } from '../canvas/canvas-frame-rpc'
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
import { relativeTime } from '../utils/relativeTime'

/** JetBrains Mono ships with the app (@font-face in styles.css) but Tailwind's
 *  `font-mono` resolves to the generic stack, so mono is named explicitly. */
const MONO = "'JetBrains Mono', ui-monospace, monospace"

/** How long a frame may sit silent before the pane stops claiming it is
 *  loading. A 404, a CSP-blocked bridge script and a crashed page otherwise
 *  look exactly like a slow one — forever. */
const FRAME_READY_TIMEOUT_MS = 8000

/** How long the frame gets to acknowledge an x-ray mode change (#367). Short:
 *  nothing waits on the answer — the host's own gate is what enforces the mode,
 *  and this request only asks the page to stop doing work it need not do. */
const HOVER_REPORTING_TIMEOUT_MS = 3000

/** Wall-clock of a render, or null when the stored stamp will not parse. */
function versionClock(iso: string): string | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** What KIND of thing this version is, in the user's words. A UAT render is
 *  the app under test, so its build label (when the agent supplied one) is the
 *  most useful thing we can say about it. */
function versionKind(version: CanvasVersion): string {
  if (version.source.mode === 'uat') return version.source.buildLabel?.trim() || 'Live site'
  // `version.mode`, not `source.mode`: a plan is STORED as a design document and
  // its source says so, which is exactly what keeps plan mode off every serving
  // path. What kind of thing it is lives on the version. See CanvasRenderSource.
  return version.mode === 'plan' ? 'Plan' : 'Mockup'
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

/** Full stamp for the label's tooltip — the human line is deliberately short. */
function versionTooltip(version: CanvasVersion): string {
  const ms = Date.parse(version.createdAt)
  const when = Number.isFinite(ms) ? new Date(ms).toLocaleString() : version.createdAt
  return `${version.id} — ${versionKind(version)}, rendered ${when}`
}

/** One picker row: `v3 · 14:07 · 2m ago`. Raw ids told the user nothing about
 *  which render they were switching to. */
function versionOptionLabel(version: CanvasVersion, now: number): string {
  const ms = Date.parse(version.createdAt)
  if (!Number.isFinite(ms)) return `${version.id} · ${versionKind(version)}`
  return `${version.id} · ${versionClock(version.createdAt)} · ${relativeTime(ms, now)}`
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

  const activeVersion = useMemo(
    () => canvasState?.versions.find((v) => v.id === canvasState.activeVersionId) ?? null,
    [canvasState],
  )

  // The library lives HERE, above the empty-state branch, not inside the
  // surface. Deleting the canvas you are looking at empties the pane, which
  // used to unmount the very overlay the delete button was in — a destructive
  // control that destroys its own host, mid-action.
  if (!canvasState?.canvasId || !activeVersion) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <CanvasFiledStrip sessionId={sessionId} />
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
  const mode = useCanvasStore((s) => s.bySessionId[sessionId]?.interactionMode ?? 'browse')
  const setInteractionMode = useCanvasStore((s) => s.setInteractionMode)
  const setActiveVersion = useCanvasStore((s) => s.setActiveVersion)

  // X-ray hover mode (#367) — PER USER, so it comes from settings rather than
  // from the canvas store where the per-canvas interaction mode lives. Every
  // read goes through the resolver: an absent or hand-edited value is 'on'.
  const xrayMode = resolveCanvasXrayMode(useSettingsStore((s) => s.settings.canvasXrayMode))

  const focus = useCanvasReviewStore((s) => s.bySessionId[sessionId]?.focus ?? null)
  const marqueeArmed = useCanvasReviewStore((s) => s.bySessionId[sessionId]?.marqueeArmed ?? false)
  const panelHighlight = useCanvasReviewStore((s) => s.bySessionId[sessionId]?.panelHighlight ?? null)
  const reviewSession = useCanvasReviewStore((s) => s.bySessionId[sessionId])
  const setMarqueeArmed = useCanvasReviewStore((s) => s.setMarqueeArmed)

  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const glassApiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const repinPendingRef = useRef(false)
  const viewportRef = useRef<CanvasViewportInfo | null>(null)
  const modeRef = useRef(mode)
  const xrayModeRef = useRef(xrayMode)
  const versionIdRef = useRef(version.id)
  /** What the CURRENT frame was last told about hover reporting. The bridge
   *  starts reporting, so a freshly loaded frame believes `true` and only a
   *  mode that disagrees costs a round-trip. Reset when the frame reloads —
   *  the new document has a new bridge with the default back on. */
  const frameHoverReportingRef = useRef(true)
  /** One outstanding inspect per frame — a page-driven click cannot open a
   *  second one while the first is unanswered. */
  const inspectPendingRef = useRef(false)

  const [bridgeReady, setBridgeReady] = useState(false)
  const bridgeReadyRef = useRef(false)
  /** The page flooded the bridge and its channel was dropped: live inspection
   *  is over for this load, and the user is told rather than left with a pane
   *  that has quietly stopped responding. */
  const [bridgeFlooded, setBridgeFlooded] = useState(false)
  const [viewport, setViewport] = useState<CanvasViewportInfo | null>(null)
  const [hover, setHover] = useState<HoverState | null>(null)
  const [marqueeDrag, setMarqueeDrag] = useState<MarqueeDrag | null>(null)
  // Load health. `frameLoaded` is the browser's own load event (it fires for an
  // error document too, so it is not by itself a health signal); `loadTimedOut`
  // is what turns "still loading" into "this did not work".
  const [frameLoaded, setFrameLoaded] = useState(false)
  const [loadTimedOut, setLoadTimedOut] = useState(false)
  // Bumping this re-mounts the iframe: the retry affordance for a dead render.
  const [reloadNonce, setReloadNonce] = useState(0)

  const contentUrl = useMemo(
    () => canvasContentUrl(canvasId, version.id, version.source.entry),
    [canvasId, version],
  )

  viewportRef.current = viewport
  modeRef.current = mode
  xrayModeRef.current = xrayMode
  versionIdRef.current = version.id

  // Keep the glass pinned to the content: scene scroll ≡ −content scroll at
  // zoom 1 (canvas-coords.glassScrollForContent). Applied on every viewport
  // event, and re-applied if Excalidraw itself pans/zooms the scene (wheel or
  // space-drag on the glass in draw mode) — the canvas glass has no free
  // camera, the content is the camera.
  const repinGlass = useCallback(() => {
    const api = glassApiRef.current
    const vp = viewportRef.current
    if (!api || !vp || repinPendingRef.current) return
    repinPendingRef.current = true
    requestAnimationFrame(() => {
      repinPendingRef.current = false
      const currentVp = viewportRef.current
      if (!currentVp || !glassApiRef.current) return
      glassApiRef.current.updateScene({ appState: glassScrollForContent(currentVp) } as never)
    })
  }, [])

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
   * Bring the frame's belief about hover reporting in line with the x-ray mode
   * (#367).
   *
   * The host already ignores what it does not want, so this is not the gate —
   * it is what makes Off free for the PAGE: a bridge told to stop does no hit
   * test, no measurement and no postMessage per mousemove. Sent only when the
   * frame's belief disagrees, so the common case (x-ray on, the bridge's own
   * default) costs no round-trip at all.
   */
  const syncHoverReporting = useCallback(() => {
    const enabled = xrayHoverIsLive(xrayModeRef.current)
    if (frameHoverReportingRef.current === enabled) return
    const target = iframeRef.current?.contentWindow
    if (!target) return
    frameHoverReportingRef.current = enabled
    void askCanvasFrame(target, canvasId, { type: 'hoverReporting', enabled }, HOVER_REPORTING_TIMEOUT_MS).catch(() => {
      /* An old bridge, a frame mid-navigation, a page that answers nothing: the
         mode still holds, because the host-side gate is what enforces it. Left
         marked as sent — a retry loop over an unanswerable frame would be the
         page choosing the host's call rate. */
    })
  }, [canvasId])

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
        onFlood: () => setBridgeFlooded(true),
      },
    })
  }, [repinGlass, canvasId, inspectAndLock, handleReportedKey, syncHoverReporting])

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
    if (!bridgeReady || openNotes.length === 0) return
    const target = iframeRef.current?.contentWindow
    if (!target) return
    const store = useCanvasReviewStore.getState()
    const current = store.bySessionId[sessionId]?.resolution
    const done = current?.versionId === version.id ? current.byAnnotation : {}
    const pending = openNotes.filter(
      (n) => n.versionId !== version.id && n.focus && n.focus.targets.length > 0 && !(n.id in done),
    )
    if (pending.length === 0) return

    let cancelled = false
    void (async () => {
      const flat: AnchorRef[] = []
      const spans: Array<{ id: string; start: number; count: number }> = []
      for (const note of pending) {
        const targets = note.focus!.targets
        if (flat.length + targets.length > MAX_RESOLVE_ANCHORS) break
        spans.push({ id: note.id, start: flat.length, count: targets.length })
        flat.push(...targets)
      }
      if (flat.length === 0) return
      try {
        const raw = await askCanvasFrame(target, canvasId, { type: 'resolveAnchors', anchors: flat }, 10_000)
        if (cancelled) return
        // Checked against the anchors WE sent, not merely counted against them:
        // the page writes this reply and it decides what the checklist tells
        // the reviewer about their own open notes.
        const results = safeAnchorResolutions(raw, flat)
        const merged = { ...done }
        for (const span of spans) {
          const slice = results.slice(span.start, span.start + span.count)
          merged[span.id] = slice.find((r) => r.found) ?? null
        }
        useCanvasReviewStore.getState().setResolution(sessionId, { versionId: version.id, byAnnotation: merged })
      } catch {
        /* frame gone or slow — the checklist keeps its ghosts */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bridgeReady, version.id, openNotesKey, sessionId, canvasId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleGlassScrolled = useCallback(() => {
    const vp = viewportRef.current
    const api = glassApiRef.current
    if (!vp || !api) return
    const appState = api.getAppState()
    if (glassNeedsRepin(appState, vp)) repinGlass()
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
      const p0 = stageToContentPagePoint({ x: left, y: top }, vp)
      const p1 = stageToContentPagePoint({ x: left + width, y: top + height }, vp)
      useCanvasReviewStore
        .getState()
        .setRegionFocus(sessionId, { x: p0.x, y: p0.y, width: p1.x - p0.x, height: p1.y - p0.y }, versionIdRef.current)
    } else {
      useCanvasReviewStore.getState().setMarqueeArmed(sessionId, false)
    }
  }, [sessionId])

  const hoverStageRect = useMemo(() => {
    if (!hover || !viewport) return null
    return contentPageRectToStage(hover.hit.box, viewport)
  }, [hover, viewport])

  /** The hover box AS PAINTED on the stage. Null in every posture that must
   *  leave the content alone — the glass owning the pointer, a marquee being
   *  dragged, and now x-ray Stealth and Off (#367), where the hover is either
   *  read out beside the stage or not resolved at all. */
  const stageHoverRect = mode === 'browse' && !marqueeArmed && xrayDrawsOnPage(xrayMode) ? hoverStageRect : null

  const focusStageRect = useMemo(() => {
    if (!focus || !viewport) return null
    return contentPageRectToStage(focus.bboxPage, viewport)
  }, [focus, viewport])

  /** An element lock's label came out of an inspect reply — the page's own
   *  account of what the user clicked. A region's came from the marquee. */
  const focusIsPageReported = (focus?.targets.length ?? 0) > 0

  const highlightStageRect = useMemo(() => {
    if (!panelHighlight || !viewport) return null
    return contentPageRectToStage(panelHighlight.rect, viewport)
  }, [panelHighlight, viewport])

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

  // What Browse actually does depends on the x-ray mode now, and the strip is
  // the only thing that says so — a user who switched x-ray off and still read
  // "hover to inspect, click to select" would reasonably think it had failed.
  const browseHint =
    xrayMode === 'off'
      ? 'the page is live and plain — x-ray is off, so hovering and clicking do nothing here'
      : xrayMode === 'stealth'
        ? 'the page is live — hovering names the element in the panel and draws nothing · click to select · ↑ parent · Esc clear'
        : 'the page is live — hover to inspect, click to select · ↑ parent · Esc clear'

  const modeStrip = marqueeArmed
    ? { color: 'text-peach', label: 'Region', hint: 'drag a rectangle over the area — Esc cancels' }
    : mode === 'draw'
      ? { color: 'text-mauve', label: 'Draw', hint: 'sketch on the glass; select strokes, then attach them to a note' }
      : { color: 'text-blue', label: 'Browse', hint: browseHint }

  /** Per USER, so it is written straight to settings rather than to any canvas
   *  state (#367). Fire-and-forget: the store applies the change synchronously
   *  and the persist is the config saver's problem, exactly as every other
   *  settings toggle in the app does it. */
  const setXrayMode = (next: CanvasXrayMode) => {
    void useSettingsStore.getState().updateSettings({ canvasXrayMode: next })
  }

  const segmentClass = (active: boolean) =>
    `px-2.5 py-[5px] rounded text-[11.5px] font-medium leading-none transition-colors focus-ring disabled:opacity-40 ${
      active
        ? 'bg-[var(--surface-overlay)] text-[var(--text-primary)]'
        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
    }`

  const versionClockLabel = versionClock(version.createdAt)

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--surface-stage)]">
      {/* Pane chrome — 38px, one type size, and the mode switch given real
          weight because it decides where the user's clicks land. */}
      <div className="h-[38px] shrink-0 flex items-center gap-2.5 px-3 bg-[var(--surface-chrome)] border-b border-[var(--border-subtle)]">
        <span className="w-[5px] h-[5px] shrink-0 rounded-full bg-[var(--brand)]" aria-hidden="true" />
        {/* WHAT this canvas is of, leading, and the way to the others. "Agent
            Canvas" was a label for a pane that could only ever show one thing;
            a session authors many, so the pane has to say which one you are
            looking at and let you reach the rest. */}
        <CanvasSubjectPicker
          sessionId={sessionId}
          canvasId={canvasId}
          title={canvasTitle}
          onOpenLibrary={onOpenLibrary}
        />
        {/* The version identity, in words a person can act on. It lives here
            because a version EXISTS — the empty state's own chrome carries no
            version label and no picker, because there is nothing to version. */}
        <span
          className="shrink-0 text-[10px] rounded px-1.5 py-0.5 border text-[var(--text-secondary)]"
          style={{ borderColor: `color-mix(in srgb, ${canvasModeBadge(version).tone} 55%, transparent)` }}
          title={canvasModeBadge(version).title}
          data-testid="canvas-mode-badge"
          data-canvas-mode={version.mode}
        >
          {canvasModeBadge(version).label}
        </span>
        <span
          className="min-w-0 truncate text-[11.5px] text-[var(--text-primary)]"
          title={versionTooltip(version)}
        >
          <span className="text-[var(--text-secondary)]" style={{ fontFamily: MONO }}>
            {version.id}
          </span>
          {versionClockLabel ? ` · ${versionClockLabel}` : ''} · {versionKind(version)}
        </span>
        {versions.length > 1 && (
          <select
            value={version.id}
            onChange={(e) => void setActiveVersion(sessionId, e.target.value)}
            className="shrink-0 text-[11.5px] rounded px-1.5 py-0.5 bg-[var(--surface-panel)] text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:text-[var(--text-primary)] transition-colors focus-ring"
            aria-label="Switch version"
            title="Switch version"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {versionOptionLabel(v, Date.now())}
              </option>
            ))}
          </select>
        )}
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
        {/* THE control of this surface: who owns the pointer (spec §6). */}
        <div
          className="shrink-0 flex items-center gap-[2px] p-[2px] rounded-md bg-[var(--surface-panel)] border border-[var(--border-subtle)]"
          role="group"
          aria-label="Canvas interaction mode"
        >
          <button
            onClick={() => {
              setMarqueeArmed(sessionId, false)
              setInteractionMode(sessionId, 'browse')
            }}
            aria-pressed={mode === 'browse' && !marqueeArmed}
            className={segmentClass(mode === 'browse' && !marqueeArmed)}
            title="Browse mode — the content is interactive; hover to inspect, click to select"
          >
            Browse
          </button>
          <button
            onClick={() => {
              setMarqueeArmed(sessionId, false)
              setInteractionMode(sessionId, 'draw')
            }}
            aria-pressed={mode === 'draw' && !marqueeArmed}
            className={segmentClass(mode === 'draw' && !marqueeArmed)}
            title="Draw mode — the glass is interactive; sketch over the content"
          >
            Draw
          </button>
          <button
            onClick={() => setMarqueeArmed(sessionId, !marqueeArmed)}
            aria-pressed={marqueeArmed}
            disabled={!viewport}
            className={segmentClass(marqueeArmed)}
            title="Region — drag a rectangle to select an area for a note (Esc cancels)"
          >
            Region
          </button>
        </div>
        {/* X-ray (#367) — whether pointing at the page marks it up, names it
            quietly beside the stage, or does nothing at all. Beside the mode
            switch because the two together are the whole answer to "what
            happens when I move the mouse over this". */}
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--text-secondary)]" aria-hidden="true">
          X-ray
        </span>
        <div
          className="shrink-0 flex items-center gap-[2px] p-[2px] rounded-md bg-[var(--surface-panel)] border border-[var(--border-subtle)]"
          role="group"
          aria-label="Canvas x-ray hover"
          data-testid="canvas-xray-mode"
        >
          {CANVAS_XRAY_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setXrayMode(option.value)}
              aria-pressed={xrayMode === option.value}
              className={segmentClass(xrayMode === option.value)}
              title={option.title}
              data-testid={`canvas-xray-${option.value}`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => togglePane(sessionId)}
          aria-label="Close Agent Canvas"
          title="Close Agent Canvas"
          className="shrink-0 p-[5px] rounded leading-none text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-panel)] transition-colors focus-ring"
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
        {/* Stage: content iframe below, glass above, transient overlay on top.
            overflow-hidden so highlight boxes for offscreen page coords can
            never bleed over the chrome around the stage. */}
        <div className="flex-1 min-w-0 relative overflow-hidden">
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
            className="absolute inset-0 w-full h-full border-0 bg-[var(--surface-stage)]"
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

        {/* Notes panel — docked (spec D3) — with the stealth x-ray readout
            below it when that mode is on (#367). The readout is a SIBLING, not
            a section of the panel: it belongs to the stage's pointer, not to
            the review, and keeping it out means the panel's own file is
            untouched by this change. The panel keeps its own width and left
            border; this column just stacks the two. */}
        <div className="shrink-0 flex flex-col min-h-0">
          <div className="flex-1 min-h-0 flex">
            <CanvasNotesPanel
              sessionId={sessionId}
              version={version}
              getGlassApi={() => glassApiRef.current}
              onReturnToTerminal={() => togglePane(sessionId)}
              isActive={isActive}
            />
          </div>
          {xrayReadsOutInPanel(xrayMode) && (
            <CanvasXrayReadout hit={mode === 'browse' && !marqueeArmed ? (hover?.hit ?? null) : null} label={hoverLabel} />
          )}
        </div>
      </div>
    </div>
  )
}
