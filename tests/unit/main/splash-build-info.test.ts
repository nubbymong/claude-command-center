// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { splashBuildQuery, SPLASH_BUILD_QUERY_KEY } from '../../../src/main/splash-info'
import { formatBuildIdentity } from '../../../src/shared/build-identity'

/**
 * #384 — the boot splash shows the build identity in clear text.
 *
 * Main hands the line over as the `build` query parameter of the file:// URL
 * (the page has a strict CSP: no inline script, no preload), and the static
 * page's splash-info.js prints it into #buildinfo. This drives the REAL
 * resources/splash/splash-info.js against a jsdom document carrying that
 * query, so the script that ships is the script under test.
 */
const repoRoot = join(__dirname, '../../..')
const splashDir = join(repoRoot, 'resources', 'splash')
const html = readFileSync(join(splashDir, 'index.html'), 'utf-8')
const infoScript = readFileSync(join(splashDir, 'splash-info.js'), 'utf-8')

function runSplashInfo(search: string): HTMLElement {
  document.body.innerHTML = '<div id="buildinfo" hidden></div>'
  window.history.replaceState(null, '', `/index.html${search}`)
  // The same classic-script evaluation the browser does for <script src>.
  // eslint-disable-next-line no-new-func
  new Function(infoScript)()
  return document.getElementById('buildinfo')!
}

describe('splashBuildQuery (main → splash URL) (#384)', () => {
  it('is the build identity line under the `build` key', () => {
    const q = splashBuildQuery({ version: '2.1.0-beta.17', sha: '3a1b2e2', buildTime: '2026-08-22T14:03:00Z' })
    expect(SPLASH_BUILD_QUERY_KEY).toBe('build')
    expect(q).toEqual({ build: 'v2.1.0-beta.17 · beta · build 3a1b2e2 · 2026-08-22' })
  })

  it('uses the SAME formatter as Settings → About (identical strings)', () => {
    const input = { version: '2.2.0-rc.1', sha: 'abcdef0', buildTime: '2026-09-01T00:00:00Z' }
    expect(splashBuildQuery(input).build).toBe(formatBuildIdentity(input))
  })

  it('a dev build still produces a line (never empty, never "undefined")', () => {
    const q = splashBuildQuery({ version: '2.1.0-beta.17' })
    expect(q.build).toBe('v2.1.0-beta.17 · beta · build dev')
    expect(q.build).not.toMatch(/undefined/)
  })
})

describe('resources/splash/index.html carries the build line slot (#384)', () => {
  it('has the #buildinfo element, hidden until the script fills it', () => {
    expect(html).toMatch(/<div id="buildinfo" hidden><\/div>/)
  })
  it('loads splash-info.js as a classic script BEFORE the three.js module', () => {
    const info = html.indexOf('<script src="./splash-info.js"></script>')
    const mod = html.indexOf('<script type="module" src="./splash.js"></script>')
    expect(info).toBeGreaterThan(-1)
    expect(mod).toBeGreaterThan(info)
  })
  it('styles the line small and muted (not part of the animated layers)', () => {
    expect(html).toMatch(/#buildinfo\{[^}]*position:fixed/)
    expect(html).toMatch(/#buildinfo\{[^}]*pointer-events:none/)
  })
  it('the CSP still forbids inline script (the line arrives via the URL, not an inline <script>)', () => {
    expect(html).not.toMatch(/script-src[^;"]*'unsafe-inline'/)
    expect(html).not.toMatch(/<script>/)
  })
})

describe('resources/splash/splash-info.js (#384)', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('prints the `build` query value into #buildinfo and un-hides it', () => {
    const line = 'v2.1.0-beta.17 · beta · build 3a1b2e2 · 2026-08-22'
    const el = runSplashInfo('?' + new URLSearchParams({ build: line }).toString())
    expect(el.textContent).toBe(line)
    expect(el.hasAttribute('hidden')).toBe(false)
  })

  it('round-trips the exact query main builds (Electron loadFile encodes the same way)', () => {
    const q = splashBuildQuery({ version: '2.1.0-beta.17', sha: '3a1b2e2', buildTime: '2026-08-22T14:03:00Z' })
    const el = runSplashInfo('?' + new URLSearchParams(q).toString())
    expect(el.textContent).toBe('v2.1.0-beta.17 · beta · build 3a1b2e2 · 2026-08-22')
  })

  it('treats the value as text, never markup', () => {
    const el = runSplashInfo('?' + new URLSearchParams({ build: '<img src=x onerror=alert(1)>' }).toString())
    expect(el.children.length).toBe(0)
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('stays hidden when there is no query (e.g. the page opened by hand)', () => {
    const el = runSplashInfo('')
    expect(el.textContent).toBe('')
    expect(el.hasAttribute('hidden')).toBe(true)
  })

  it('does nothing (and does not throw) when the slot is missing', () => {
    document.body.innerHTML = ''
    window.history.replaceState(null, '', '/index.html?build=x')
    // eslint-disable-next-line no-new-func
    expect(() => new Function(infoScript)()).not.toThrow()
  })
})
