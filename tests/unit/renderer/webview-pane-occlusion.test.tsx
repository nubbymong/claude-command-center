// @vitest-environment jsdom
/**
 * A native pane must hide whenever something is on top of the session area,
 * not only when its session stops being the active one.
 *
 * The 2026-09-05 report: artifacts opened in the in-app browser pane, then
 * Settings opened as a page tab -- and the artifacts view sat in front of
 * Settings, because the pane's visibility keyed off "is my session the active
 * session" alone, and opening a page tab does not change the active session.
 * The same held for the ordinary browser view and for any dialog or tour
 * over the session area. `paneOcclusionStore` is the one answer to "may a
 * native pane paint"; this file proves the pane obeys it on every path:
 * hide, re-show, and park-an-open-until-it-may-show.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: vi.fn(),
  saveConfigDebounced: vi.fn(),
}))
vi.mock('../../../src/renderer/components/ExcalidrawModal', () => ({ default: () => null }))
vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const state = () => ({ sessions: [{ id: 's1', configId: 'cfg1', sessionType: 'local' }] })
  const useSessionStore = (sel?: any) => (sel ? sel(state()) : state())
  useSessionStore.getState = state
  return { useSessionStore }
})

;(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
  x: 0, y: 0, left: 10, top: 20, width: 640, height: 480, right: 650, bottom: 500, toJSON: () => ({}),
} as DOMRect)

const api = (window as any).electronAPI.webview
api.onNavigated = vi.fn(() => () => {})
const acct = (window as any).electronAPI.accountWeb

const { default: WebviewPane } = await import('../../../src/renderer/components/WebviewPane')
const { useWebviewStore } = await import('../../../src/renderer/stores/webviewStore')
const { useBrowserStore } = await import('../../../src/renderer/stores/browserStore')
const { usePaneOcclusionStore } = await import('../../../src/renderer/stores/paneOcclusionStore')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  useWebviewStore.setState({ bySessionId: {} })
  useBrowserStore.setState({ favourites: [], homeByConfig: {}, isLoaded: true })
  usePaneOcclusionStore.setState({ activeView: 'sessions', overlays: 0 })
  for (const k of Object.keys(api)) if (typeof api[k]?.mockClear === 'function' && k !== 'onNavigated') api[k].mockClear()
  for (const k of Object.keys(acct)) if (typeof acct[k]?.mockClear === 'function') acct[k].mockClear()
  api.open.mockResolvedValue(true)
  api.navigate.mockResolvedValue(true)
  acct.paneOpen.mockResolvedValue({ ok: true })
  acct.paneGetState.mockResolvedValue({ ok: true, state: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})
afterAll(() => rectSpy.mockRestore())

const render = (props: Record<string, unknown> = {}) => {
  act(() => { root.render(React.createElement(WebviewPane, { sessionId: 's1', isActive: true, ...props } as never)) })
}
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 30)) }) }
const setView = (v: string) => act(() => { usePaneOcclusionStore.getState().setActiveView(v as never) })
const openPage = () => act(() => {
  useWebviewStore.getState().setOpen('s1', true)
  useWebviewStore.getState().navigate('s1', 'https://example.com/')
})
const lastVisible = () => api.setVisible.mock.calls.at(-1)?.[1]

describe('the ordinary browser view under a page tab or an overlay', () => {
  it('REGRESSION: opening Settings as a tab hides the view; coming back shows it', async () => {
    openPage()
    render()
    await flush()
    expect(api.open).toHaveBeenCalledTimes(1)
    expect(lastVisible()).toBe(true)

    setView('settings')
    await flush()
    expect(lastVisible()).toBe(false)

    setView('sessions')
    await flush()
    expect(lastVisible()).toBe(true)
  })

  it('a window-level overlay (dialog, tour) hides the view for exactly as long as it is held', async () => {
    openPage()
    render()
    await flush()
    expect(lastVisible()).toBe(true)

    let release: () => void = () => {}
    act(() => { release = usePaneOcclusionStore.getState().acquireOverlay() })
    await flush()
    expect(lastVisible()).toBe(false)

    act(() => { release() })
    await flush()
    expect(lastVisible()).toBe(true)
  })

  it('an open requested while a page tab is on top is PARKED, then runs when the tab goes', async () => {
    // The race the flag also closes: main attaches a freshly created view, so
    // creating it under Settings and hiding it a tick later would still flash
    // -- and could lose the hide entirely if the open resolves after it.
    setView('settings')
    openPage()
    render()
    await flush()
    expect(api.open).not.toHaveBeenCalled()

    setView('sessions')
    await flush()
    expect(api.open).toHaveBeenCalledTimes(1)
  })

  it('the session-level flag still rules: an inactive session stays hidden even on the sessions tab', async () => {
    openPage()
    render({ isActive: false })
    await flush()
    expect(api.open).not.toHaveBeenCalled()
  })
})

describe('the claude.ai account view (artifacts) under a page tab', () => {
  it('REGRESSION: the artifacts view hides under Settings and comes back with the session tab', async () => {
    act(() => {
      useWebviewStore.getState().setOpen('s1', true)
      useWebviewStore.getState().openAccountPane('s1', 'profile-aaa111')
    })
    render()
    await flush()
    expect(acct.paneOpen).toHaveBeenCalledTimes(1)
    const last = () => acct.paneVisible.mock.calls.at(-1)?.[0]?.visible
    expect(last()).toBe(true)

    setView('settings')
    await flush()
    expect(last()).toBe(false)

    setView('sessions')
    await flush()
    expect(last()).toBe(true)
  })

  it('an account open requested under a page tab is parked until the tab goes', async () => {
    setView('help')
    act(() => {
      useWebviewStore.getState().setOpen('s1', true)
      useWebviewStore.getState().openAccountPane('s1', 'profile-aaa111')
    })
    render()
    await flush()
    expect(acct.paneOpen).not.toHaveBeenCalled()

    setView('sessions')
    await flush()
    expect(acct.paneOpen).toHaveBeenCalledTimes(1)
  })
})
