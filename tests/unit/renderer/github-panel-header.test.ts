// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import PanelHeader from '../../../src/renderer/components/github/PanelHeader'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('GitHubPanel PanelHeader -- collapse button (#348)', () => {
  let container: HTMLDivElement, root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('renders a collapse button when onCollapse is provided', () => {
    act(() => {
      root.render(createElement(PanelHeader, {
        syncState: 'idle' as const,
        onRefresh: () => {},
        onCollapse: () => {},
      }))
    })
    const btn = container.querySelector('button[aria-label="Hide GitHub panel"]') as HTMLButtonElement | null
    expect(btn).not.toBeNull()
  })

  it('does NOT render a collapse button when onCollapse is omitted', () => {
    act(() => {
      root.render(createElement(PanelHeader, {
        syncState: 'idle' as const,
        onRefresh: () => {},
      }))
    })
    const btn = container.querySelector('button[aria-label="Hide GitHub panel"]')
    expect(btn).toBeNull()
  })

  it('invokes onCollapse when the collapse button is clicked', () => {
    const onCollapse = vi.fn()
    act(() => {
      root.render(createElement(PanelHeader, {
        syncState: 'idle' as const,
        onRefresh: () => {},
        onCollapse,
      }))
    })
    const btn = container.querySelector('button[aria-label="Hide GitHub panel"]') as HTMLButtonElement
    act(() => { btn.click() })
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it('refresh button is unchanged when onCollapse is provided', () => {
    const onRefresh = vi.fn()
    act(() => {
      root.render(createElement(PanelHeader, {
        syncState: 'idle' as const,
        onRefresh,
        onCollapse: () => {},
      }))
    })
    const btn = container.querySelector('button[aria-label="Refresh"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    act(() => { btn.click() })
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })
})
