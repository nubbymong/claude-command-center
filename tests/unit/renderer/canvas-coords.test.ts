// @vitest-environment jsdom
// Coordinate discipline (spec §3.4): content page ↔ stage ↔ Excalidraw scene.
//
// Production code routes ALL scene math through Excalidraw's exported
// sceneCoordsToViewportCoords / viewportCoordsToSceneCoords. Importing the
// real package here would execute its whole UI module graph (which dies in
// jsdom at module scope), so the mock below reimplements the two functions
// with Excalidraw's exact published formulas (packages/excalidraw/utils.ts):
//   viewport = (scene + scroll) · zoom.value + offset
//   scene    = (viewport − offset) / zoom.value − scroll
// What's under test is OUR wrapping, the compositions, and the glass-binding
// theorem (pinned glass ⇒ scene coords ≡ content page coords).

import { describe, it, expect, vi } from 'vitest'

vi.mock('@excalidraw/excalidraw', () => ({
  sceneCoordsToViewportCoords: (
    { sceneX, sceneY }: { sceneX: number; sceneY: number },
    s: { zoom: { value: number }; offsetLeft: number; offsetTop: number; scrollX: number; scrollY: number },
  ) => ({
    x: (sceneX + s.scrollX) * s.zoom.value + s.offsetLeft,
    y: (sceneY + s.scrollY) * s.zoom.value + s.offsetTop,
  }),
  viewportCoordsToSceneCoords: (
    { clientX, clientY }: { clientX: number; clientY: number },
    s: { zoom: { value: number }; offsetLeft: number; offsetTop: number; scrollX: number; scrollY: number },
  ) => ({
    x: (clientX - s.offsetLeft) / s.zoom.value - s.scrollX,
    y: (clientY - s.offsetTop) / s.zoom.value - s.scrollY,
  }),
}))
import {
  contentPageRectToStage,
  contentPageToScenePoint,
  contentPageToStagePoint,
  glassNeedsRepin,
  glassScrollForContent,
  sceneToContentPagePoint,
  sceneToStagePoint,
  stageRectIsVisible,
  stageToContentPagePoint,
  stageToScenePoint,
  type GlassAppState,
} from '../../../src/renderer/utils/canvas-coords'
import type { CanvasViewportInfo } from '../../../src/shared/canvas'

function vp(overrides: Partial<CanvasViewportInfo> = {}): CanvasViewportInfo {
  return { scrollX: 0, scrollY: 0, width: 1200, height: 800, dpr: 1, scale: 1, ...overrides }
}

function appState(overrides: Partial<GlassAppState> = {}): GlassAppState {
  return { scrollX: 0, scrollY: 0, zoom: { value: 1 }, offsetLeft: 0, offsetTop: 0, ...overrides }
}

const STAGE = { left: 40, top: 120 }

describe('content page ↔ stage', () => {
  it('subtracts content scroll', () => {
    const viewport = vp({ scrollX: 100, scrollY: 250 })
    expect(contentPageToStagePoint({ x: 130, y: 300 }, viewport)).toEqual({ x: 30, y: 50 })
    expect(stageToContentPagePoint({ x: 30, y: 50 }, viewport)).toEqual({ x: 130, y: 300 })
  })

  it('applies pinch scale to points and rects', () => {
    const viewport = vp({ scrollX: 10, scrollY: 20, scale: 2 })
    expect(contentPageToStagePoint({ x: 60, y: 70 }, viewport)).toEqual({ x: 100, y: 100 })
    expect(contentPageRectToStage({ x: 60, y: 70, width: 5, height: 8 }, viewport)).toEqual({
      x: 100,
      y: 100,
      width: 10,
      height: 16,
    })
  })

  it('round-trips', () => {
    const viewport = vp({ scrollX: 37, scrollY: 91, scale: 1.5 })
    const start = { x: 421.5, y: 87.25 }
    const back = stageToContentPagePoint(contentPageToStagePoint(start, viewport), viewport)
    expect(back.x).toBeCloseTo(start.x, 10)
    expect(back.y).toBeCloseTo(start.y, 10)
  })
})

describe('stage ↔ scene (Excalidraw transforms)', () => {
  it('maps through zoom, scene scroll, and canvas offset', () => {
    // viewport = (scene + scroll) * zoom + offset ⇒ stage 0,0 with offset at
    // the stage origin and zero scroll is scene 0,0 at any zoom.
    const state = appState({ offsetLeft: STAGE.left, offsetTop: STAGE.top, zoom: { value: 2 } })
    expect(stageToScenePoint({ x: 0, y: 0 }, STAGE, state)).toEqual({ x: 0, y: 0 })
    expect(stageToScenePoint({ x: 200, y: 100 }, STAGE, state)).toEqual({ x: 100, y: 50 })
    expect(sceneToStagePoint({ x: 100, y: 50 }, STAGE, state)).toEqual({ x: 200, y: 100 })
  })

  it('round-trips with awkward numbers', () => {
    const state = appState({
      offsetLeft: STAGE.left,
      offsetTop: STAGE.top,
      scrollX: -333.33,
      scrollY: 77.7,
      zoom: { value: 0.85 },
    })
    const start = { x: 512.5, y: 384.75 }
    const back = sceneToStagePoint(stageToScenePoint(start, STAGE, state), STAGE, state)
    expect(back.x).toBeCloseTo(start.x, 6)
    expect(back.y).toBeCloseTo(start.y, 6)
  })
})

