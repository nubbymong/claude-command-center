import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import CanvasEmptyState from './CanvasEmptyState'
import CanvasNotesPanel from './CanvasNotesPanel'
import { useCanvasStore } from '../stores/canvasStore'
import { useExcalidrawStore } from '../stores/excalidrawStore'
import {
  MAX_RESOLVE_ANCHORS,
  CANVAS_BRIDGE_NS,
  CanvasBridgeEvent,
  CanvasHitInfo,
  CanvasViewportInfo,
  CanvasVersion,
  canvasContentUrl,
  canvasOrigin,
  type AnchorRef,
} from '../../shared/canvas'
import { contentPageRectToStage, stageToContentPagePoint, glassNeedsRepin, glassScrollForContent } from '../utils/canvas-coords'
import { finite, safeAnchorResolutions, safeHit, safeInspectResult, safeViewport } from '../utils/canvas-geometry-guard'
import { registerCanvasFrame } from '../canvas/canvas-snapshot-host'
import { askCanvasFrame } from '../canvas/canvas-frame-rpc'
import { openSubmittedNotesOf, useCanvasReviewStore } from '../stores/canvasReviewStore'

interface Props {
  sessionId: string
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
export default function AgentCanvasPane({ sessionId }: Props) {
  const canvasState = useCanvasStore((s) => s.bySessionId[sessionId])
  const refresh = useCanvasStore((s) => s.refresh)
  const clearUnseenRender = useCanvasStore((s) => s.clearUnseenRender)
  const togglePane = useExcalidrawStore((s) => s.togglePane)

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

  // Empty state: the Agent Canvas landing — what this surface is and how to
  // start the loop — with the classic sketchpad one click away (spec D2:
  // old Draw behaviour is preserved; it is just no longer the greeting).
  if (!canvasState?.canvasId || !activeVersion) {
    return <CanvasEmptyState sessionId={sessionId} onClose={() => togglePane(sessionId)} />
  }
  return (
    <CanvasSurface
      sessionId={sessionId}
      canvasId={canvasState.canvasId}
      version={activeVersion}
      versions={canvasState.versions}
    />
  )
}

interface SurfaceProps {
  sessionId: string
  canvasId: string
  version: CanvasVersion
  versions: CanvasVersion[]
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

function CanvasSurface({ sessionId, canvasId, version, versions }: SurfaceProps) {
  const togglePane = useExcalidrawStore((s) => s.togglePane)
  const mode = useCanvasStore((s) => s.bySessionId[sessionId]?.interactionMode ?? 'browse')
  const setInteractionMode = useCanvasStore((s) => s.setInteractionMode)
  const setActiveVersion = useCanvasStore((s) => s.setActiveVersion)

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
  const versionIdRef = useRef(version.id)

  const [bridgeReady, setBridgeReady] = useState(false)
  const bridgeReadyRef = useRef(false)
  const [viewport, setViewport] = useState<CanvasViewportInfo | null>(null)
  const [hover, setHover] = useState<HoverState | null>(null)
  const [marqueeDrag, setMarqueeDrag] = useState<MarqueeDrag | null>(null)

  const contentUrl = useMemo(
    () => canvasContentUrl(canvasId, version.id, version.source.entry),
    [canvasId, version],
  )

  viewportRef.current = viewport
  modeRef.current = mode
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
   *  page's own click behaviour already happened — the bridge only observed. */
  const inspectAndLock = useCallback(
    async (pageX: number, pageY: number) => {
      const target = iframeRef.current?.contentWindow
      if (!target) return
      try {
        const raw = await askCanvasFrame(target, canvasId, { type: 'inspect', x: pageX, y: pageY }, 5000)
        const { chain } = safeInspectResult(raw)
        if (chain.length > 0) {
          useCanvasReviewStore.getState().lockFocus(sessionId, chain, versionIdRef.current)
        }
      } catch {
        /* frame busy or navigating — the hover chip still works */
      }
    },
    [canvasId, sessionId],
  )

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

  // Bridge listener — accepts messages only from OUR iframe's window, and only
  // the canvas namespace. The bridge is read-only: everything arriving here is
  // a report about the content, never an instruction (spec D8, §5.4).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow
      if (!frameWindow || event.source !== frameWindow) return
      // Fail closed: a non-string origin (shouldn't happen) is rejected too.
      // Exact, not a prefix: another canvas's document would satisfy a prefix
      // test. Matches the snapshot path's check.
      if (event.origin !== canvasOrigin(canvasId)) return
      const msg = event.data as CanvasBridgeEvent | null
      if (!msg || msg.ns !== CANVAS_BRIDGE_NS || !('type' in msg)) return
      if (msg.type === 'ready') {
        bridgeReadyRef.current = true
        setBridgeReady(true)
      } else if (msg.type === 'viewport') {
        const vp = safeViewport(msg.viewport)
        setViewport(vp)
        setHover(null)
        viewportRef.current = vp
        repinGlass()
      } else if (msg.type === 'pointer') {
        setHover(msg.hit ? { hit: safeHit(msg.hit) } : null)
      } else if (msg.type === 'contentClick') {
        // Click-to-lock (spec §6 step 3) — browse mode only; in draw mode the
        // glass owns the pointer and a frame click cannot happen anyway.
        if (modeRef.current === 'browse') {
          void inspectAndLock(finite((msg as { pageX?: unknown }).pageX, 0), finite((msg as { pageY?: unknown }).pageY, 0))
        }
      } else if (msg.type === 'contentKey') {
        const key = (msg as { key?: unknown }).key
        if (key === 'Escape' || key === 'ArrowUp') handleReportedKey(key)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [repinGlass, canvasId, inspectAndLock, handleReportedKey])

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

  // New version → the frame reloads; bridge state starts over.
  useEffect(() => {
    bridgeReadyRef.current = false
    setBridgeReady(false)
    setViewport(null)
    setHover(null)
    setMarqueeDrag(null)
  }, [contentUrl])

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
        const results = safeAnchorResolutions(raw, flat.length)
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

  const focusStageRect = useMemo(() => {
    if (!focus || !viewport) return null
    return contentPageRectToStage(focus.bboxPage, viewport)
  }, [focus, viewport])

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

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--surface-stage)]">
      {/* Pane chrome. */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-surface0 bg-crust shrink-0">
        <span className="text-[11px] font-medium text-subtext1">Agent Canvas</span>
        <span
          className="px-1.5 py-0.5 text-[10px] rounded bg-surface0 text-overlay1 border border-surface1/60"
          title={`Rendered ${new Date(version.createdAt).toLocaleString()}`}
        >
          {version.id} · {version.mode}
        </span>
        {versions.length > 1 && (
          <select
            value={version.id}
            onChange={(e) => void setActiveVersion(sessionId, e.target.value)}
            className="text-[10px] bg-surface0 text-overlay1 border border-surface1/60 rounded px-1 py-0.5"
            title="Switch version"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id}
              </option>
            ))}
          </select>
        )}
        <div className="flex-1" />
        {/* THE control of this surface: who owns the pointer (spec §6). */}
        <div className="flex rounded border border-surface1 overflow-hidden" role="group" aria-label="Canvas interaction mode">
          <button
            onClick={() => setInteractionMode(sessionId, 'browse')}
            aria-pressed={mode === 'browse' && !marqueeArmed}
            className={`px-2.5 py-0.5 text-xs transition-colors ${
              mode === 'browse' && !marqueeArmed ? 'bg-surface1 text-text' : 'bg-surface0/60 text-overlay1 hover:text-text'
            }`}
            title="Browse mode — the content is interactive; hover to inspect, click to select"
          >
            Browse
          </button>
          <button
            onClick={() => setInteractionMode(sessionId, 'draw')}
            aria-pressed={mode === 'draw' && !marqueeArmed}
            className={`px-2.5 py-0.5 text-xs transition-colors border-l border-surface1 ${
              mode === 'draw' && !marqueeArmed ? 'bg-surface1 text-text' : 'bg-surface0/60 text-overlay1 hover:text-text'
            }`}
            title="Draw mode — the glass is interactive; sketch over the content"
          >
            Draw
          </button>
          <button
            onClick={() => setMarqueeArmed(sessionId, !marqueeArmed)}
            aria-pressed={marqueeArmed}
            disabled={!viewport}
            className={`px-2.5 py-0.5 text-xs transition-colors border-l border-surface1 disabled:opacity-40 ${
              marqueeArmed ? 'bg-surface1 text-peach' : 'bg-surface0/60 text-overlay1 hover:text-text'
            }`}
            title="Region — drag a rectangle to select an area for a note (Esc cancels)"
          >
            Region
          </button>
        </div>
        <button
          onClick={() => togglePane(sessionId)}
          className="px-2.5 py-0.5 text-xs rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-surface1 hover:text-text transition-colors"
          title="Close Agent Canvas"
        >
          Close
        </button>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Stage: content iframe below, glass above, transient overlay on top. */}
        <div className="flex-1 min-w-0 relative">
          <iframe
            // Keyed on the URL so a version switch mounts a NEW element. Reusing
            // one iframe leaves the OLD document in contentWindow until the new
            // src commits, and versions share a canvas origin — so a snapshot
            // taken in that window would be answered by the previous version and
            // then stamped with the new version's id.
            key={contentUrl}
            ref={iframeRef}
            src={contentUrl}
            title="Agent Canvas content"
            // Same-origin is safe here: the frame's ccc-ux://<canvasId> origin is
            // never the app's own origin, so the content cannot reach the host
            // document; scripts+forms are what real pages need (spec §3.2, D14).
            sandbox="allow-scripts allow-same-origin allow-forms"
            referrerPolicy="no-referrer"
            className="absolute inset-0 w-full h-full border-0 bg-white"
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
            />
          </div>
          {/* Transient highlight overlay — plain divs, never Excalidraw elements
              (D7): browse hover, the locked selection, panel-driven highlights. */}
          <div className="absolute inset-0 pointer-events-none" data-canvas-layer="overlay">
            {mode === 'browse' && !marqueeArmed && hoverStageRect && (
              <div
                className="absolute border-2 border-blue rounded-sm"
                style={{
                  left: hoverStageRect.x,
                  top: hoverStageRect.y,
                  width: hoverStageRect.width,
                  height: hoverStageRect.height,
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
                >
                  {focus?.label} · ↑ parent · Esc
                </div>
              </>
            )}
            {highlightStageRect && (
              <div
                className={`absolute rounded-sm ${panelHighlight?.kind === 'anchored' ? 'border-2 border-green' : 'border-2 border-overlay1'}`}
                style={{
                  left: highlightStageRect.x,
                  top: highlightStageRect.y,
                  width: highlightStageRect.width,
                  height: highlightStageRect.height,
                  borderStyle: panelHighlight?.kind === 'ghost' ? 'dashed' : 'solid',
                  background:
                    panelHighlight?.kind === 'anchored'
                      ? 'color-mix(in srgb, var(--color-green) 10%, transparent)'
                      : 'transparent',
                }}
              />
            )}
            {mode === 'browse' && !marqueeArmed && hoverStageRect && (
              <div
                className="absolute px-1.5 py-0.5 text-[10px] rounded bg-crust text-text border border-surface1 whitespace-nowrap max-w-[60%] overflow-hidden text-ellipsis"
                style={{
                  left: Math.max(0, hoverStageRect.x),
                  top: Math.max(0, hoverStageRect.y - 22),
                }}
              >
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
          {!bridgeReady && (
            <div className="absolute inset-x-0 bottom-2 flex justify-center pointer-events-none">
              <span className="px-2 py-0.5 text-[10px] rounded bg-crust/90 text-overlay1 border border-surface1/60">
                Loading content…
              </span>
            </div>
          )}
        </div>

        {/* Notes panel — docked (spec D3). */}
        <CanvasNotesPanel
          sessionId={sessionId}
          version={version}
          getGlassApi={() => glassApiRef.current}
          onReturnToTerminal={() => togglePane(sessionId)}
        />
      </div>
    </div>
  )
}
