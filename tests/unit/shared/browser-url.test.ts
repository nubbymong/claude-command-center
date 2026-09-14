/**
 * The browser pane's one rule for what it will load (item 26). Shared by the
 * address bar, the "Open a page" command kind, the command dialog and main's
 * IPC gate, so it is tested once, here, against the cases that matter: what
 * someone actually types, and what an attacker would.
 */
import { describe, it, expect } from 'vitest'
import { isAllowedBrowserUrl, normaliseBrowserInput, isLocalNetworkHost, shortUrlLabel, BROWSER_URL_MAX_LENGTH } from '../../../src/shared/browser-url'

describe('isAllowedBrowserUrl -- the gate main applies', () => {
  it('accepts http and https', () => {
    expect(isAllowedBrowserUrl('http://localhost:5173/')).toBe(true)
    expect(isAllowedBrowserUrl('https://example.com/docs?x=1#y')).toBe(true)
  })
  it('refuses every other scheme, by name and by trick', () => {
    for (const bad of [
      'file:///C:/Windows/win.ini',
      'javascript:alert(1)',
      'chrome://settings',
      'about:blank',
      'data:text/html,<script>alert(1)</script>',
      'ftp://example.com/',
      'ms-word:ofe|u|https://x',
      'http//example.com',
      'example.com',
      '',
    ]) {
      expect(isAllowedBrowserUrl(bad), bad).toBe(false)
    }
  })
  it('tolerates what the WHATWG parser tolerates (leading whitespace is stripped, not a second scheme)', () => {
    // Documented so nobody "fixes" it: Chromium's loadURL trims the same way,
    // so a leading space cannot smuggle a different scheme past the gate.
    expect(isAllowedBrowserUrl(' http://example.com')).toBe(true)
    expect(isAllowedBrowserUrl(' javascript:alert(1)')).toBe(false)
  })
  it('refuses non-strings and over-long strings', () => {
    expect(isAllowedBrowserUrl(undefined)).toBe(false)
    expect(isAllowedBrowserUrl(null)).toBe(false)
    expect(isAllowedBrowserUrl(42)).toBe(false)
    expect(isAllowedBrowserUrl({ toString: () => 'https://x' })).toBe(false)
    expect(isAllowedBrowserUrl('https://a.b/' + 'x'.repeat(BROWSER_URL_MAX_LENGTH))).toBe(false)
  })
  it('is case-insensitive on the scheme the way the URL parser is', () => {
    // WHATWG lower-cases the scheme; "HTTPS://" is https.
    expect(isAllowedBrowserUrl('HTTPS://Example.com/')).toBe(true)
  })
})

