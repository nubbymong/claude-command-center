// @vitest-environment jsdom
/**
 * The Browser button is always there (item 26). It used to exist only once
 * some command carried a URL, and then sat disabled until a watch fired, so
 * the feature was invisible until you had already found it.
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

const render = (props: Record<string, unknown> = {}) => {
  act(() => { root.render(React.createElement(WebviewButton, { sessionId: 's1', ...props } as never)) })
}
const btn = () => container.querySelector('[data-testid="browser-toggle"]') as HTMLButtonElement

describe('always rendered, always clickable', () => {
  it('renders with no webview command at all, reads "Browser", is enabled, shows no status dot', () => {
    render()
    expect(btn()).not.toBeNull()
    expect(btn().querySelector('[data-testid="reserved-label-current"]')!.textContent).toBe('Browser')
    expect(btn().disabled).toBe(false)
    expect(btn().getAttribute('data-watch-status')).toBe('idle')
    expect(btn().querySelector('span.rounded-full')).toBeNull()
  })
  it('the old hasWebviewCommand=false prop no longer hides it', () => {
    render({ hasWebviewCommand: false })
    expect(btn()).not.toBeNull()
  })
  it('click opens the pane and names the way back; a second click closes it', () => {
    render()
    act(() => { btn().click() })
    expect(useWebviewStore.getState().bySessionId['s1'].isOpen).toBe(true)
    expect(btn().querySelector('[data-testid="reserved-label-current"]')!.textContent).toBe('Terminal')
    act(() => { btn().click() })
    expect(useWebviewStore.getState().bySessionId['s1'].isOpen).toBe(false)
    expect(btn().querySelector('[data-testid="reserved-label-current"]')!.textContent).toBe('Browser')
  })
  it('records webview.opened on OPEN only (closing is not discovering it)', () => {
    render()
    act(() => { btn().click() })
    act(() => { btn().click() })
    act(() => { btn().click() })
    expect(trackUsage.mock.calls.filter((c) => c[0] === 'webview.opened')).toHaveLength(2)
  })
})

describe('a live watch tints it', () => {
  it.each([
    ['pending', true],
    ['available', true],
    ['failed', true],
  ] as const)('%s shows the status and a dot', (status) => {
    act(() => {
      useWebviewStore.getState().startActivation('s1', 'http://localhost:3000/')
      if (status === 'available') useWebviewStore.getState().markAvailable('s1', 'http://localhost:3000/')
      if (status === 'failed') useWebviewStore.getState().markFailed('s1')
    })
    render()
    expect(btn().getAttribute('data-watch-status')).toBe(status)
    expect(btn().querySelector('span.rounded-full')).not.toBeNull()
    expect(btn().title).toContain('http://localhost:3000/')
  })
})
