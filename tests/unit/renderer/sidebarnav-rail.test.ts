// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: SidebarNav } = await import('../../../src/renderer/components/sidebar/SidebarNav')

const props = { currentView: 'sessions' as any, onViewChange: () => {}, insightsStatus: null, insightsMessage: null, cloudAgentRunning: 0 }

describe('SidebarNav rail', () => {
  let container: HTMLDivElement; let root: Root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('every nav button has an accessible name (aria-label/title)', () => {
    act(() => root.render(React.createElement(SidebarNav, props as any)))
    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) {
      const named = b.getAttribute('aria-label') || b.getAttribute('title')
      expect(named, `button "${b.textContent}" needs an accessible name`).toBeTruthy()
    }
  })

  it('labels the Conductor-MCP server dot when serverRunning is defined', () => {
    act(() => root.render(React.createElement(SidebarNav, { ...props, serverRunning: true } as any)))
    const dot = container.querySelector('[data-testid="conductor-mcp-dot"]') as HTMLElement
    expect(dot).toBeTruthy()
    expect(dot.getAttribute('title') || dot.getAttribute('aria-label')).toMatch(/conductor|mcp|server/i)
  })

  it('shows the tokenomics index dot when tokenomicsIndexComplete is true', () => {
    act(() => root.render(React.createElement(SidebarNav, { ...props, tokenomicsIndexComplete: true } as any)))
    const dot = container.querySelector('[data-testid="tokenomics-index-dot"]')
    expect(dot).toBeTruthy()
  })

  it('does not show the tokenomics index dot when tokenomicsIndexComplete is false', () => {
    act(() => root.render(React.createElement(SidebarNav, { ...props, tokenomicsIndexComplete: false } as any)))
    const dot = container.querySelector('[data-testid="tokenomics-index-dot"]')
    expect(dot).toBeNull()
  })
})
