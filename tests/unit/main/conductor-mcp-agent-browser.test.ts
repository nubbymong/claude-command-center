/**
 * open_in_app_browser (the agent → USER in-app browser push). `decideAgentBrowserPush`
 * is the pure decision the MCP tool delegates to: the http/https scheme gate and
 * the session-authorisation gate, both fail-closed. Pinned here without an
 * http.Server or a live window.
 *
 * Mutation guard: replace `isAllowedBrowserUrl(url)` with `true` (allow-all) and
 * the "REJECTS every non-http(s) scheme" case fails — the reject tests are what
 * hold the scheme validator honest.
 */
import { describe, it, expect } from 'vitest'
import { decideAgentBrowserPush } from '../../../src/main/conductor-mcp-server'

const S = 'sess-abc'

describe('decideAgentBrowserPush — scheme gate', () => {
  it('accepts http and https, returning the authed session and the normalised href', () => {
    for (const url of ['https://example.com/pr/1', 'http://localhost:5173/', 'https://a.test/x?y=1#z']) {
      const d = decideAgentBrowserPush(S, url, undefined)
      expect(d.ok, url).toBe(true)
      if (d.ok) {
        expect(d.sessionId).toBe(S)
        expect(d.url).toBe(new URL(url).href)
      }
    }
  })

  it('REJECTS every non-http(s) scheme (allow-all mutation would fail this)', () => {
    const bad = [
      'file:///C:/Windows/win.ini',
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'about:blank',
      'chrome://settings',
      'devtools://devtools',
      'blob:https://x/y',
      'ms-msdt:/id x',
      'vbscript:msgbox',
    ]
    for (const url of bad) {
      expect(decideAgentBrowserPush(S, url, undefined).ok, url).toBe(false)
    }
  })

  it('rejects a non-URL, empty, or non-string url', () => {
    for (const url of ['', '   ', 'not a url', 'http://', undefined, null, 42, {}]) {
      expect(decideAgentBrowserPush(S, url as unknown, undefined).ok).toBe(false)
    }
  })

  it('rejects a URL that carries embedded credentials', () => {
    expect(decideAgentBrowserPush(S, 'https://user:pass@example.com/', undefined).ok).toBe(false)
  })

  it('rejects a URL longer than the shared length cap', () => {
    expect(decideAgentBrowserPush(S, 'https://example.com/' + 'a'.repeat(5000), undefined).ok).toBe(false)
  })

  it('normalises the href — scheme + host lower-cased, canonical form', () => {
    const d = decideAgentBrowserPush(S, 'HTTP://Example.COM/Path', undefined)
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.url).toBe('http://example.com/Path')
  })
})

describe('decideAgentBrowserPush — session authorisation', () => {
  it('defaults to the authenticated session when no sessionId is supplied', () => {
    const d = decideAgentBrowserPush(S, 'https://example.com/', undefined)
    expect(d.ok && d.sessionId).toBe(S)
  })

  it('accepts a supplied sessionId ONLY when it names the authenticated session', () => {
    expect(decideAgentBrowserPush(S, 'https://example.com/', S).ok).toBe(true)
    const d = decideAgentBrowserPush(S, 'https://example.com/', 'someone-elses-session')
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.error).toMatch(/authenticated session/i)
  })

  it('fails closed when there is no authenticated session', () => {
    expect(decideAgentBrowserPush('', 'https://example.com/', undefined).ok).toBe(false)
    // Even a "matching" empty supplied id must not authorise an empty session.
    expect(decideAgentBrowserPush('', 'https://example.com/', '').ok).toBe(false)
  })
})
