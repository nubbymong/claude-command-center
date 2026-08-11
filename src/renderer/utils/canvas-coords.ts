// Agent Canvas — coordinate discipline (spec §3.4).
//
// Three spaces, one conversion module:
//   1. CONTENT PAGE coords — what the bridge reports (document space inside
//      the iframe; independent of the iframe's scroll position).
//   2. STAGE coords — pixels inside the canvas stage element. The iframe fills
//      the stage exactly (absolute inset-0, borderless), so iframe-viewport
//      coords ≡ stage coords.
//   3. Excalidraw SCENE coords — the glass. Excalidraw's own
//      sceneCoordsToViewportCoords / viewportCoordsToSceneCoords are the only
//      scene transform entry points; nothing here re-derives their math.
//
// The glass is LOCKED to the content: scene scroll is bound to the negated
// content scroll at zoom 1 (glassScrollForContent), which makes scene coords
// coincide with content page coords — a mark drawn on an element stays on it
// through content scrolling. All functions are pure; unit tests cover them.

import { sceneCoordsToViewportCoords, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { CanvasViewportInfo, Rect } from '../../shared/canvas'

export interface Point {
  x: number
  y: number
}

/** The subset of Excalidraw appState the scene transforms read. */
export interface GlassAppState {
  scrollX: number
  scrollY: number
  zoom: { value: number }
  offsetLeft: number
  offsetTop: number
}

/** Where the stage element sits in the window's client coords. */
export interface StageOrigin {
  left: number
  top: number
}

// ── content page ↔ stage ────────────────────────────────────────────────────

/**
 * Content page → stage. Subtracts the content scroll and applies the pinch
 * scale (visualViewport.scale; 1 on desktop). Visual-viewport PANNING offsets
 * while pinched are not modelled in P1 — scale ≠ 1 is a tablet edge case the
 * overlay tolerates rather than tracks.
 */
export function contentPageToStagePoint(pt: Point, viewport: CanvasViewportInfo): Point {
  return {
    x: (pt.x - viewport.scrollX) * viewport.scale,
    y: (pt.y - viewport.scrollY) * viewport.scale,
  }
}

export function stageToContentPagePoint(pt: Point, viewport: CanvasViewportInfo): Point {
  return {
    x: pt.x / viewport.scale + viewport.scrollX,
    y: pt.y / viewport.scale + viewport.scrollY,
  }
}

export function contentPageRectToStage(rect: Rect, viewport: CanvasViewportInfo): Rect {
  const origin = contentPageToStagePoint({ x: rect.x, y: rect.y }, viewport)
  return {
    x: origin.x,
    y: origin.y,
    width: rect.width * viewport.scale,
    height: rect.height * viewport.scale,
  }
}

/** True when a stage-space rect overlaps the visible stage at all. */
export function stageRectIsVisible(rect: Rect, stageWidth: number, stageHeight: number): boolean {
  return rect.x < stageWidth && rect.y < stageHeight && rect.x + rect.width > 0 && rect.y + rect.height > 0
}

// ── stage ↔ scene (via Excalidraw's transforms only) ────────────────────────

/** Excalidraw brands zoom as NormalizedZoomValue; our plain-number state is
 *  structurally identical, so the boundary cast is the whole adaptation. */
type SceneTransformState = Parameters<typeof viewportCoordsToSceneCoords>[1]

export function stageToScenePoint(pt: Point, stage: StageOrigin, appState: GlassAppState): Point {
  const scene = viewportCoordsToSceneCoords(
    { clientX: stage.left + pt.x, clientY: stage.top + pt.y },
    appState as SceneTransformState,
  )
  return { x: scene.x, y: scene.y }
}

export function sceneToStagePoint(pt: Point, stage: StageOrigin, appState: GlassAppState): Point {
  const client = sceneCoordsToViewportCoords({ sceneX: pt.x, sceneY: pt.y }, appState as SceneTransformState)
  return { x: client.x - stage.left, y: client.y - stage.top }
}

// ── content page ↔ scene (compositions) ─────────────────────────────────────

export function contentPageToScenePoint(
  pt: Point,
  viewport: CanvasViewportInfo,
  stage: StageOrigin,
  appState: GlassAppState,
): Point {
  return stageToScenePoint(contentPageToStagePoint(pt, viewport), stage, appState)
}

export function sceneToContentPagePoint(
  pt: Point,
  viewport: CanvasViewportInfo,
  stage: StageOrigin,
  appState: GlassAppState,
): Point {
  return stageToContentPagePoint(sceneToStagePoint(pt, stage, appState), viewport)
}

// ── glass binding ───────────────────────────────────────────────────────────

/**
 * The appState scroll/zoom that pins the glass 1:1 over the content: scene
 * scroll = −content scroll at zoom 1. Under this binding (and the glass
 * canvas's own offset equal to the stage origin), scene coords coincide with
 * content page coords — verified by the round-trip unit tests.
 */
export function glassScrollForContent(viewport: CanvasViewportInfo): {
  scrollX: number
  scrollY: number
  zoom: { value: number }
} {
  return { scrollX: -viewport.scrollX, scrollY: -viewport.scrollY, zoom: { value: 1 } }
}

/** Whether the glass has drifted from its content binding enough to re-pin. */
export function glassNeedsRepin(
  appState: Pick<GlassAppState, 'scrollX' | 'scrollY' | 'zoom'>,
  viewport: CanvasViewportInfo,
  tolerance = 0.5,
): boolean {
  const target = glassScrollForContent(viewport)
  return (
    Math.abs(appState.scrollX - target.scrollX) > tolerance ||
    Math.abs(appState.scrollY - target.scrollY) > tolerance ||
    Math.abs(appState.zoom.value - target.zoom.value) > 0.001
  )
}
