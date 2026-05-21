// @vitest-environment jsdom
/**
 * P7.4 regression: ConductorMcpPage renders the umbrella header
 * + three sub-tool cards (Vision, Codex review, Host transfer).
 * Each sub-tool card is independent -- the page does not gate
 * codex_review or host transfer on browser state.
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

vi.mock('../../../src/renderer/stores/conductorMcpStore', () => ({
  useConductorMcpStore: () => mockState,
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

  it('renders all three sub-tool cards', () => {
    act(() => { root.render(React.createElement(ConductorMcpPage)) })
    const text = container.textContent ?? ''
    expect(text).toContain('Vision (browser automation)')
    expect(text).toContain('Codex review (Claude-driven)')
    expect(text).toContain('Host transfer')
  })

  it('shows codex_review and host transfer as Available even when browser is stopped', () => {
    act(() => { root.render(React.createElement(ConductorMcpPage)) })
    const html = container.innerHTML
    expect(html).toContain('Available')
  })
})
