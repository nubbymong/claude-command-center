// @vitest-environment jsdom
/**
 * P5.1: ContextBar Codex first-turn rate-limit caption.
 * When a Codex session has no rate-limit data yet (Codex CLI does not
 * currently expose rate-limit telemetry), ContextBar should render a
 * single muted caption row instead of suppressing the rate-limit row
 * entirely.
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
const codexPropsBase = {
  modelName: 'gpt-5.5',
  inputTokens: 41133,
  contextWindowSize: 1_000_000,
  contextPercent: 4.1,
  costUsd: 0.215,
  rateLimitCurrent: undefined,
  rateLimitCurrentResets: undefined,
  rateLimitWeekly: undefined,
  rateLimitWeeklyResets: undefined,
  rateLimitExtra: undefined,
  isPeak: undefined,
}

// Claude-shape props (with data)
const claudePropsBase = {
  modelName: 'claude-opus-4-5',
  inputTokens: 41133,
  contextWindowSize: 1_000_000,
  contextPercent: 4.1,
  costUsd: 0.215,
  rateLimitCurrent: 42,
  rateLimitCurrentResets: '2026-05-04T13:30:00.000Z',
  rateLimitWeekly: 13,
  rateLimitWeeklyResets: '2026-05-11T00:00:00.000Z',
  rateLimitExtra: { enabled: true, utilization: 55, usedUsd: 8.23, limitUsd: 100 },
  isPeak: true,
}

// One root per test, unmounted in afterEach.
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

describe('ContextBar -- Codex first-turn rate-limit caption (P5.1)', () => {
  it('renders the Codex first-turn caption when provider=codex and rateLimitCurrent is undefined', () => {
    render(React.createElement(ContextBar, {
      ...codexPropsBase,
      provider: 'codex',
    }))
    expect(container.textContent).toContain('Codex rate limits populate after first response')
  })

  it('does NOT render the caption for Claude sessions with no rate-limit data', () => {
    render(React.createElement(ContextBar, {
      ...codexPropsBase,
      provider: 'claude',
    }))
    expect(container.textContent ?? '').not.toContain('Codex rate limits populate')
  })

  it('does NOT render the caption when rateLimitCurrent IS populated for Codex', () => {
    render(React.createElement(ContextBar, {
      ...codexPropsBase,
      provider: 'codex',
      rateLimitCurrent: 42,
      rateLimitCurrentResets: '2026-05-04T13:30:00.000Z',
    }))
    expect(container.textContent ?? '').not.toContain('Codex rate limits populate')
  })
})