describe('normaliseBrowserInput -- what someone types in the address bar', () => {
  const ok = (raw: string) => {
    const r = normaliseBrowserInput(raw)
    if (!r.ok) throw new Error(`expected ok for ${JSON.stringify(raw)}, got ${r.error}`)
    return r.url
  }
  const err = (raw: string) => {
    const r = normaliseBrowserInput(raw)
    if (r.ok) throw new Error(`expected error for ${JSON.stringify(raw)}, got ${r.url}`)
    return r.error
  }

  it('keeps a full http(s) URL, normalised', () => {
    expect(ok('https://example.com')).toBe('https://example.com/')
    expect(ok('  http://localhost:3000/app  ')).toBe('http://localhost:3000/app')
    expect(ok('HTTP://LocalHost:3000')).toBe('http://localhost:3000/')
  })
  it('gives a scheme-less LOCAL address http -- the dev servers the pane is for', () => {
    expect(ok('localhost:5173')).toBe('http://localhost:5173/')
    expect(ok('localhost')).toBe('http://localhost/')
    expect(ok('127.0.0.1:8080/path')).toBe('http://127.0.0.1:8080/path')
    expect(ok('192.168.1.20:3000')).toBe('http://192.168.1.20:3000/')
    expect(ok('10.0.0.5')).toBe('http://10.0.0.5/')
    expect(ok('172.20.0.1:9000')).toBe('http://172.20.0.1:9000/')
    expect(ok('app.localhost:4000')).toBe('http://app.localhost:4000/')
    expect(ok('[::1]:5173')).toBe('http://[::1]:5173/')
  })
  it('repairs the dropped-colon typo instead of inventing a host called "http"', () => {
    expect(ok('http//example.com')).toBe('http://example.com/')
    expect(ok('HTTPS//example.com/x')).toBe('https://example.com/x')
    expect(ok('http//localhost:5173')).toBe('http://localhost:5173/')
  })
  it('gives a scheme-less PUBLIC address https', () => {
    expect(ok('example.com')).toBe('https://example.com/')
    expect(ok('docs.example.com/guide?x=1')).toBe('https://docs.example.com/guide?x=1')
    expect(ok('//example.com')).toBe('https://example.com/')
    expect(ok('8.8.8.8')).toBe('https://8.8.8.8/')
    expect(ok('172.32.0.1')).toBe('https://172.32.0.1/') // just outside the private /12
  })
  it('refuses other schemes BY NAME so the reason is on screen', () => {
    expect(err('javascript:alert(1)')).toMatch(/not javascript/)
    expect(err('file:///etc/passwd')).toMatch(/not file/)
    expect(err('chrome://settings')).toMatch(/not chrome/)
    expect(err('about:blank')).toMatch(/not about/)
    expect(err('data:text/html,hi')).toMatch(/not data/)
    expect(err('C:\\Users\\me')).toMatch(/Only http and https/)
  })
  it('refuses the empty, the too long, and the host-less', () => {
    expect(err('')).toBe('Type an address')
    expect(err('   ')).toBe('Type an address')
    expect(err('https://' + 'a'.repeat(BROWSER_URL_MAX_LENGTH))).toMatch(/too long/)
    expect(err('http://')).toMatch(/not an address|no host/)
    // `https:///path` is NOT host-less to the WHATWG parser (special schemes
    // collapse the slashes and take `path` as the host). Recorded, not fought.
    expect(ok('https:///path')).toBe('https://path/')
  })
  it('every accepted result passes the main-process gate (the two cannot drift)', () => {
    for (const raw of ['localhost:5173', 'example.com', 'https://x.y/z', 'HTTP://a.b', '10.1.2.3:80', '//q.r']) {
      expect(isAllowedBrowserUrl(ok(raw)), raw).toBe(true)
    }
  })
})

