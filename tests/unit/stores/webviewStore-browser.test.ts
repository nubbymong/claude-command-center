/**
 * webviewStore, the browser-pane half (item 26): the pane has a URL it was
 * ASKED to show and a page main says it is ON, and the command watch may tint
 * the button but must not yank the pane away from a page the user chose.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useWebviewStore } from '../../../src/renderer/stores/webviewStore'

const S = () => useWebviewStore.getState()
const of = (id: string) => S().bySessionId[id]

beforeEach(() => useWebviewStore.setState({ bySessionId: {} }))

describe('navigate', () => {
  it('points the pane at the url AND opens it', () => {
    S().navigate('s1', 'http://localhost:5173/')
    expect(of('s1').currentUrl).toBe('http://localhost:5173/')
    expect(of('s1').isOpen).toBe(true)
    // The watch is untouched: nothing is being watched.
    expect(of('s1').status).toBe('idle')
    expect(of('s1').watchUrl).toBeNull()
  })
  it('replaces the requested url on a second call', () => {
    S().navigate('s1', 'http://a/')
    S().navigate('s1', 'http://b/')
    expect(of('s1').currentUrl).toBe('http://b/')
  })
})

describe('the watch and the pane', () => {
  it('startActivation (a command the user pressed) points the pane at the watched url', () => {
    S().navigate('s1', 'http://docs/')
    S().startActivation('s1', 'http://localhost:3000/')
    expect(of('s1').watchUrl).toBe('http://localhost:3000/')
    expect(of('s1').currentUrl).toBe('http://localhost:3000/')
    expect(of('s1').status).toBe('pending')
  })
  it('markAvailable on a pane showing NOTHING points it at the url (old behaviour kept)', () => {
    S().markAvailable('s1', 'http://localhost:3000/')
    expect(of('s1').currentUrl).toBe('http://localhost:3000/')
    expect(of('s1').watchUrl).toBe('http://localhost:3000/')
    expect(of('s1').status).toBe('available')
  })
  it('markAvailable on a pane showing a page the user chose does NOT move it -- only the tint changes', () => {
    S().navigate('s1', 'http://docs/')
    S().markAvailable('s1', 'http://localhost:3000/')
    expect(of('s1').currentUrl).toBe('http://docs/')
    expect(of('s1').watchUrl).toBe('http://localhost:3000/')
    expect(of('s1').status).toBe('available')
  })
  it('markFailed leaves the pane where it is', () => {
    S().navigate('s1', 'http://docs/')
    S().startActivation('s1', 'http://x/')
    S().navigate('s1', 'http://docs/')
    S().markFailed('s1')
    expect(of('s1').currentUrl).toBe('http://docs/')
    expect(of('s1').status).toBe('failed')
  })
})

describe('setPage -- what main reports', () => {
  it('records the real url, title, history flags and loading for a known session', () => {
    S().navigate('s1', 'http://a/')
    S().setPage({ sessionId: 's1', url: 'http://a/landed', title: 'A', canGoBack: true, canGoForward: false, loading: false })
    expect(of('s1').page).toEqual({ url: 'http://a/landed', title: 'A', canGoBack: true, canGoForward: false, loading: false })
    // The requested url is NOT rewritten by a report; the address bar reads page.url.
    expect(of('s1').currentUrl).toBe('http://a/')
  })
  it('ignores a report for a session that has no pane state (a stale event from a torn-down view)', () => {
    S().setPage({ sessionId: 'ghost', url: 'http://x/', title: '', canGoBack: false, canGoForward: false, loading: false })
    expect(of('ghost')).toBeUndefined()
  })
})

describe('home, close-all, reset', () => {
  it('setHomeUrl is per session and not a navigation', () => {
    S().setHomeUrl('s1', 'http://home/')
    expect(of('s1').homeUrl).toBe('http://home/')
    expect(of('s1').isOpen).toBe(false)
    expect(of('s1').currentUrl).toBeNull()
    S().setHomeUrl('s1', null)
    expect(of('s1').homeUrl).toBeNull()
  })
  it('closeAllPanes closes every pane but keeps where each was', () => {
    S().navigate('s1', 'http://a/')
    S().navigate('s2', 'http://b/')
    S().closeAllPanes()
    expect(of('s1').isOpen).toBe(false)
    expect(of('s2').isOpen).toBe(false)
    expect(of('s1').currentUrl).toBe('http://a/')
    expect(of('s2').currentUrl).toBe('http://b/')
  })
  it('reset forgets the session entirely', () => {
    S().navigate('s1', 'http://a/')
    S().reset('s1')
    expect(of('s1')).toBeUndefined()
  })
})
