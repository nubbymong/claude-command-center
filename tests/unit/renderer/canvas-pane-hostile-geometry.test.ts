// @vitest-environment jsdom
// Regression for the adversarial-review finding (2026-08-11): the content
// frame can postMessage the host directly, so hostile/degenerate geometry must
// be finite-guarded at the host boundary. Untreated, a NaN viewport reaches
// Excalidraw's updateScene AND permanently wedges the repin self-heal
// (glassNeedsRepin's Math.abs(x - NaN) > tol is always false).
//
// These import the PRODUCTION guards (canvas-geometry-guard) — the same code
// AgentCanvasPane runs — so no hand-copied mirror can drift green.

import { describe, it, expect, vi } from 'vitest'
import { finite, safeHit, safeRect, safeViewport, clampString } from '../../../src/renderer/utils/canvas-geometry-guard'
import type { CanvasViewportInfo } from '../../../src/shared/canvas'

// glassNeedsRepin/glassScrollForContent don't touch the scene transforms, but
// importing canvas-coords loads @excalidraw/excalidraw (whose dev ESM breaks
// under raw Node). Stub the two transform entry points the module imports.
vi.mock('@excalidraw/excalidraw', () => ({
  sceneCoordsToViewportCoords: () => ({ x: 0, y: 0 }),
  viewportCoordsToSceneCoords: () => ({ x: 0, y: 0 }),
}))
const { glassNeedsRepin, glassScrollForContent } = await import('../../../src/renderer/utils/canvas-coords')

describe('safeViewport rejects hostile viewport fields', () => {
  it('coerces NaN/Infinity/non-number fields to finite values; scale/dpr never 0', () => {
    const hostile = safeViewport({
      scrollX: NaN,
      scrollY: Infinity,
      width: -Infinity,
      height: 'boom' as unknown as number,
      dpr: 0,
      scale: 0,
    })
    for (const v of Object.values(hostile)) expect(Number.isFinite(v)).toBe(true)
    expect(hostile.scale).toBe(1)
    expect(hostile.dpr).toBe(1)
  })

  it('handles a completely empty/undefined viewport', () => {
    const vp = safeViewport(undefined)
    expect(vp).toEqual({ scrollX: 0, scrollY: 0, width: 0, height: 0, dpr: 1, scale: 1 })
  })
})

describe('safeRect / safeHit / clampString', () => {
  it('clamps negative dimensions to zero and coerces non-finite coords', () => {
    expect(safeRect({ x: NaN, y: -Infinity, width: -5, height: 'x' as unknown as number })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    })
  })

  it('safeHit produces finite box + capped strings for a hostile hit', () => {
    const long = 'a'.repeat(500)
    const hit = safeHit({
      role: long,
      name: long,
      tag: 42 as unknown as string,
      uxId: long,
      box: { x: Infinity, y: 0, width: -10, height: 30 },
    })
    expect(hit.role.length).toBe(120)
    expect(hit.name.length).toBe(120)
    expect(hit.tag).toBe('') // non-string coerced away
    expect(hit.uxId?.length).toBe(120)
    expect(Number.isFinite(hit.box.x)).toBe(true)
    expect(hit.box.width).toBe(0) // negative clamped
  })

  it('safeHit tolerates a missing box and non-object input', () => {
    expect(safeHit(undefined).box).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(() => safeHit(5 as never)).not.toThrow()
  })

  it('finite falls back for every non-number type', () => {
    for (const bad of [NaN, Infinity, -Infinity, '3', null, undefined, {}, [], true]) {
      expect(finite(bad as unknown, 7)).toBe(7)
    }
    expect(finite(-0, 9)).toBe(-0)
    expect(clampString(123 as unknown)).toBe('')
  })
})

describe('the NaN-wedge is closed', () => {
  it('a guarded viewport keeps the repin self-heal working; a raw NaN one wedges it', () => {
    const rawNaN = { scrollX: NaN, scrollY: 0, width: 100, height: 100, dpr: 1, scale: 1 } as CanvasViewportInfo
    // The bug: with a raw NaN viewport, the glass looks "in sync" forever and
    // never re-pins, silently detaching from the content.
    expect(glassNeedsRepin({ scrollX: -500, scrollY: 0, zoom: { value: 1 } }, rawNaN)).toBe(false)

    // The fix: the guarded viewport restores correct drift detection.
    const guarded = safeViewport(rawNaN)
    const pinned = glassScrollForContent(guarded)
    expect(glassNeedsRepin({ ...pinned }, guarded)).toBe(false) // pinned ⇒ no repin needed
    expect(glassNeedsRepin({ scrollX: -500, scrollY: 0, zoom: { value: 1 } }, guarded)).toBe(true) // drift ⇒ repin
  })
})
