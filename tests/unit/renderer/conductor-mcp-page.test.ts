// @vitest-environment jsdom
/**
 * P7.4 regression: ConductorMcpPage renders the umbrella header
 * + every sub-tool card (Vision, Agent Canvas, Codex review, Host
 * transfer). Each sub-tool card is independent -- the page does not
 * gate codex_review or host transfer on browser state.
 *
 * The Agent Canvas card landed with the canvas phases; this file is the
 * only place that pins it to the *page*, so a card that stops being
 * mounted fails here rather than passing on its own isolated render test.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mockState = {
  serverRunning: true,
  mcpPort: 19333,
  visionConfig: { browser: 'chrome', debugPort: 9222, headless: true },
  browserRunning: false,
  browserConnected: false,
  error: null,
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  launchBrowser: vi.fn(),
  stopBrowser: vi.fn(),
  fetchStatus: vi.fn(),
  handleStatusChanged: vi.fn(),
}

// Selector-aware mock: the page now reads via `useConductorMcpStore((s) => s.x)`
// (Zustand selector form), while child sub-tools still call it with no
// selector. Support both: apply the selector when given, else return the
// whole state object (real Zustand behaviour).
vi.mock('../../../src/renderer/stores/conductorMcpStore', () => ({
  useConductorMcpStore: (sel?: (s: typeof mockState) => unknown) =>
    sel ? sel(mockState) : mockState,
}))

const { default: ConductorMcpPage } = await import('../../../src/renderer/components/ConductorMcpPage')

describe('ConductorMcpPage umbrella (P7.4)', () => {
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

  it('renders the Conductor MCP header with server status + port', () => {
    act(() => { root.render(React.createElement(ConductorMcpPage)) })
    const text = container.textContent ?? ''
    expect(text).toContain('Conductor MCP')
    expect(text).toContain('Running')
    expect(text).toContain('19333')
  })

  it('renders all four sub-tool cards', () => {
    act(() => { root.render(React.createElement(ConductorMcpPage)) })
    const text = container.textContent ?? ''
    expect(text).toContain('Vision (browser automation)')
    expect(text).toContain('Agent Canvas')
    expect(text).toContain('Codex review (Claude-driven)')
    expect(text).toContain('Host transfer')
  })

  it('shows codex_review and host transfer as Available even when browser is stopped', () => {
    act(() => { root.render(React.createElement(ConductorMcpPage)) })
    const html = container.innerHTML
    expect(html).toContain('Available')
  })

  it('names every tool the server takes down with it when it is not running', () => {
    // The degraded state used to list three tools while four ship, so the
    // canvas looked like it had failed for some other reason.
    mockState.serverRunning = false
    try {
      act(() => { root.render(React.createElement(ConductorMcpPage)) })
      const text = container.textContent ?? ''
      expect(text).toContain('Conductor MCP server is not running')
      expect(text).toContain('Vision')
      expect(text).toContain('Codex review')
      expect(text).toContain('host transfer')
      expect(text).toContain('Agent Canvas')
    } finally {
      mockState.serverRunning = true
    }
  })
})
