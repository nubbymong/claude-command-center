// #216 — the per-account sign-in browser, and the store that remembers it.
//
// WHY THIS SETTING IS LOAD-BEARING. Measured on a managed workstation
// 2026-08-06: Chrome's policy force-installs `Microsoft Single Sign On`, but the
// sign-in runs in a FRESH profile by design and Chrome fetches force-installed
// extensions asynchronously — claude.ai loads before the extension exists and
// the SSO step fails. Edge does Entra SSO natively and completed the same login.
// So the browser is a user choice with an Edge default, and a wrong value here
// surfaces at the identity provider rather than in CCC.
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** In-memory stand-in for the JSON file, so a write is readable by the next read. */
const fake = { disk: null as unknown }

vi.mock('../../src/main/channel-storage', () => ({
  readJsonFile: (_n: string, seed: () => unknown) => (fake.disk ?? seed()),
  writeJsonFile: (_n: string, v: unknown) => { fake.disk = JSON.parse(JSON.stringify(v)) },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

const {
  AUTH_BROWSERS,
  AUTH_BROWSER_LABELS,
  DEFAULT_AUTH_BROWSER,
  isAuthBrowser,
} = await import('../../src/shared/account-web-session')

const {
  getAuthBrowser,
  setAuthBrowser,
  getAuthMethod,
  setAuthMethod,
  saveWebSession,
  removeWebSession,
  getWebSession,
} = await import('../../src/main/account-web/session-store')

const A = 'profile-aaa111'
const session = {
  profileId: A,
  accountEmail: 'a@example.com',
  acquiredAt: 1_700_000_000_000,
  expiresAt: null,
  origin: 'system-browser' as const,
}

beforeEach(() => { fake.disk = null })

describe('isAuthBrowser — the guard on a value that picks an executable', () => {
  it('accepts exactly the two browsers this app can drive', () => {
    expect(isAuthBrowser('chrome')).toBe(true)
    expect(isAuthBrowser('edge')).toBe(true)
    expect(AUTH_BROWSERS).toEqual(['edge', 'chrome'])
    expect(Object.keys(AUTH_BROWSER_LABELS).sort()).toEqual(['chrome', 'edge'])
  })

  it('rejects anything else, including things shaped like a path or a flag', () => {
    for (const bad of ['firefox', 'msedge.exe', 'C:/Windows/System32/cmd.exe', '--headless', '', null, 7, {}]) {
      expect(isAuthBrowser(bad)).toBe(false)
    }
  })

  it('defaults to Edge — the one verified to complete SSO in a fresh profile', () => {
    expect(DEFAULT_AUTH_BROWSER).toBe('edge')
  })
})

describe('the per-account browser in the store', () => {
  it('is the default until the account says otherwise', () => {
    expect(getAuthBrowser(A)).toBe('edge')
  })

  it('round-trips a choice, per account', () => {
    setAuthBrowser(A, 'chrome')
    expect(getAuthBrowser(A)).toBe('chrome')
    // A second account is unaffected — this is a per-account setting.
    expect(getAuthBrowser('profile-bbb222')).toBe('edge')
  })

  it('refuses a value that is not one of the two', () => {
    expect(() => setAuthBrowser(A, 'firefox' as never)).toThrow(/unknown sign-in browser/)
    expect(getAuthBrowser(A)).toBe('edge')
  })

  it('falls back to the default rather than returning junk already on disk', () => {
    fake.disk = { schemaVersion: 3, sessions: [], authMethods: {}, authBrowsers: { [A]: 'firefox' } }
    expect(getAuthBrowser(A)).toBe('edge')
  })
})

describe('signing out of claude.ai does not reset the account’s settings', () => {
  it('keeps the CLI flow and the browser choice when the session record is removed', () => {
    // REGRESSION. removeWebSession used to write back only `sessions`, so signing
    // out silently reverted both settings to their defaults — visible later as an
    // SSO failure or the wrong `claude auth login` flag, with nothing to explain it.
    setAuthMethod(A, 'sso')
    setAuthBrowser(A, 'chrome')
    saveWebSession(session)
    expect(getWebSession(A)).toBeDefined()

    removeWebSession(A)

    expect(getWebSession(A)).toBeUndefined()
    expect(getAuthMethod(A)).toBe('sso')
    expect(getAuthBrowser(A)).toBe('chrome')
  })

  it('leaves the file alone when there was nothing to remove', () => {
    setAuthBrowser(A, 'chrome')
    const before = JSON.stringify(fake.disk)
    removeWebSession('profile-never-signed-in')
    expect(JSON.stringify(fake.disk)).toBe(before)
  })
})

describe('schema migration', () => {
  it('carries a v2 file forward instead of reseeding it', () => {
    // Reseeding would sign every account out of claude.ai on upgrade, which reads
    // as a bug in the sign-in rather than in the store.
    fake.disk = {
      schemaVersion: 2,
      sessions: [session],
      authMethods: { [A]: 'console' },
    }
    expect(getWebSession(A)?.accountEmail).toBe('a@example.com')
    expect(getAuthMethod(A)).toBe('console')
    expect(getAuthBrowser(A)).toBe('edge')   // new setting, so the default
  })

  it('carries a v1 file forward too', () => {
    fake.disk = { schemaVersion: 1, sessions: [session] }
    expect(getWebSession(A)?.accountEmail).toBe('a@example.com')
    expect(getAuthMethod(A)).toBe('claudeai')
    expect(getAuthBrowser(A)).toBe('edge')
  })

  it('reseeds an unknown FUTURE version rather than guessing at its shape', () => {
    fake.disk = { schemaVersion: 99, sessions: [session] }
    expect(getWebSession(A)).toBeUndefined()
  })
})
