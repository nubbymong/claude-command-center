// @vitest-environment jsdom
/**
 * P3.3 regression: RateLimitBar renders correctly with and without optional
 * resets string. The component has no rateLimitExtra/isPeak fields; this
 * suite confirms it handles the Codex data shape it receives.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

// Required for React 18 act() in jsdom -- suppresses "not configured" warning
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// RateLimitBar has no store dependency -- import directly
const { default: RateLimitBar } = await import('../../../src/renderer/components/terminal/RateLimitBar')

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  container.remove()
})

function render(element: React.ReactElement): void {
  act(() => {
    createRoot(container).render(element)
  })
}

describe('RateLimitBar -- Codex compatibility (P3.3)', () => {
  it('renders without crashing when resets is undefined (Codex shape)', () => {
    expect(() =>
      render(React.createElement(RateLimitBar, { label: '5h', pct: 41 }))
    ).not.toThrow()
    expect(container.innerHTML.length).toBeGreaterThan(0)
  })

  it('does not render rateLimitExtra-related UI (component has no such field)', () => {
    render(React.createElement(RateLimitBar, { label: '5h', pct: 41 }))
    // The component only renders label + bar + percentage
    expect(container.textContent).not.toContain('extra:')
  })

  it('does not render isPeak label (component has no such field)', () => {
    render(React.createElement(RateLimitBar, { label: '5h', pct: 41 }))
    expect(container.textContent).not.toContain('Peak')
    expect(container.textContent).not.toContain('Off-peak')
  })

  it('renders label and clamped percentage', () => {
    render(React.createElement(RateLimitBar, { label: '5h', pct: 41 }))
    // Label text
    expect(container.textContent).toContain('5h')
    // Rounded percentage
    expect(container.textContent).toContain('41%')
  })

  it('renders with resets string present (Claude shape -- same component code path)', () => {
    expect(() =>
      render(React.createElement(RateLimitBar, {
        label: '5h',
        pct: 41,
        resets: '2026-05-04T13:30:00.000Z',
      }))
    ).not.toThrow()
    // Percentage still renders
    expect(container.textContent).toContain('41%')
  })

  it('clamps pct > 100 without crashing', () => {
    render(React.createElement(RateLimitBar, { label: '5h', pct: 150 }))
    // Clamped to 100
    expect(container.textContent).toContain('100%')
  })

  it('clamps pct < 0 without crashing', () => {
    render(React.createElement(RateLimitBar, { label: '5h', pct: -5 }))
    // Clamped to 0
    expect(container.textContent).toContain('0%')
  })
})
