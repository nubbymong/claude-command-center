// #439/#475 — the pane's account surface: the sign-in-mode setting in the
// store, and the pure navigation policy that keeps a session-bearing view
// from roaming.
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** In-memory stand-in for the JSON file (same harness as the auth-browser tests). */
const fake = { disk: null as unknown }

vi.mock('../../src/main/channel-storage', () => ({
  readJsonFile: (_n: string, seed: () => unknown) => (fake.disk ?? seed()),
  writeJsonFile: (_n: string, v: unknown) => { fake.disk = JSON.parse(JSON.stringify(v)) },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

const {
  DEFAULT_WEB_SIGN_IN_MODE,
  WEB_SIGN_IN_MODES,
  WEB_SIGN_IN_MODE_LABELS,
  isWebSignInMode,
} = await import('../../src/shared/account-web-session')

const {
  getWebSignInMode,
  setWebSignInMode,
  getAuthBrowser,
  setAuthBrowser,
  setAuthMethod,
  getAuthMethod,
} = await import('../../src/main/account-web/session-store')

const { accountPaneNavDecision, isClaudePaneUrl, ACCOUNT_PANE_START_URL } = await import('../../src/main/account-web/account-pane')

const A = 'profile-aaa111'

beforeEach(() => { fake.disk = null })

describe('isWebSignInMode — the guard on a value that routes a credential flow', () => {
  it('accepts exactly the two modes, with auto the default (today\u2019s flow, unchanged)', () => {
    expect(isWebSignInMode('auto')).toBe(true)
    expect(isWebSignInMode('internal-pane')).toBe(true)
    expect(WEB_SIGN_IN_MODES).toEqual(['auto', 'internal-pane'])
    expect(DEFAULT_WEB_SIGN_IN_MODE).toBe('auto')
    expect(Object.keys(WEB_SIGN_IN_MODE_LABELS).sort()).toEqual(['auto', 'internal-pane'])
  })

  it('rejects anything else', () => {
    for (const bad of ['external', 'in-app', 'pane', '', null, 3, {}]) {
      expect(isWebSignInMode(bad)).toBe(false)
    }
  })
})

describe('the per-account sign-in mode in the store', () => {
  it('is auto until the account says otherwise', () => {
    expect(getWebSignInMode(A)).toBe('auto')
  })

  it('round-trips a choice, per account', () => {
    setWebSignInMode(A, 'internal-pane')
    expect(getWebSignInMode(A)).toBe('internal-pane')
    expect(getWebSignInMode('profile-bbb222')).toBe('auto')
  })

  it('refuses an unknown mode and falls back over junk on disk', () => {
    expect(() => setWebSignInMode(A, 'external' as never)).toThrow(/unknown web sign-in mode/)
    fake.disk = { schemaVersion: 4, sessions: [], authMethods: {}, authBrowsers: {}, webSignInModes: { [A]: 'nonsense' } }
    expect(getWebSignInMode(A)).toBe('auto')
  })

  it('migrates a v3 file: keeps sessions/methods/browsers, seeds empty modes', () => {
    fake.disk = {
      schemaVersion: 3,
      sessions: [{ profileId: A, accountEmail: 'a@x.y', acquiredAt: 1, expiresAt: null, origin: 'in-app' }],
      authMethods: { [A]: 'sso' },
      authBrowsers: { [A]: 'chrome' },
    }
    expect(getAuthMethod(A)).toBe('sso')
    expect(getAuthBrowser(A)).toBe('chrome')
    expect(getWebSignInMode(A)).toBe('auto')
    // A write after migration lands as v4 with everything intact.
    setWebSignInMode(A, 'internal-pane')
    const disk = fake.disk as { schemaVersion: number; authBrowsers: Record<string, string> }
    expect(disk.schemaVersion).toBe(4)
    expect(disk.authBrowsers[A]).toBe('chrome')
    expect(getWebSignInMode(A)).toBe('internal-pane')
  })
})

describe('accountPaneNavDecision — the session-bearing view does not roam', () => {
  it('always allows claude.ai over https, signed in or not', () => {
    for (const authed of [true, false]) {
      expect(accountPaneNavDecision('https://claude.ai/artifacts', authed)).toBe('allow')
      expect(accountPaneNavDecision('https://www.claude.ai/login', authed)).toBe('allow')
    }
    expect(accountPaneNavDecision(ACCOUNT_PANE_START_URL, false)).toBe('allow')
  })

  it('allows an https identity-provider hop ONLY before sign-in', () => {
    expect(accountPaneNavDecision('https://login.microsoftonline.com/x', false)).toBe('allow')
    expect(accountPaneNavDecision('https://login.microsoftonline.com/x', true)).toBe('external')
  })

  it('hands an off-claude.ai https link to the real browser once signed in', () => {
    expect(accountPaneNavDecision('https://example.com/paper', true)).toBe('external')
  })

  it('blocks every non-https target outright, either way', () => {
    for (const authed of [true, false]) {
      expect(accountPaneNavDecision('http://claude.ai/', authed)).toBe('block')
      expect(accountPaneNavDecision('file:///C:/secrets', authed)).toBe('block')
      expect(accountPaneNavDecision('javascript:alert(1)', authed)).toBe('block')
      expect(accountPaneNavDecision('chrome://settings', authed)).toBe('block')
      expect(accountPaneNavDecision('not a url', authed)).toBe('block')
    }
  })

  it('is not fooled by claude.ai as a prefix, userinfo, or subdomain', () => {
    expect(accountPaneNavDecision('https://claude.ai.evil.com/', false)).toBe('allow') // pre-auth IdP-hop rule
    expect(accountPaneNavDecision('https://claude.ai.evil.com/', true)).toBe('external')
    expect(accountPaneNavDecision('https://evil.com/claude.ai', true)).toBe('external')
    expect(accountPaneNavDecision('https://claude.ai@evil.com/', true)).toBe('external')
    expect(accountPaneNavDecision('https://api.claude.ai/', true)).toBe('external')
  })

  it('FAILS CLOSED on the unknown cookie state (authed=null): off-site is blocked, not roamed', () => {
    // The dangerous case the adversarial pass found: a failed/racing cookie read
    // leaves authed unknown, and "unknown" must NOT mean "signed out → allow".
    expect(accountPaneNavDecision('https://login.microsoftonline.com/x', null)).toBe('block')
    expect(accountPaneNavDecision('https://evil.example/steal', null)).toBe('block')
    // claude.ai itself is still allowed at any state (it is the surface).
    expect(accountPaneNavDecision('https://claude.ai/artifacts', null)).toBe('allow')
    // non-https still blocked at any state.
    expect(accountPaneNavDecision('http://claude.ai/', null)).toBe('block')
  })

  it('treats a claude.ai URL with an explicit port as NOT the service (off-site rules apply)', () => {
    expect(isClaudePaneUrl('https://claude.ai:8443/x')).toBe(false)
    expect(accountPaneNavDecision('https://claude.ai:8443/x', true)).toBe('external')
    expect(accountPaneNavDecision('https://claude.ai:8443/x', null)).toBe('block')
    // The default port (implicit) is the real service.
    expect(isClaudePaneUrl('https://claude.ai/artifacts')).toBe(true)
  })

  it('recognises the fully-qualified trailing-dot form as claude.ai (availability)', () => {
    expect(isClaudePaneUrl('https://claude.ai./artifacts')).toBe(true)
    expect(accountPaneNavDecision('https://claude.ai./artifacts', true)).toBe('allow')
    expect(accountPaneNavDecision('https://www.claude.ai./login', null)).toBe('allow')
  })
})
