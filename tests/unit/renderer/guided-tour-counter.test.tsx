// @vitest-environment jsdom
/**
 * The guided tour skips steps whose anchor isn't mounted (a collapsed sidebar
 * hides the new-config button, etc.), but the counter read "{i+1} of
 * STEPS.length" -- promising cards the tour would never show. It now counts
 * only the steps that are actually reachable.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: GuidedTour } = await import('../../../src/renderer/components/GuidedTour')

describe('GuidedTour step counter', () => {
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

  const render = () => {
    act(() => {
      root.render(React.createElement(GuidedTour, { onCreateConfig: () => {}, onClose: () => {} }))
    })
  }

  it('counts only the steps whose anchors exist', () => {
    // Nothing anchored in this DOM, so only the two centered cards are reachable.
    render()
    expect(container.textContent).toContain('1 of 2')
    expect(container.textContent).not.toContain('1 of 6')
  })

  it('keeps the denominator honest as the tour advances', () => {
    render()
    const next = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Next'))!
    act(() => { next.click() })
    expect(container.textContent).toContain('2 of 2')
  })

  it('counts an anchored step once its target is mounted', () => {
    const rail = document.createElement('div')
    rail.setAttribute('data-tour', 'nav-rail')
    document.body.appendChild(rail)
    try {
      render()
      expect(container.textContent).toContain('1 of 3')
    } finally {
      rail.remove()
    }
  })
})
