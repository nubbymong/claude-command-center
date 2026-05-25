// @vitest-environment jsdom
/**
 * P8.11 + V2 shell 2b-1: ContextBar exposes an optional leftmost slot for the
 * active-account email, coloured by resolving the identity-palette KEY computed
 * main-side to a theme hex via resolveIdentityColor().
 *
 * Uses React.createElement (not JSX) so the file stays under the vitest include
 * pattern (*.test.ts) -- matches sibling contextbar tests.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// --- mock useSettingsStore before component import ---
// Must provide settings.statusLine (ContextBar) AND settings.theme + getState
// (useResolvedTheme, used to resolve the identity key to a theme hex).
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
  const STATE = { settings: { statusLine: DEFAULT_STATUS_LINE, theme: 'dark' as const } }
  const useSettingsStore: any = (selector: (s: typeof STATE) => unknown) => selector(STATE)
  useSettingsStore.getState = () => STATE
  return { DEFAULT_STATUS_LINE, useSettingsStore }
})

// Import after mock is registered
const { default: ContextBar } = await import('../../../src/renderer/components/terminal/ContextBar')
const { resolveIdentityColor } = await import('../../../src/shared/identity-colors')

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

function emailSpan(container: HTMLElement): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('span')).find(
    (s) => s.textContent === 'alice@example.com',
  )
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
        accountColour: 'mauve',
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

  it('resolves the identity key to a concrete colour (not a CSS var), keyed by the value', () => {
    act(() => {
      root.render(React.createElement(ContextBar, {
        ...(baseProps as any),
        accountEmail: 'alice@example.com',
        accountColour: 'mauve',
      }))
    })
    const colourMauve = emailSpan(container)?.style.color || ''
    expect(colourMauve).toBeTruthy()
    // No longer a Catppuccin CSS variable -- it is the resolved palette hex.
    expect(colourMauve).not.toContain('var(')

    act(() => {
      root.render(React.createElement(ContextBar, {
        ...(baseProps as any),
        accountEmail: 'alice@example.com',
        accountColour: 'rose',
      }))
    })
    const colourRose = emailSpan(container)?.style.color || ''
    // Different identity key resolves to a different colour (resolver is wired).
    expect(colourRose).not.toBe(colourMauve)
    // Sanity: resolveIdentityColor returns distinct hexes for these keys in dark theme.
    expect(resolveIdentityColor('mauve', 'dark')).not.toBe(resolveIdentityColor('rose', 'dark'))
  })
})
