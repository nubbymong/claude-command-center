// #216 — which CDP target the sign-in poller asks "who is signed in?".
//
// THE BUG THIS PINS. chrome-remote-interface connects to the FIRST page target
// it is offered. On a real sign-in that is not the tab the human is using, so
// the poller bound to the wrong page, never rebound when that page went away,
// and returned null for the whole five minutes: the user logged in successfully
// and nothing was harvested, with no error logged anywhere.
//
// The fixture below is the ACTUAL target list captured from a sign-in launch on
// 2026-08-08 (Edge, managed workstation), trimmed of query strings that do not
// matter here. Its ordering is the point: the extension's own OAuth page sorts
// first, ahead of both real tabs.
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('../../src/main/vision-manager', () => ({ getBrowserPaths: () => [] }))
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('node:fs', () => ({
  existsSync: () => false, readFileSync: () => '', readdirSync: () => [], rmSync: vi.fn(),
}))

const { pickSignInTargets } = await import('../../src/main/account-web/sign-in')

const EXTENSION_OAUTH = {
  type: 'page',
  url: 'https://claude.ai/oauth/authorize?client_id=dae2cad8&response_type=code&redirect_uri=chrome-extension%3A%2F%2Ffcoeoabgfenejglbffodgkkbkcdhcgfn%2Foauth_callback.html&state=x',
  id: 'ext-1',
}
const LOGIN = { type: 'page', url: 'https://claude.ai/login', id: 'login-1' }
const SELECT_ACCOUNT = { type: 'page', url: 'https://claude.ai/selectAccount', id: 'sel-1' }

/** As captured: the extension page is FIRST, both human tabs come later. */
const REAL_TARGETS = [
  EXTENSION_OAUTH,
  { type: 'background_page', url: 'chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/offscreen.html' },
  { type: 'background_page', url: 'chrome-extension://nkeimhogjdpnpccoofpliimaahmaaome/background.html' },
  LOGIN,
  SELECT_ACCOUNT,
  { type: 'iframe', url: 'https://newassets.hcaptcha.com/captcha/v1/static/hcaptcha.html' },
  { type: 'service_worker', url: 'chrome-extension://lfochlioelphaglamdcakfjemolpichk/javascript/BG.js' },
]

describe('pickSignInTargets', () => {
  it('puts the human’s tabs ahead of an extension’s own OAuth page', () => {
    const picked = pickSignInTargets(REAL_TARGETS)
    expect(picked.map((t) => t.id)).toEqual(['login-1', 'sel-1', 'ext-1'])
  })

  it('keeps the extension page as a candidate rather than dropping it', () => {
    // It is same-origin claude.ai and a session there is a real session. It is
    // deprioritised because it is transient, not because it is wrong — and the
    // caller tries every candidate, so no single guess has to be right.
    expect(pickSignInTargets([EXTENSION_OAUTH])).toHaveLength(1)
  })

  it('ignores everything that is not a claude.ai page', () => {
    // Background pages, service workers, iframes and other origins are all
    // dropped: an origin-relative fetch only means what we think on claude.ai.
    const picked = pickSignInTargets(REAL_TARGETS)
    expect(picked.every((t) => t.type === 'page')).toBe(true)
    expect(picked.some((t) => String(t.url).includes('hcaptcha'))).toBe(false)
  })

  it('refuses a look-alike host', () => {
    const evil = [
      { type: 'page', url: 'https://claude.ai.attacker.test/login', id: 'a' },
      { type: 'page', url: 'https://notclaude.ai/login', id: 'b' },
      { type: 'page', url: 'https://evil.test/?x=https://claude.ai/', id: 'c' },
    ]
    expect(pickSignInTargets(evil)).toEqual([])
  })

  it('accepts www.claude.ai, which is the same site', () => {
    const t = { type: 'page', url: 'https://www.claude.ai/', id: 'w' }
    expect(pickSignInTargets([t]).map((x) => x.id)).toEqual(['w'])
  })

  it('survives junk instead of a target list', () => {
    expect(pickSignInTargets(null)).toEqual([])
    expect(pickSignInTargets(undefined)).toEqual([])
    expect(pickSignInTargets([])).toEqual([])
    expect(pickSignInTargets([{}, { type: 'page' }, { url: 'https://claude.ai/' }] as never)).toEqual([])
  })
})