describe('isLocalNetworkHost', () => {
  it('loopback, .localhost, and the three private ranges', () => {
    for (const h of ['localhost', 'LOCALHOST', 'x.localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '10.9.8.7', '192.168.0.1', '172.16.0.1', '172.31.255.255']) {
      expect(isLocalNetworkHost(h), h).toBe(true)
    }
  })
  it('nothing else', () => {
    for (const h of ['example.com', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', 'localhost.evil.com']) {
      expect(isLocalNetworkHost(h), h).toBe(false)
    }
  })
})

describe('shortUrlLabel', () => {
  it('host plus trimmed path', () => {
    expect(shortUrlLabel('https://example.com/')).toBe('example.com')
    expect(shortUrlLabel('http://localhost:5173/docs/')).toBe('localhost:5173/docs')
    expect(shortUrlLabel('not a url')).toBe('not a url')
  })
})

// ── Re-attack round (beta.16 pass): canonical-host classification, credentials,
// the href-measured cap, and the page-navigation gate that must stay scheme-only.
import { isAllowedBrowserScheme, cleanDisplayText } from '../../../src/shared/browser-url'

describe('isAllowedBrowserScheme -- the gate for navigations the PAGE starts', () => {
  it('is scheme-only: an http(s) URL longer than the app cap passes (an OAuth hop must not be cancelled)', () => {
    const long = 'https://login.example/authorize?state=' + 'x'.repeat(BROWSER_URL_MAX_LENGTH + 2000)
    expect(isAllowedBrowserScheme(long)).toBe(true)
    expect(isAllowedBrowserUrl(long)).toBe(false)
  })
  it('still refuses every other scheme', () => {
    for (const bad of ['file:///x', 'javascript:1', 'JAVASCRIPT:1', 'data:,x', 'chrome://gpu', 'about:blank', '', 'not a url']) {
      expect(isAllowedBrowserScheme(bad), bad).toBe(false)
    }
  })
})

describe('embedded credentials are refused by every app-side door', () => {
  it('isAllowedBrowserUrl refuses user:pass@host', () => {
    expect(isAllowedBrowserUrl('http://user:pw@example.com/')).toBe(false)
    expect(isAllowedBrowserUrl('https://user@example.com/')).toBe(false)
    expect(isAllowedBrowserUrl('https://example.com/?u=user:pw@x')).toBe(true)
  })
  it('normaliseBrowserInput says why', () => {
    const r = normaliseBrowserInput('https://user:pw@example.com/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/user name or password/)
  })
})

describe('the http/https decision is made on the CANONICAL host, not the typed text', () => {
  it('loopback spelt any way the URL parser accepts gets http', () => {
    for (const [typed, want] of [
      ['127.1:3000', 'http://127.0.0.1:3000/'],
      ['0x7f000001', 'http://127.0.0.1/'],
      ['0177.0.0.1', 'http://127.0.0.1/'],
      ['2130706433', 'http://127.0.0.1/'],
      ['localhost.', 'http://localhost./'],
      ['[::ffff:127.0.0.1]:8080', 'http://[::ffff:7f00:1]:8080/'],
    ] as const) {
      const r = normaliseBrowserInput(typed)
      expect(r, typed).toEqual({ ok: true, url: want })
    }
  })
  it('a leading-zero octet that the parser reads as OCTAL is a public host and gets https', () => {
    // 010.0.0.1 is 8.0.0.1 to the URL parser -- not a 10/8 address.
    expect(normaliseBrowserInput('010.0.0.1')).toEqual({ ok: true, url: 'https://8.0.0.1/' })
    expect(normaliseBrowserInput('010.010.010.010')).toEqual({ ok: true, url: 'https://8.8.8.8/' })
  })
  it('a private host keeps its port through the re-parse', () => {
    expect(normaliseBrowserInput('192.168.1.20:443')).toEqual({ ok: true, url: 'http://192.168.1.20:443/' })
    expect(normaliseBrowserInput('10.0.0.5')).toEqual({ ok: true, url: 'http://10.0.0.5/' })
  })
  it('isLocalNetworkHost handles the canonical forms', () => {
    expect(isLocalNetworkHost('localhost.')).toBe(true)
    expect(isLocalNetworkHost('[::ffff:127.0.0.1]')).toBe(true)
    expect(isLocalNetworkHost('8.0.0.1')).toBe(false)
    expect(isLocalNetworkHost('10.0.0.1.evil.com')).toBe(false)
  })
})

describe('the length cap is measured on the serialised href', () => {
  it('a short typed path of multibyte characters that serialises past the cap is refused, not silently dropped later', () => {
    const typed = 'https://example.com/' + 'é'.repeat(2000) // 2020 chars typed, ~12k chars as href
    const r = normaliseBrowserInput(typed)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/too long/)
    expect(isAllowedBrowserUrl(new URL(typed).href)).toBe(false)
  })
})

describe('cleanDisplayText -- what the favourites bar renders', () => {
  it('strips controls, bidi overrides, zero-width and line breaks, and bounds the length', () => {
    const dirty = 'Pay\u202Eelif.exe\u200B\nnow\uFEFF'
    expect(cleanDisplayText(dirty, 200)).toBe('Payelif.exenow')
    expect(cleanDisplayText('x'.repeat(500), 200)).toHaveLength(200)
    expect(cleanDisplayText(42, 10)).toBe('')
    expect(cleanDisplayText('café \u{1F511}', 10)).toBe('café \u{1F511}')
  })
})
