// @vitest-environment jsdom
/**
 * Memory's activity chart is drawn at the width it is given, one SVG unit to a
 * pixel, as Tokenomics' cost chart is (PR 4 review T-S1): before, it stretched
 * a 100-unit-wide drawing over the whole card, so its dots became wide
 * ellipses and its line thickened on the slopes. The width is measured and
 * re-measured on resize; the size watch ends with the chart. All [host]:
 * jsdom only, the width faked.
 */
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import MemoryActivityChart from '../../../src/renderer/components/memory/MemoryActivityChart'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const WEEKS = [0, 3, 1, 0, 6, 2, 0, 0, 4, 1, 5, 2]

describe('memory activity chart: drawn at its own width', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeWidth: number | null = null
  const realClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  const realResizeObserver = (globalThis as any).ResizeObserver
  let observers: Array<() => void> = []

  beforeEach(() => {
    fakeWidth = null
    observers = []
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() { return fakeWidth ?? 0 },
    })
    ;(globalThis as any).ResizeObserver = class {
      private readonly cb: () => void
      constructor(cb: () => void) { this.cb = cb; observers.push(cb) }
      observe() {}
      unobserve() {}
      disconnect() { observers = observers.filter((o) => o !== this.cb) }
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    if (realClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', realClientWidth)
    else delete (HTMLElement.prototype as any).clientWidth
    ;(globalThis as any).ResizeObserver = realResizeObserver
  })
  const render = (buckets: number[]) => act(() => { root.render(createElement(MemoryActivityChart, { buckets })) })
  const svg = () => container.querySelector('svg') as SVGSVGElement
  const viewBox = () => (svg().getAttribute('viewBox') ?? '').split(/\s+/).map(Number)
  const dots = () => [...svg().querySelectorAll('circle')]

  it('[host] one SVG unit is one pixel at any width: never stretched, the dots round', () => {
    for (const w of [240, 520, 1100]) {
      fakeWidth = w
      act(() => { root.unmount() })
      root = createRoot(container)
      render(WEEKS)
      expect(svg().getAttribute('preserveAspectRatio')).not.toBe('none')
      const [, , vw, vh] = viewBox()
      expect(vw).toBe(w)
      expect(Number(svg().getAttribute('height'))).toBe(vh)
      // One radius for every dot, in pixels, whatever the width.
      expect(new Set(dots().map((c) => c.getAttribute('r')))).toEqual(new Set(['2.5']))
      // Every dot inside the drawing, the first and last not cut in half.
      for (const c of dots()) {
        const cx = Number(c.getAttribute('cx'))
        const cy = Number(c.getAttribute('cy'))
        expect(cx - 2.5).toBeGreaterThanOrEqual(0)
        expect(cx + 2.5).toBeLessThanOrEqual(vw)
        expect(cy - 2.5).toBeGreaterThanOrEqual(0)
        expect(cy + 2.5).toBeLessThanOrEqual(vh)
      }
    }
  })

  it('[host] a dot for each week with activity, in order, the busiest highest', () => {
    fakeWidth = 600
    render(WEEKS)
    const ds = dots()
    expect(ds).toHaveLength(WEEKS.filter((v) => v > 0).length)
    const xs = ds.map((c) => Number(c.getAttribute('cx')))
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1])
    const ys = ds.map((c) => Number(c.getAttribute('cy')))
    const busiest = WEEKS.filter((v) => v > 0).indexOf(Math.max(...WEEKS))
    expect(Math.min(...ys)).toBe(ys[busiest])
  })

  it('[host] re-measures on resize, and stops watching when it unmounts', () => {
    fakeWidth = 900
    render(WEEKS)
    expect(viewBox()[2]).toBe(900)
    expect(observers).toHaveLength(1)
    fakeWidth = 320
    act(() => { for (const o of observers) o() })
    expect(viewBox()[2]).toBe(320)
    act(() => { root.unmount() })
    expect(observers).toHaveLength(0)
    root = createRoot(container)
  })

  it('[host] twelve quiet weeks: the empty message, no drawing and nothing watched', () => {
    render(new Array(12).fill(0))
    expect(container.textContent).toContain('No activity in the last 12 weeks')
    expect(container.querySelector('svg')).toBeNull()
    expect(observers).toHaveLength(0)
  })
})
