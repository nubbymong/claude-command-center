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
  // STATE carries theme + getState so useResolvedTheme (called by ContextBar)
  // resolves the identity key without touching window.matchMedia.
  const STATE = { settings: { statusLine: DEFAULT_STATUS_LINE, theme: 'dark' as const } }
  const useSettingsStore: any = (selector: (s: typeof STATE) => unknown) => selector(STATE)
  useSettingsStore.getState = () => STATE
  return { DEFAULT_STATUS_LINE, useSettingsStore }
})

// Import after mock is registered
const { default: ContextBar } = await import('../../../src/renderer/components/terminal/ContextBar')

// Codex-shape props: rateLimitExtra is explicitly undefined
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