describe('glass binding', () => {
  it('pinned glass ⇒ scene coords coincide with content page coords', () => {
    const viewport = vp({ scrollX: 480, scrollY: 1500 })
    const pinned = glassScrollForContent(viewport)
    const state = appState({
      scrollX: pinned.scrollX,
      scrollY: pinned.scrollY,
      zoom: pinned.zoom,
      offsetLeft: STAGE.left,
      offsetTop: STAGE.top,
    })
    const pagePoint = { x: 640, y: 1730 } // an element mid-document
    const scene = contentPageToScenePoint(pagePoint, viewport, STAGE, state)
    expect(scene.x).toBeCloseTo(pagePoint.x, 6)
    expect(scene.y).toBeCloseTo(pagePoint.y, 6)
    const back = sceneToContentPagePoint(scene, viewport, STAGE, state)
    expect(back.x).toBeCloseTo(pagePoint.x, 6)
    expect(back.y).toBeCloseTo(pagePoint.y, 6)
  })

  it('repin detection fires on drift and stays quiet within tolerance', () => {
    const viewport = vp({ scrollX: 100, scrollY: 0 })
    expect(glassNeedsRepin({ scrollX: -100, scrollY: 0, zoom: { value: 1 } }, viewport)).toBe(false)
    expect(glassNeedsRepin({ scrollX: -100.4, scrollY: 0, zoom: { value: 1 } }, viewport)).toBe(false)
    expect(glassNeedsRepin({ scrollX: -140, scrollY: 0, zoom: { value: 1 } }, viewport)).toBe(true)
    expect(glassNeedsRepin({ scrollX: -100, scrollY: 0, zoom: { value: 1.2 } }, viewport)).toBe(true)
  })

  it('pinned glass at content zoom (#368) ⇒ scene coords STILL coincide with page coords', () => {
    // The pane zooms the content (#368): 1 content px paints as `zoom` stage
    // px, and the glass binding carries the same factor as its scene zoom.
    // Scene coords must keep coinciding with content page coords — that is
    // what keeps a mark on its element through Ctrl+wheel.
    const zoom = 1.5
    const viewport = vp({ scrollX: 480, scrollY: 1500 })
    const pinned = glassScrollForContent(viewport, zoom)
    expect(pinned.zoom.value).toBe(zoom)
    const state = appState({
      scrollX: pinned.scrollX,
      scrollY: pinned.scrollY,
      zoom: pinned.zoom,
      offsetLeft: STAGE.left,
      offsetTop: STAGE.top,
    })
    const pagePoint = { x: 640, y: 1730 }
    // Content → stage under zoom folds the factor into the scale slot, exactly
    // as the pane's stageViewport does.
    const stagePoint = contentPageToStagePoint(pagePoint, { ...viewport, scale: viewport.scale * zoom })
    const scene = stageToScenePoint(stagePoint, STAGE, state)
    expect(scene.x).toBeCloseTo(pagePoint.x, 6)
    expect(scene.y).toBeCloseTo(pagePoint.y, 6)
    const back = sceneToStagePoint(scene, STAGE, state)
    expect(back.x).toBeCloseTo(stagePoint.x, 6)
    expect(back.y).toBeCloseTo(stagePoint.y, 6)
  })

  it('repin detection watches the zoom axis of the binding too (#368)', () => {
    const viewport = vp({ scrollX: 100, scrollY: 0 })
    // Glass already at the content zoom: pinned.
    expect(glassNeedsRepin({ scrollX: -100, scrollY: 0, zoom: { value: 1.5 } }, viewport, 1.5)).toBe(false)
    // Excalidraw wandered off the content zoom (wheel on the glass): repin.
    expect(glassNeedsRepin({ scrollX: -100, scrollY: 0, zoom: { value: 1 } }, viewport, 1.5)).toBe(true)
    // The pane stepped its zoom while the glass still holds the old one: repin.
    expect(glassNeedsRepin({ scrollX: -100, scrollY: 0, zoom: { value: 1.5 } }, viewport, 1.75)).toBe(true)
  })
})

describe('stageRectIsVisible', () => {
  it('detects overlap with the stage', () => {
    expect(stageRectIsVisible({ x: -10, y: -10, width: 20, height: 20 }, 100, 100)).toBe(true)
    expect(stageRectIsVisible({ x: 150, y: 0, width: 20, height: 20 }, 100, 100)).toBe(false)
    expect(stageRectIsVisible({ x: 0, y: -30, width: 20, height: 20 }, 100, 100)).toBe(false)
  })
})
