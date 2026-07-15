// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const baseState = {
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

const mockUseStore = vi.fn(() => baseState)

vi.mock('../../../src/renderer/stores/conductorMcpStore', () => ({
  useConductorMcpStore: () => mockUseStore(),
}))

const { default: VisionSubTool } = await import('../../../src/renderer/components/conductor-mcp/VisionSubTool')

describe('VisionSubTool (P7.4)', () => {
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

  it('shows Stopped + Start button when browser is not running', () => {
    mockUseStore.mockReturnValue({ ...baseState, browserRunning: false, browserConnected: false })
    act(() => { root.render(React.createElement(VisionSubTool)) })
    const text = container.textContent ?? ''
    expect(text).toContain('Stopped')
    expect(text).toContain('Start browser')
    expect(text).not.toContain('Stop browser')
  })

  it('shows Connected + Stop button when browser is running + connected', () => {
    mockUseStore.mockReturnValue({ ...baseState, browserRunning: true, browserConnected: true })
    act(() => { root.render(React.createElement(VisionSubTool)) })
    const text = container.textContent ?? ''
    expect(text).toContain('Connected')
    expect(text).toContain('Stop browser')
    expect(text).not.toContain('Start browser')
  })

  it('shows Browser launching... when running but not yet connected', () => {
    mockUseStore.mockReturnValue({ ...baseState, browserRunning: true, browserConnected: false })
    act(() => { root.render(React.createElement(VisionSubTool)) })
    const text = container.textContent ?? ''
    expect(text).toContain('Browser launching')
  })
})
