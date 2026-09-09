// Viewport-aware placement for the fixed context menus.
//
// The session menu opened at the raw pointer coordinates, so a right-click low
// in the sidebar put its bottom items off-screen with nothing to scroll --
// reported against rc.16-pr606, where expanding Switch Account (one row per
// account) pushed the account list past the bottom edge and made the lower
// accounts unreachable. The menu had also just grown a Watchdog auto-retry
// block (#605), which is what made a long-standing latent bug reachable.
import { describe, it, expect } from 'vitest'
import { placeMenu } from '../../../src/renderer/utils/menuPlacement'

const VIEW = { viewportWidth: 1000, viewportHeight: 800 }
const at = (over: Partial<Parameters<typeof placeMenu>[0]> = {}) =>
  placeMenu({ x: 100, y: 100, width: 200, height: 300, ...VIEW, ...over })

describe('placeMenu — vertical', () => {
  it('opens at the click point when it fits below', () => {
    const p = at({ y: 100, height: 300 })
    expect(p.top).toBe(100)
  })

  it('opens UPWARD when it does not fit below but fits above', () => {
    // Click at 700 with a 300px menu: 92px below, 692px above.
    const p = at({ y: 700, height: 300 })
    expect(p.top, 'the bottom edge lands on the click point').toBe(400)
    expect(p.top + 300).toBeLessThanOrEqual(VIEW.viewportHeight)
  })

  it('caps the height and scrolls when it fits NEITHER side', () => {
    // Click near the middle of a short window: nothing can hold a 700px menu.
    const p = placeMenu({ x: 100, y: 380, width: 200, height: 700, viewportWidth: 1000, viewportHeight: 800 })
    expect(p.maxHeight, 'a capped menu must scroll rather than overflow').toBeLessThan(700)
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(VIEW.viewportHeight)
  })

  it('takes the roomier side when it fits neither — below', () => {
    const p = placeMenu({ x: 100, y: 200, width: 200, height: 900, viewportWidth: 1000, viewportHeight: 800 })
    expect(p.top).toBe(200)
    expect(p.maxHeight).toBe(800 - 8 - 200)
  })

  it('takes the roomier side when it fits neither — above', () => {
    const p = placeMenu({ x: 100, y: 600, width: 200, height: 900, viewportWidth: 1000, viewportHeight: 800 })
    expect(p.top, 'pinned to the top margin so the space above is usable').toBe(8)
    expect(p.maxHeight).toBe(600 - 8)
  })

  it('never caps below the minimum, however little room there is', () => {
    // A click 2px from the bottom of a short window.
    const p = placeMenu({ x: 10, y: 798, width: 200, height: 600, viewportWidth: 1000, viewportHeight: 800 })
    expect(p.maxHeight).toBeGreaterThanOrEqual(120)
  })

  it('a menu exactly the height of the space below still opens downward', () => {
    const p = placeMenu({ x: 100, y: 100, width: 200, height: 692, viewportWidth: 1000, viewportHeight: 800 })
    expect(p.top).toBe(100)
  })
})

describe('placeMenu — horizontal', () => {
  it('opens at the click point when it fits', () => {
    expect(at({ x: 100, width: 200 }).left).toBe(100)
  })

  it('flips to the left of the click when it would overflow the right edge', () => {
    const p = at({ x: 950, width: 200 })
    expect(p.left).toBe(750)
    expect(p.left + 200).toBeLessThanOrEqual(1000)
  })

  it('clamps rather than flipping off the LEFT edge', () => {
    // Too wide to sit either side of a click near the left edge.
    const p = placeMenu({ x: 60, y: 100, width: 980, height: 100, viewportWidth: 1000, viewportHeight: 800 })
    expect(p.left, 'never off the left edge').toBeGreaterThanOrEqual(8)
  })

  it('keeps the menu on screen for a click in the far corner', () => {
    const p = placeMenu({ x: 995, y: 795, width: 220, height: 400, viewportWidth: 1000, viewportHeight: 800 })
    expect(p.left).toBeGreaterThanOrEqual(8)
    expect(p.left + 220).toBeLessThanOrEqual(1000)
    expect(p.top).toBeGreaterThanOrEqual(8)
  })
})
