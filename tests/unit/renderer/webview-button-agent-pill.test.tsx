// @vitest-environment jsdom
/**
 * The Browser tool's agent-push notification pill (open_in_app_browser). The
 * pill appears when the store carries an unread push. Clicking the button
 * while the pane is CLOSED consumes it — loads the pushed page and opens the
 * pane. It never yanks a page the user is already viewing (the push alone
 * navigates nothing). And a click that CLOSES an already-open pane must NOT
 * consume the pill or navigate to the agent URL: closing is not "view it".
 * The pill stays raised so the next open can act on it.
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

  it('never-yank: pushing a page while one is open does not navigate or open on its own', () => {
    act(() => {
      useWebviewStore.getState().navigate('s1', 'https://user-here.test/')
      useWebviewStore.getState().pushAgentUrl('s1', 'https://agent.test/')
    })
    render()
    // The push raised the pill but left the viewed page and the open pane
    // exactly as they were — the page loads only when the user acts on it.
    expect(pill()).not.toBeNull()
    const st = useWebviewStore.getState().bySessionId['s1']
    expect(st.currentUrl).toBe('https://user-here.test/')
    expect(st.isOpen).toBe(true)
    expect(st.pendingAgentUrl).toBe('https://agent.test/')
    expect(st.unread).toBe(true)
  })

  it('pane OPEN + unread: a click CLOSES the pane and must NOT navigate to the pushed URL or consume the pill', () => {
    act(() => {
      useWebviewStore.getState().navigate('s1', 'https://user-here.test/')  // opens the pane on the user's page
      useWebviewStore.getState().pushAgentUrl('s1', 'https://agent.test/')  // pill raised, page still the user's
    })
    // Spy AFTER setup, BEFORE render, so the button captures the spies. On a
    // close click neither may fire — that is the whole precedence fix.
    const navigateSpy = vi.spyOn(useWebviewStore.getState(), 'navigate')
    const consumeSpy = vi.spyOn(useWebviewStore.getState(), 'consumeAgentPush')
    try {
      render()
      // While open the button is the CLOSE affordance — its tooltip must not
      // promise "view it"; a click here goes back to the terminal.
      expect(btn().title).toContain('terminal')
      expect(btn().title).not.toContain('click to view it')
      // The queued page is LABELLED: two bare URLs (pending + current) with
      // nothing saying which is which was the rc.13 tooltip nit.
      expect(btn().title).toContain('Waiting: https://agent.test/')

      act(() => { btn().click() })

      const st = useWebviewStore.getState().bySessionId['s1']
      // The close never navigates the pane to the agent URL — the key invariant.
      expect(st.currentUrl).toBe('https://user-here.test/')
      expect(st.isOpen).toBe(false)                  // the click closed the pane
      // The pill is untouched: it stays raised for the next open.
      expect(st.unread).toBe(true)
      expect(st.pendingAgentUrl).toBe('https://agent.test/')
      expect(pill()).not.toBeNull()
      expect(btn().getAttribute('data-agent-unread')).toBe('1')
      // Mutation-check: reverting the `!isOpen` guard would fire both of these.
      expect(navigateSpy).not.toHaveBeenCalled()
      expect(consumeSpy).not.toHaveBeenCalled()
    } finally {
      // A failing expect must not leak the spies into later tests.
      navigateSpy.mockRestore()
      consumeSpy.mockRestore()
    }
  })

  it('the raised pill stays actionable: after closing, the next click (pane now CLOSED) opens + navigates + consumes', () => {
    act(() => {
      useWebviewStore.getState().navigate('s1', 'https://user-here.test/')
      useWebviewStore.getState().pushAgentUrl('s1', 'https://agent.test/')
    })
    render()
    act(() => { btn().click() })   // pane was OPEN -> this closes it; pill stays raised
    expect(useWebviewStore.getState().bySessionId['s1'].isOpen).toBe(false)
    expect(useWebviewStore.getState().bySessionId['s1'].unread).toBe(true)
    act(() => { btn().click() })   // pane now CLOSED + unread -> open + navigate + consume
    const st = useWebviewStore.getState().bySessionId['s1']
    expect(st.currentUrl).toBe('https://agent.test/')
    expect(st.isOpen).toBe(true)
    expect(st.unread).toBe(false)
    expect(st.pendingAgentUrl).toBeNull()
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
