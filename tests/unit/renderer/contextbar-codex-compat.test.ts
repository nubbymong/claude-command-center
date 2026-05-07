// @vitest-environment jsdom
/**
 * P3.3 regression: ContextBar renders correctly when Claude-only fields
 * (rateLimitExtra, isPeak) are undefined -- as P3.1's Codex ingester pushes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

// Required for React 18 act() in jsdom -- suppresses "not configured" warning
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// --- mock useSettingsStore before component import ---
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const DEFAULT_STATUS_LINE = {
    showModel: true,
    showTokens: true,
    showContextBar: true,
    showCost: true,
    showLinesChanged: true,
    showDuration: true,
    showRateLimits: true,
    showResetTime: true,
    font: 'sans',
    fontSize: 12,
  }
  return {
    DEFAULT_STATUS_LINE,
    useSettingsStore: (selector: (s: { settings: { statusLine: typeof DEFAULT_STATUS_LINE } }) => unknown) =>
      selector({ settings: { statusLine: DEFAULT_STATUS_LINE } }),
  }
})

// Import after mock is registered
const { default: ContextBar } = await import('../../../src/renderer/components/terminal/ContextBar')

// Codex-shape props: rateLimitExtra and isPeak are explicitly undefined
const codexProps = {
  modelName: 'gpt-5.5',
  inputTokens: 41133,
  contextWindowSize: 1_000_000,
  contextPercent: 4.1,
  costUsd: 0.215,
  rateLimitCurrent: 41,
  rateLimitCurrentResets: '2026-05-04T13:30:00.000Z',
  rateLimitWeekly: 13,
  rateLimitWeeklyResets: '2026-05-11T00:00:00.000Z',
  rateLimitExtra: undefined,
  isPeak: undefined,
}

// Claude-shape props: rateLimitExtra and isPeak are set
const claudeProps = {
  ...codexProps,
  modelName: 'claude-opus-4-5',
  rateLimitExtra: { enabled: true, utilization: 55, usedUsd: 8.23, limitUsd: 100 },
  isPeak: true,
}

// One root per test, unmounted in afterEach. Avoids the React 18 multi-root
// leak pattern flagged by Copilot review on PR #30 (2026-05-07).
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function render(element: React.ReactElement): void {
  act(() => {
    root.render(element)
  })
}

describe('ContextBar -- Codex compatibility (P3.3)', () => {
  it('renders without crashing for Codex shape (rateLimitExtra/isPeak undefined)', () => {
    expect(() => render(React.createElement(ContextBar, codexProps))).not.toThrow()
    // Component rendered -- container should have content
    expect(container.innerHTML.length).toBeGreaterThan(0)
  })

  it('does not render rateLimitExtra UI when rateLimitExtra is undefined', () => {
    render(React.createElement(ContextBar, codexProps))
    // The extra-spend label includes "extra:" text
    expect(container.textContent).not.toContain('extra:')
  })

  it('does not render isPeak / Off-peak badge when isPeak is undefined', () => {
    render(React.createElement(ContextBar, codexProps))
    // The badge renders either "Peak" or "Off-peak" text
    expect(container.textContent).not.toContain('Peak')
    expect(container.textContent).not.toContain('Off-peak')
  })

  it('renders model name and context bar with Codex shape', () => {
    render(React.createElement(ContextBar, codexProps))
    // Model name should appear
    expect(container.textContent).toContain('gpt-5.5')
    // Rate limit percentage should appear (41%)
    expect(container.textContent).toContain('41%')
  })

  it('renders rateLimitExtra UI when rateLimitExtra is set (Claude shape)', () => {
    render(React.createElement(ContextBar, claudeProps))
    // extra: label IS present for Claude shape
    expect(container.textContent).toContain('extra:')
  })

  it('renders isPeak badge when isPeak is true (Claude shape)', () => {
    render(React.createElement(ContextBar, claudeProps))
    // Peak badge IS present for Claude shape
    expect(container.textContent).toContain('Peak')
  })
})
