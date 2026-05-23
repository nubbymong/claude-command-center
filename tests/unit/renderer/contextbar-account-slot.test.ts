// @vitest-environment jsdom
/**
 * P8.11: ContextBar exposes an optional leftmost slot for the active-account
 * email, coloured with the Catppuccin accent computed main-side.
 *
 * Uses React.createElement (not JSX) so the file stays under the
 * vitest include pattern (*.test.ts) -- matches sibling contextbar tests.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

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

const baseProps = {
  modelName: 'sonnet',
  inputTokens: 100,
  contextWindowSize: 200000,
  contextPercent: 0.1,
  costUsd: 0,
  linesAdded: 0,
  linesRemoved: 0,
  totalDurationMs: 0,
  rateLimitCurrent: null,
  rateLimitCurrentResets: null,
  rateLimitWeekly: null,
  rateLimitWeeklyResets: null,
  rateLimitExtra: null,
}

describe('ContextBar account slot', () => {
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

  it('renders the email when accountEmail is provided', () => {
    act(() => {
      root.render(React.createElement(ContextBar, {
        ...(baseProps as any),
        accountEmail: 'alice@example.com',
        accountColour: 'blue',
      }))
    })
    expect(container.textContent).toContain('alice@example.com')
  })

  it('does NOT render a placeholder when accountEmail is absent', () => {
    act(() => {
      root.render(React.createElement(ContextBar, baseProps as any))
    })
    expect(container.textContent).not.toContain('@')
  })

  it('applies a Catppuccin colour class derived from accountColour', () => {
    act(() => {
      root.render(React.createElement(ContextBar, {
        ...(baseProps as any),
        accountEmail: 'alice@example.com',
        accountColour: 'peach',
      }))
    })
    const emailEl = Array.from(container.querySelectorAll<HTMLElement>('span')).find(
      (s) => s.textContent === 'alice@example.com',
    )
    expect(emailEl).toBeDefined()
    const cls = emailEl?.className || ''
    const style = emailEl?.getAttribute('style') || ''
    expect(cls.includes('text-peach') || style.includes('--color-peach')).toBe(true)
  })
})
