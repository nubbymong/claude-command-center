// @vitest-environment jsdom
/**
 * SidebarNav tooltip regression tests.
 *
 * Locks the live-install fix for the nav-icon hovers:
 *   1. The slow OS-native `title` tooltip is removed from every nav button
 *      (it conflicted with the instant custom tooltip), while the accessible
 *      name is preserved via `aria-label`.
 *   2. The instant custom tooltip (pointer-transparent, fades in on hover) is
 *      kept.
 *   3. Expanded tooltips anchor to a button edge instead of centring with
 *      `-translate-x-1/2`, so the leftmost icon's tooltip can no longer clip
 *      off the left edge of the window.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: SidebarNav } = await import('../../../src/renderer/components/sidebar/SidebarNav')

const baseProps = {
  currentView: 'sessions' as any,
  onViewChange: () => {},
  insightsStatus: null,
  insightsMessage: null,
  cloudAgentRunning: 0,
  onShowHelp: () => {},
}

describe('SidebarNav tooltips', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(props: Record<string, unknown> = baseProps) {
    act(() => root.render(React.createElement(SidebarNav, props as any)))
  }

  it('removes the slow native `title` from every nav button but keeps an aria-label', () => {
    render()
    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) {
      // The long-pause OS tooltip is gone...
      expect(b.hasAttribute('title'), `button "${b.textContent}" should not carry a native title`).toBe(false)
      // ...but the accessible name is preserved via aria-label.
      expect((b.getAttribute('aria-label') || '').length).toBeGreaterThan(0)
    }
  })

  it('keeps an instant, pointer-transparent custom tooltip on each nav button', () => {
    render()
    const agentHub = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Agent Hub'
    )
    expect(agentHub).toBeTruthy()
    const tip = agentHub!.querySelector('span[aria-hidden="true"]') as HTMLElement
    expect(tip).toBeTruthy()
    expect(tip.textContent).toBe('Agent Hub')
    expect(tip.className).toContain('pointer-events-none')
    expect(tip.className).toContain('group-hover:opacity-100')
  })

  it('anchors expanded tooltips to a button edge (never viewport-centred) so they cannot clip off-screen', () => {
    render()
    const buttons = Array.from(container.querySelectorAll('button'))
    let checked = 0
    for (const b of buttons) {
      const tip = b.querySelector('span[aria-hidden="true"]') as HTMLElement | null
      if (!tip) continue
      checked++
      // Must not use the centring transform that pushed the leftmost icon's
      // tooltip off the left edge of the window.
      expect(tip.className).not.toContain('-translate-x-1/2')
      expect(tip.className).not.toContain('left-1/2')
      // Anchors to the button's left or right edge instead.
      expect(tip.className.includes('left-0') || tip.className.includes('right-0')).toBe(true)
    }
    expect(checked).toBeGreaterThan(0)
  })
})
