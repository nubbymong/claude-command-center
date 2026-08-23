// Agent Canvas zoom ladder (#368) — the arithmetic the wheel and the chords
// walk. Pure functions; the pane applies whatever these return.

import { describe, it, expect } from 'vitest'
import {
  CANVAS_ZOOM_LADDER,
  CANVAS_ZOOM_MAX,
  CANVAS_ZOOM_MIN,
  formatCanvasZoom,
  stepCanvasZoom,
} from '../../../src/renderer/utils/canvas-zoom'

describe('the ladder itself', () => {
  it('spans exactly the 50–200 % range the issue asks for', () => {
    expect(CANVAS_ZOOM_MIN).toBe(0.5)
    expect(CANVAS_ZOOM_MAX).toBe(2)
  })

  it('is strictly increasing and includes 1', () => {
    for (let i = 1; i < CANVAS_ZOOM_LADDER.length; i++) {
      expect(CANVAS_ZOOM_LADDER[i]).toBeGreaterThan(CANVAS_ZOOM_LADDER[i - 1])
    }
    expect(CANVAS_ZOOM_LADDER).toContain(1)
  })
})

describe('stepCanvasZoom', () => {
  it('walks one rung per step in both directions from 1', () => {
    expect(stepCanvasZoom(1, 1)).toBe(1.1)
    expect(stepCanvasZoom(1, -1)).toBe(0.9)
    expect(stepCanvasZoom(1, 2)).toBe(1.25)
  })

  it('clamps at both ends of the ladder', () => {
    expect(stepCanvasZoom(2, 1)).toBe(2)
    expect(stepCanvasZoom(0.5, -1)).toBe(0.5)
    expect(stepCanvasZoom(1, 100)).toBe(2)
    expect(stepCanvasZoom(1, -100)).toBe(0.5)
  })

  it('walks the full ladder up and back down without drifting', () => {
    let z = CANVAS_ZOOM_MIN
    for (let i = 0; i < CANVAS_ZOOM_LADDER.length + 3; i++) z = stepCanvasZoom(z, 1)
    expect(z).toBe(CANVAS_ZOOM_MAX)
    for (let i = 0; i < CANVAS_ZOOM_LADDER.length + 3; i++) z = stepCanvasZoom(z, -1)
    expect(z).toBe(CANVAS_ZOOM_MIN)
  })

  it('snaps an off-ladder value to its nearest rung before walking', () => {
    expect(stepCanvasZoom(1.02, 1)).toBe(1.1)
    expect(stepCanvasZoom(0.51, -1)).toBe(0.5)
    expect(stepCanvasZoom(1.6, 0)).toBe(1.5)
  })

  it('treats a non-finite current or step as no movement from 1', () => {
    expect(stepCanvasZoom(Number.NaN, 1)).toBe(1.1)
    expect(stepCanvasZoom(1, Number.NaN)).toBe(1)
    expect(stepCanvasZoom(Number.POSITIVE_INFINITY, 0)).toBe(1)
  })

  it('truncates fractional steps rather than inventing rungs', () => {
    expect(stepCanvasZoom(1, 1.9)).toBe(1.1)
    expect(stepCanvasZoom(1, -1.9)).toBe(0.9)
  })
})

describe('formatCanvasZoom', () => {
  it('prints whole percents', () => {
    expect(formatCanvasZoom(1)).toBe('100%')
    expect(formatCanvasZoom(0.67)).toBe('67%')
    expect(formatCanvasZoom(2)).toBe('200%')
  })
})
