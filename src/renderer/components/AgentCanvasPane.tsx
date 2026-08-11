import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import ExcalidrawPane from './ExcalidrawPane'
import { useCanvasStore } from '../stores/canvasStore'
import { useExcalidrawStore } from '../stores/excalidrawStore'
import {
  CANVAS_BRIDGE_NS,
  CanvasBridgeEvent,
  CanvasHitInfo,
  CanvasViewportInfo,
  CanvasVersion,
  canvasContentUrl,
  canvasOrigin,
} from '../../shared/canvas'
import { contentPageRectToStage, glassNeedsRepin, glassScrollForContent } from '../utils/canvas-coords'
import { safeHit, safeViewport } from '../utils/canvas-geometry-guard'
import { registerCanvasFrame } from '../canvas/canvas-snapshot-host'

interface Props {
  sessionId: string
}

/**
 * Agent Canvas (spec D2/D3): the per-session review surface. With no rendered
 * content it IS the classic Excalidraw scratchpad (nothing the old Draw pane
 * did is lost); once an agent renders a version, the pane becomes the canvas —
 * content iframe below, Excalidraw glass above, transient highlight overlay
 * on top (D7: the glass is a sibling, never injected into content).
 *
 * The draw/browse toggle is THE control of this surface (spec §6): browse
 * gives the pointer to the content (hover reports element names through the
 * bridge); draw gives the pointer to the glass. The glass is pinned 1:1 over
 * the content — scene scroll is bound to the content's scroll — so marks stay
 * on what they annotate while the page scrolls.
 */
export default function AgentCanvasPane({ sessionId }: Props) {
  const canvasState = useCanvasStore((s) => s.bySessionId[sessionId])
  const refresh = useCanvasStore((s) => s.refresh)

  useEffect(() => {
    void refresh(sessionId)
  }, [sessionId, refresh])

  const activeVersion = useMemo(
    () => canvasState?.versions.find((v) => v.id === canvasState.activeVersionId) ?? null,
    [canvasState],
  )

  // Empty state = the classic sketchpad, wholesale (spec D2).
  if (!canvasState?.canvasId || !activeVersion) {
    return <ExcalidrawPane sessionId={sessionId} />
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

function CanvasSurface({ sessionId, canvasId, version, versions }: SurfaceProps) {
  const togglePane = useExcalidrawStore((s) => s.togglePane)
  const mode = useCanvasStore((s) => s.bySessionId[sessionId]?.interactionMode ?? 'browse')
  const setInteractionMode = useCanvasStore((s) => s.setInteractionMode)
  const setActiveVersion = useCanvasStore((s) => s.setActiveVersion)

  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const glassApiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const repinPendingRef = useRef(false)
  const viewportRef = useRef<CanvasViewportInfo | null>(null)

  const [bridgeReady, setBridgeReady] = useState(false)
  const bridgeReadyRef = useRef(false)
  const [viewport, setViewport] = useState<CanvasViewportInfo | null>(null)
  const [hover, setHover] = useState<HoverState | null>(null)

  const contentUrl = useMemo(
    () => canvasContentUrl(canvasId, version.id, version.source.entry),
    [canvasId, version],
  )

  viewportRef.current = viewport

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
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [repinGlass])

  // New version → the frame reloads; bridge state starts over.
  useEffect(() => {
    bridgeReadyRef.current = false
    setBridgeReady(false)
    setViewport(null)
    setHover(null)
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

  const handleGlassScrolled = useCallback(() => {
    const vp = viewportRef.current
    const api = glassApiRef.current
    if (!vp || !api) return
    const appState = api.getAppState()
    if (glassNeedsRepin(appState, vp)) repinGlass()
  }, [repinGlass])

  const hoverStageRect = useMemo(() => {
    if (!hover || !viewport) return null
    return contentPageRectToStage(hover.hit.box, viewport)
  }, [hover, viewport])

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
            aria-pressed={mode === 'browse'}
            className={`px-2.5 py-0.5 text-xs transition-colors ${
              mode === 'browse' ? 'bg-surface1 text-text' : 'bg-surface0/60 text-overlay1 hover:text-text'
            }`}
            title="Browse mode — the content is interactive; hover to inspect elements"
          >
            Browse
          </button>
          <button
            onClick={() => setInteractionMode(sessionId, 'draw')}
            aria-pressed={mode === 'draw'}
            className={`px-2.5 py-0.5 text-xs transition-colors border-l border-surface1 ${
              mode === 'draw' ? 'bg-surface1 text-text' : 'bg-surface0/60 text-overlay1 hover:text-text'
            }`}
            title="Draw mode — the glass is interactive; sketch over the content"
          >
            Draw
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

      {/* Stage: content iframe below, glass above, transient overlay on top. */}
      <div className="flex-1 min-h-0 relative">
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
          style={{ pointerEvents: mode === 'draw' ? 'auto' : 'none' }}
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
            (D7). Browse-mode hover only in P1. */}
        <div className="absolute inset-0 pointer-events-none" data-canvas-layer="overlay">
          {mode === 'browse' && hoverStageRect && (
            <>
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
              <div
                className="absolute px-1.5 py-0.5 text-[10px] rounded bg-crust text-text border border-surface1 whitespace-nowrap max-w-[60%] overflow-hidden text-ellipsis"
                style={{
                  left: Math.max(0, hoverStageRect.x),
                  top: Math.max(0, hoverStageRect.y - 22),
                }}
              >
                {hoverLabel}
              </div>
            </>
          )}
        </div>
        {!bridgeReady && (
          <div className="absolute inset-x-0 bottom-2 flex justify-center pointer-events-none">
            <span className="px-2 py-0.5 text-[10px] rounded bg-crust/90 text-overlay1 border border-surface1/60">
              Loading content…
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
