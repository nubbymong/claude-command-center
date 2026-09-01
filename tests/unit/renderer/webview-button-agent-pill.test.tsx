// @vitest-environment jsdom
/**
 * The Browser tool's agent-push notification pill (open_in_app_browser). The
 * pill appears when the store carries an unread push; clicking the button
 * consumes it — loads the pushed page and opens the pane — and never yanks a
 * page the user is already viewing (the page loads only on that explicit click).
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const trackUsage = vi.fn()
vi.mock('../../../src/renderer/stores/tipsStore', () => ({ trackUsage: (...a: unknown[]) => trackUsage(...a) }))

const { default: WebviewButton } = await import('../../../src/renderer/components/WebviewButton')
const { useWebviewStore } = await import('../../../src/renderer/stores/webviewStore')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  useWebviewStore.setState({ bySessionId: {} })
  trackUsage.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const render = (sessionId = 's1') => {
  act(() => { root.render(React.createElement(WebviewButton, { sessionId } as never)) })
}
const btn = () => container.querySelector('[data-testid="browser-toggle"]') as HTMLButtonElement
const pill = () => container.querySelector('[data-testid="browser-agent-pill"]')

describe('agent-push notification pill', () => {
  it('shows no pill when there is no unread push', () => {
    render()
    expect(pill()).toBeNull()
    expect(btn().getAttribute('data-agent-unread')).toBeNull()
  })

  it('raises the pill (and names the page in the title) when the store has an unread push', () => {
    act(() => { useWebviewStore.getState().pushAgentUrl('s1', 'https://example.com/pr/1') })
    render()
    expect(pill()).not.toBeNull()
    expect(btn().getAttribute('data-agent-unread')).toBe('1')
    expect(btn().title).toContain('waiting for you')
    expect(btn().title).toContain('https://example.com/pr/1')
  })

  it('clicking consumes the push: navigates to the page, opens the pane, clears the pill, records the open', () => {
    act(() => { useWebviewStore.getState().pushAgentUrl('s1', 'https://example.com/pr/1') })
    render()
    act(() => { btn().click() })
    const st = useWebviewStore.getState().bySessionId['s1']
    expect(st.currentUrl).toBe('https://example.com/pr/1')
    expect(st.isOpen).toBe(true)
    expect(st.unread).toBe(false)
    expect(st.pendingAgentUrl).toBeNull()
    expect(pill()).toBeNull()
    expect(trackUsage.mock.calls.filter((c) => c[0] === 'webview.opened')).toHaveLength(1)
  })

  it('does NOT yank an actively-viewed page: the pill waits, the viewed URL is untouched until the click', () => {
    act(() => {
      useWebviewStore.getState().navigate('s1', 'https://user-here.test/')
      useWebviewStore.getState().pushAgentUrl('s1', 'https://agent.test/')
    })
    render()
    expect(pill()).not.toBeNull()
    expect(useWebviewStore.getState().bySessionId['s1'].currentUrl).toBe('https://user-here.test/')
    // The explicit click is what loads the pushed page — not the push itself.
    act(() => { btn().click() })
    expect(useWebviewStore.getState().bySessionId['s1'].currentUrl).toBe('https://agent.test/')
    expect(pill()).toBeNull()
  })

  it('with no unread push, clicking just toggles the pane (unchanged behaviour)', () => {
    render()
    act(() => { btn().click() })
    expect(useWebviewStore.getState().bySessionId['s1'].isOpen).toBe(true)
    act(() => { btn().click() })
    expect(useWebviewStore.getState().bySessionId['s1'].isOpen).toBe(false)
  })
})
