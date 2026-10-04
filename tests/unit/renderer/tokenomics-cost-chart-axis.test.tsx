// @vitest-environment jsdom
/**
 * Tokenomics "Cost over time": the x-axis date labels stay readable on any
 * range and at any width (2.1.1 owner report: the All range ran ~270 daily
 * labels into one unreadable line). The labels are spaced by the width the
 * chart is drawn at, never overlap, stay inside the chart, carry the year when
 * the range crosses a year, and the drawing is never stretched. Short ranges
 * keep a label per point. All [host]: jsdom only, the width faked.
 */
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { CostOverTimeChart } from '../../../src/renderer/components/tokenomics/CostOverTimeChart'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/** `count` consecutive days from `start` ('YYYY-MM-DD'), each with a cost. */
function days(start: string, count: number): Array<{ day: string; costUsd: number }> {
  const t0 = Date.parse(`${start}T00:00:00Z`)
  return Array.from({ length: count }, (_, i) => ({
    day: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
    costUsd: 1 + (i % 9),
  }))
}

const DATE_LABEL = /^(\d{4}-)?\d{2}-\d{2}$/

interface Label { text: string; x: number; fontPx: number }

describe('cost over time: x-axis date labels', () => {
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
  /** Mounts the chart afresh, so it is measured at the current fake width. */
  const render = (data: Array<{ day: string; costUsd: number }>) => {
    act(() => { root.unmount() })
    root = createRoot(container)
    act(() => { root.render(createElement(CostOverTimeChart, { data })) })
  }

  const svg = () => container.querySelector('svg') as SVGSVGElement
  const viewBox = () => (svg().getAttribute('viewBox') ?? '').split(/\s+/).map(Number)
  const labels = (): Label[] =>
    [...svg().querySelectorAll('text')]
      .filter((t) => DATE_LABEL.test(t.textContent ?? ''))
      .map((t) => ({ text: t.textContent ?? '', x: Number(t.getAttribute('x')), fontPx: Number(t.getAttribute('font-size')) }))
  /** A label's drawn width can be no wider than this (digits and '-' run
   *  about half the font size wide); the check uses it as the footprint. */
  const footprint = (l: Label) => l.text.length * l.fontPx * 0.55

  /** No two labels overlap, and none runs past either edge of the chart. */
  function expectReadable(ls: Label[]) {
    const width = viewBox()[2]
    for (const l of ls) {
      expect(l.x - footprint(l) / 2, `${l.text} starts inside the chart`).toBeGreaterThanOrEqual(0)
      expect(l.x + footprint(l) / 2, `${l.text} ends inside the chart`).toBeLessThanOrEqual(width)
    }
    for (let i = 1; i < ls.length; i++) {
      const gap = ls[i].x - ls[i - 1].x - (footprint(ls[i]) + footprint(ls[i - 1])) / 2
      expect(gap, `${ls[i - 1].text} and ${ls[i].text} do not overlap`).toBeGreaterThanOrEqual(4)
    }
  }

  it('[host] ~270 daily points: a bounded number of labels, none overlapping, at the default width', () => {
    render(days('2026-01-06', 270))
    const ls = labels()
    expect(ls.length).toBeGreaterThanOrEqual(4)
    expect(ls.length).toBeLessThanOrEqual(14)
    expectReadable(ls)
    // Evenly spread, in order: the first day is labelled, the rest follow left to right.
    expect(ls[0].text).toBe('01-06')
    for (let i = 1; i < ls.length; i++) expect(ls[i].x).toBeGreaterThan(ls[i - 1].x)
  })

  it('[host] the label count follows the width the chart is drawn at', () => {
    fakeWidth = 1000
    render(days('2026-01-06', 270))
    const wide = labels()
    expect(viewBox()[2]).toBe(1000)
    expectReadable(wide)
    expect(wide.length).toBeLessThanOrEqual(25)

    fakeWidth = 300
    render(days('2026-01-06', 271))
    const narrow = labels()
    expect(viewBox()[2]).toBe(300)
    expectReadable(narrow)
    expect(narrow.length).toBeLessThan(wide.length)
    expect(narrow.length).toBeGreaterThanOrEqual(2)
  })

  it('[host] re-lays the labels out when the chart is resized', () => {
    ;(globalThis as any).ResizeObserver = class {
      private readonly cb: () => void
      constructor(cb: () => void) { this.cb = cb; observers.push(cb) }
      observe() {}
      unobserve() {}
      disconnect() { observers = observers.filter((o) => o !== this.cb) }
    }
    fakeWidth = 900
    render(days('2026-01-06', 270))
    const before = labels().length
    expect(viewBox()[2]).toBe(900)
    fakeWidth = 320
    act(() => { for (const o of observers) o() })
    expect(viewBox()[2]).toBe(320)
    expect(labels().length).toBeLessThan(before)
    expectReadable(labels())
  })

  it('[host] the drawing is never stretched: one SVG unit is one pixel at any width', () => {
    for (const w of [260, 460, 1200]) {
      fakeWidth = w
      render(days('2026-01-06', 30 + w))
      expect(svg().getAttribute('preserveAspectRatio')).not.toBe('none')
      const [, , vw, vh] = viewBox()
      expect(vw).toBe(w)
      expect(Number(svg().getAttribute('height'))).toBe(vh)
      // The dots stay round: a circle, sized in pixels.
      for (const c of svg().querySelectorAll('circle')) expect(c.getAttribute('r')).toBe('2.5')
    }
  })

  it('[host] a range across a year boundary shows the year on its labels', () => {
    render(days('2025-12-20', 22))
    const ls = labels()
    expect(ls.length).toBeGreaterThanOrEqual(2)
    for (const l of ls) expect(l.text).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(ls.some((l) => l.text.startsWith('2025-'))).toBe(true)
    expect(ls.some((l) => l.text.startsWith('2026-'))).toBe(true)
    expectReadable(ls)
  })

  it('[host] a range within one year keeps the short MM-DD labels', () => {
    render(days('2026-03-01', 90))
    const ls = labels()
    expect(ls.length).toBeGreaterThanOrEqual(2)
    for (const l of ls) expect(l.text).toMatch(/^\d{2}-\d{2}$/)
  })

  it('[host] 7 days: every day labelled, in order, the last one included', () => {
    const data = days('2026-09-26', 7)
    render(data)
    const ls = labels()
    expect(ls.map((l) => l.text)).toEqual(data.map((d) => d.day.slice(5)))
    expectReadable(ls)
    // Narrower than the default, still every day.
    fakeWidth = 340
    render(days('2026-09-26', 7).map((d) => ({ ...d, costUsd: d.costUsd + 1 })))
    expect(labels()).toHaveLength(7)
    expectReadable(labels())
  })

  it('[host] 30 days: at least as many labels as before, readable', () => {
    render(days('2026-09-03', 30))
    const ls = labels()
    expect(ls.length).toBeGreaterThanOrEqual(6)
    expectReadable(ls)
  })

  it('[host] the last day is labelled only when it does not collide with its neighbour', () => {
    // Whatever the stride, adding the last day never overlaps the label before it.
    for (const n of [61, 100, 181, 270, 365]) {
      render(days('2026-01-06', n))
      expectReadable(labels())
    }
    // A single day: one label, centred.
    render(days('2026-05-05', 1))
    const one = labels()
    expect(one.map((l) => l.text)).toEqual(['05-05'])
    expect(one[0].x).toBeCloseTo(viewBox()[2] / 2, 0)
  })

  it('[host] the tooltips are unchanged: one per day, the full date and its cost', () => {
    const data = days('2026-01-06', 40)
    render(data)
    const titles = [...svg().querySelectorAll('title')].map((t) => t.textContent)
    expect(titles).toHaveLength(40)
    expect(titles[0]).toBe('2026-01-06: $1.00')
    expect(titles[39]).toBe(`${data[39].day}: $${data[39].costUsd.toFixed(2)}`)
  })
})
