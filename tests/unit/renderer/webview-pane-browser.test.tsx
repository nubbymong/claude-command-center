// @vitest-environment jsdom
/**
 * The browser pane (item 26): start page, address bar, history state from
 * main, favourites, home, open-externally, and the one-view-per-mount
 * lifecycle that makes Back actually work.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Persisted favourites/home go through config-saver; we only need to see the call.
const saveConfigNow = vi.fn()
vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: (...a: unknown[]) => saveConfigNow(...a),
  saveConfigDebounced: vi.fn(),
}))
vi.mock('../../../src/renderer/components/ExcalidrawModal', () => ({ default: () => null }))
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({ sessions: [{ id: 's1', configId: 'cfg1' }, { id: 's2' }] }),
}))

// jsdom has no ResizeObserver and lays nothing out.
;(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
  x: 0, y: 0, left: 10, top: 20, width: 640, height: 480, right: 650, bottom: 500, toJSON: () => ({}),
} as DOMRect)

let navHandler: ((s: any) => void) | null = null
const api = (window as any).electronAPI.webview
api.onNavigated = vi.fn((h: (s: any) => void) => { navHandler = h; return () => { navHandler = null } })

const { default: WebviewPane } = await import('../../../src/renderer/components/WebviewPane')
const { useWebviewStore } = await import('../../../src/renderer/stores/webviewStore')
const { useBrowserStore } = await import('../../../src/renderer/stores/browserStore')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  useWebviewStore.setState({ bySessionId: {} })
  useBrowserStore.setState({ favourites: [], homeByConfig: {}, isLoaded: true })
  for (const k of Object.keys(api)) if (typeof api[k]?.mockClear === 'function' && k !== 'onNavigated') api[k].mockClear()
  api.open.mockResolvedValue(true)
  api.navigate.mockResolvedValue(true)
  saveConfigNow.mockClear()
  navHandler = null
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
const byTest = <T extends Element = HTMLElement>(id: string) => container.querySelector(`[data-testid="${id}"]`) as T | null
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 30)) }) }
function type(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
const open = (sid = 's1') => act(() => { useWebviewStore.getState().setOpen(sid, true) })

describe('the start page', () => {
  it('shows when the pane is open with nothing loaded; no native view is created', async () => {
    open()
    render()
    await flush()
    expect(byTest('browser-start')).not.toBeNull()
    expect(byTest('browser-viewport')).toBeNull()
    expect(api.open).not.toHaveBeenCalled()
    expect(byTest('browser-start-address')).toBe(document.activeElement)
  })
  it('typing a scheme-less local address and submitting loads http://… and creates the view at the placeholder bounds', async () => {
    open()
    render()
    act(() => { type(byTest<HTMLInputElement>('browser-start-address')!, 'localhost:5173') })
    act(() => { byTest<HTMLButtonElement>('browser-start-go')!.click() })
    expect(useWebviewStore.getState().bySessionId['s1'].currentUrl).toBe('http://localhost:5173/')
    await flush()
    expect(byTest('browser-start')).toBeNull()
    expect(byTest('browser-viewport')).not.toBeNull()
    expect(api.open).toHaveBeenCalledWith('s1', 'http://localhost:5173/', { x: 10, y: 20, width: 640, height: 480 })
  })
  it('an address that is not http/https is refused by name and nothing loads', async () => {
    open()
    render()
    act(() => { type(byTest<HTMLInputElement>('browser-start-address')!, 'file:///C:/secrets') })
    act(() => { byTest<HTMLButtonElement>('browser-start-go')!.click() })
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/not file/)
    expect(useWebviewStore.getState().bySessionId['s1'].currentUrl).toBeNull()
    await flush()
    expect(api.open).not.toHaveBeenCalled()
  })
  it('a session whose config has a home goes there on open without being asked', async () => {
    useBrowserStore.getState().setHome('cfg1', 'http://localhost:4000/')
    open()
    render()
    await flush()
    expect(useWebviewStore.getState().bySessionId['s1'].currentUrl).toBe('http://localhost:4000/')
    expect(api.open).toHaveBeenCalledWith('s1', 'http://localhost:4000/', expect.anything())
  })
})

describe('with a page loaded', () => {
  const loaded = async () => {
    act(() => { useWebviewStore.getState().navigate('s1', 'http://localhost:5173/') })
    render()
    await flush()
    expect(api.open).toHaveBeenCalledTimes(1)
  }

  it('a second URL NAVIGATES the existing view instead of rebuilding it (history survives)', async () => {
    await loaded()
    act(() => { useWebviewStore.getState().navigate('s1', 'http://localhost:5173/about') })
    await flush()
    expect(api.navigate).toHaveBeenCalledWith('s1', 'http://localhost:5173/about')
    expect(api.open).toHaveBeenCalledTimes(1)
    expect(api.close).not.toHaveBeenCalled()
  })
  it('the address bar shows where main says the page IS, and Back enables from the report', async () => {
    await loaded()
    expect(byTest<HTMLInputElement>('browser-address')!.value).toBe('http://localhost:5173/')
    expect(byTest<HTMLButtonElement>('browser-back')!.disabled).toBe(true)
    act(() => { navHandler!({ sessionId: 's1', url: 'http://localhost:5173/landed', title: 'Landed', canGoBack: true, canGoForward: false, loading: false }) })
    expect(byTest<HTMLInputElement>('browser-address')!.value).toBe('http://localhost:5173/landed')
    expect(byTest<HTMLButtonElement>('browser-back')!.disabled).toBe(false)
    expect(byTest<HTMLButtonElement>('browser-forward')!.disabled).toBe(true)
    // A report for ANOTHER session is ignored.
    act(() => { navHandler!({ sessionId: 's2', url: 'http://other/', title: '', canGoBack: false, canGoForward: false, loading: false }) })
    expect(byTest<HTMLInputElement>('browser-address')!.value).toBe('http://localhost:5173/landed')
  })
  it('Enter in the address bar navigates; Escape reverts AND does not reach the document (the app-level Esc closes the pane)', async () => {
    await loaded()
    const addr = byTest<HTMLInputElement>('browser-address')!
    act(() => { addr.focus(); type(addr, 'example.com') })
    act(() => { key(addr, 'Enter') })
    expect(useWebviewStore.getState().bySessionId['s1'].currentUrl).toBe('https://example.com/')
    const docEsc = vi.fn()
    document.addEventListener('keydown', docEsc)
    act(() => { addr.focus(); type(addr, 'half typed') })
    act(() => { key(addr, 'Escape') })
    document.removeEventListener('keydown', docEsc)
    expect(docEsc).not.toHaveBeenCalled()
    expect(addr.value).toBe('https://example.com/')
  })
  it('a bad address shows the reason inline and leaves the page alone', async () => {
    await loaded()
    const addr = byTest<HTMLInputElement>('browser-address')!
    act(() => { addr.focus(); type(addr, 'javascript:alert(1)') })
    act(() => { key(addr, 'Enter') })
    expect(byTest('browser-address-error')?.textContent).toMatch(/not javascript/)
    expect(useWebviewStore.getState().bySessionId['s1'].currentUrl).toBe('http://localhost:5173/')
  })
  it('the star saves and unsaves the CURRENT page as a favourite, persisted now', async () => {
    await loaded()
    act(() => { navHandler!({ sessionId: 's1', url: 'http://localhost:5173/', title: 'Dev', canGoBack: false, canGoForward: false, loading: false }) })
    act(() => { byTest<HTMLButtonElement>('browser-star')!.click() })
    expect(useBrowserStore.getState().favourites).toEqual([expect.objectContaining({ url: 'http://localhost:5173/', title: 'Dev' })])
    expect(saveConfigNow).toHaveBeenCalledWith('browser', expect.anything())
    expect(byTest('browser-star')!.getAttribute('aria-pressed')).toBe('true')
    act(() => { byTest<HTMLButtonElement>('browser-star')!.click() })
    expect(useBrowserStore.getState().favourites).toEqual([])
  })
  it('the favourites bar lists them, opens one on click, and sets the home for THIS CONFIG', async () => {
    useBrowserStore.getState().addFavourite('https://docs.example.com/', 'Docs')
    await loaded()
    expect(byTest('browser-favourites-bar')).toBeNull()
    act(() => { byTest<HTMLButtonElement>('browser-favourites-toggle')!.click() })
    expect(byTest('browser-favourites-bar')).not.toBeNull()
    act(() => { byTest<HTMLButtonElement>('browser-favourite')!.click() })
    expect(useWebviewStore.getState().bySessionId['s1'].currentUrl).toBe('https://docs.example.com/')
    act(() => { navHandler!({ sessionId: 's1', url: 'https://docs.example.com/', title: 'Docs', canGoBack: true, canGoForward: false, loading: false }) })
    act(() => { byTest<HTMLButtonElement>('browser-set-home')!.click() })
    expect(useBrowserStore.getState().homeByConfig).toEqual({ cfg1: 'https://docs.example.com/' })
    expect(byTest('browser-home-chip')).not.toBeNull()
    // Home button is now live and goes there.
    act(() => { useWebviewStore.getState().navigate('s1', 'http://localhost:5173/') })
    act(() => { byTest<HTMLButtonElement>('browser-home')!.click() })
    expect(useWebviewStore.getState().bySessionId['s1'].currentUrl).toBe('https://docs.example.com/')
  })
  it('"open in your real browser" hands the SHOWN url to the IPC (main re-validates)', async () => {
    await loaded()
    act(() => { navHandler!({ sessionId: 's1', url: 'http://localhost:5173/real', title: '', canGoBack: false, canGoForward: false, loading: false }) })
    act(() => { byTest<HTMLButtonElement>('browser-open-external')!.click() })
    expect(api.openExternal).toHaveBeenCalledWith('http://localhost:5173/real')
  })
  it('a live watch shows its state beside the address', async () => {
    await loaded()
    expect(byTest('browser-watch')).toBeNull()
    act(() => { useWebviewStore.getState().startActivation('s1', 'http://localhost:3000/') })
    expect(byTest('browser-watch')!.textContent).toContain('waiting')
    act(() => { useWebviewStore.getState().markAvailable('s1', 'http://localhost:3000/') })
    expect(byTest('browser-watch')!.textContent).toContain('responding')
    act(() => { useWebviewStore.getState().markFailed('s1') })
    expect(byTest('browser-watch')!.textContent).toContain('no answer')
  })
  it('unmount destroys the view', async () => {
    await loaded()
    act(() => { root.unmount() })
    root = createRoot(container)
    expect(api.close).toHaveBeenCalledWith('s1')
  })
  it('a session-scoped home (no config) lives in the webview store, not on disk', async () => {
    act(() => { useWebviewStore.getState().navigate('s2', 'http://a/') })
    act(() => { root.render(React.createElement(WebviewPane, { sessionId: 's2', isActive: true } as never)) })
    await flush()
    act(() => { navHandler!({ sessionId: 's2', url: 'http://a/', title: '', canGoBack: false, canGoForward: false, loading: false }) })
    act(() => { byTest<HTMLButtonElement>('browser-favourites-toggle')!.click() })
    act(() => { byTest<HTMLButtonElement>('browser-set-home')!.click() })
    expect(useWebviewStore.getState().bySessionId['s2'].homeUrl).toBe('http://a/')
    expect(useBrowserStore.getState().homeByConfig).toEqual({})
  })
})
