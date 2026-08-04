// #216 — per-account claude.ai web session: partition isolation + cookie harvesting.
//
// These two are where the security of the feature lives. Partition naming is the
// ONLY thing keeping one account's claude.ai cookies away from another's, and the
// harvest filter is the only thing deciding what leaves the user's browser. Both
// are pure, so both get tested without launching anything.
import { describe, it, expect } from 'vitest'
import {
  CLAUDE_SESSION_COOKIE,
  PROFILE_ID_RE,
  webPartitionForProfile,
} from '../../src/shared/account-web-session'
import {
  harvestClaudeCookies,
  isClaudeCookie,
  mapSameSite,
  toElectronCookie,
  type CdpCookie,
} from '../../src/main/account-web/cookie-harvest'

const cookie = (over: Partial<CdpCookie> = {}): CdpCookie => ({
  name: CLAUDE_SESSION_COOKIE,
  value: 'sk-abc',
  domain: '.claude.ai',
  path: '/',
  expires: 1_800_000_000,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  ...over,
})

describe('webPartitionForProfile — the isolation boundary', () => {
  it('gives each account its own partition', () => {
    const a = webPartitionForProfile('profile-aaa111')
    const b = webPartitionForProfile('profile-bbb222')
    expect(a).toBe('persist:claude-web-profile-aaa111')
    expect(a).not.toBe(b)
  })

  it('is persistent — a session partition would drop the cookies on quit', () => {
    expect(webPartitionForProfile('profile-aaa111').startsWith('persist:')).toBe(true)
  })

  it('REFUSES an id that could collide or escape rather than sanitising it', () => {
    // This string names a security boundary. A traversal-ish or wildcard id must
    // not be quietly rewritten into something that resolves to another account.
    for (const bad of [
      'profile-../other',
      'profile-a/b',
      '../profile-a',
      'persist:claude-web-profile-a',
      '',
      'profile-',
      'notaprofile',
    ]) {
      expect(() => webPartitionForProfile(bad)).toThrow(/unexpected profile id/)
    }
  })

  it('PROFILE_ID_RE matches the real on-disk profile id shape', () => {
    expect(PROFILE_ID_RE.test('profile-mrdsqlsb-aefe03')).toBe(true)
  })
})

describe('isClaudeCookie — nothing but claude.ai leaves the browser', () => {
  it('accepts the exact host and its dot-prefixed parent', () => {
    expect(isClaudeCookie({ domain: 'claude.ai' })).toBe(true)
    expect(isClaudeCookie({ domain: '.claude.ai' })).toBe(true)
    expect(isClaudeCookie({ domain: '.CLAUDE.AI' })).toBe(true)
  })

  it('rejects lookalikes and unrelated sites', () => {
    // A suffix test would accept the first two. That is why this is an exact
    // membership check.
    for (const d of ['claude.ai.attacker.example', 'evilclaude.ai', 'anthropic.com', 'mail.google.com', '']) {
      expect(isClaudeCookie({ domain: d })).toBe(false)
    }
  })
})

describe('toElectronCookie', () => {
  it('carries a persistent cookie across with its expiry', () => {
    const out = toElectronCookie(cookie())!
    expect(out.url).toBe('https://claude.ai')
    expect(out.name).toBe(CLAUDE_SESSION_COOKIE)
    expect(out.httpOnly).toBe(true)
    expect(out.secure).toBe(true)
    expect(out.expirationDate).toBe(1_800_000_000)
  })

  it('does NOT give a session cookie an expiry', () => {
    // Electron would turn an expirationDate into a persistent cookie, outliving
    // the browser session it was copied from.
    expect(toElectronCookie(cookie({ expires: -1 }))!.expirationDate).toBeUndefined()
    expect(toElectronCookie(cookie({ expires: undefined }))!.expirationDate).toBeUndefined()
  })

  it('drops a non-claude.ai cookie and a nameless one', () => {
    expect(toElectronCookie(cookie({ domain: 'mail.google.com' }))).toBeNull()
    expect(toElectronCookie(cookie({ name: '' }))).toBeNull()
  })

  it('maps sameSite into Electron spelling', () => {
    expect(mapSameSite('None')).toBe('no_restriction')
    expect(mapSameSite('Lax')).toBe('lax')
    expect(mapSameSite('Strict')).toBe('strict')
    expect(mapSameSite(undefined)).toBe('unspecified')
    expect(mapSameSite('nonsense')).toBe('unspecified')
  })
})

describe('harvestClaudeCookies', () => {
  it('keeps claude.ai cookies and counts what it dropped', () => {
    const r = harvestClaudeCookies([
      cookie(),
      cookie({ name: 'lastActiveOrg', value: 'org_1' }),
      cookie({ domain: 'mail.google.com', name: 'SID' }),
      cookie({ domain: 'github.com', name: 'user_session' }),
    ])
    expect(r.cookies.map((c) => c.name)).toEqual([CLAUDE_SESSION_COOKIE, 'lastActiveOrg'])
    expect(r.dropped).toBe(2)
  })

  it('reports whether the cookie that actually carries the session is present', () => {
    expect(harvestClaudeCookies([cookie()]).hasSessionCookie).toBe(true)
    // Analytics cookies alone are not a session; injecting them would leave the
    // partition looking authenticated while every request 401s.
    expect(harvestClaudeCookies([cookie({ name: 'ajs_anonymous_id' })]).hasSessionCookie).toBe(false)
    expect(harvestClaudeCookies([]).hasSessionCookie).toBe(false)
  })

  it('reports the EARLIEST expiry, in epoch ms', () => {
    const r = harvestClaudeCookies([
      cookie({ name: 'a', expires: 1_900_000_000 }),
      cookie({ name: 'b', expires: 1_700_000_000 }),
    ])
    expect(r.expiresAt).toBe(1_700_000_000 * 1000)
  })

  it('reports null expiry when everything is a session cookie', () => {
    expect(harvestClaudeCookies([cookie({ expires: -1 })]).expiresAt).toBeNull()
  })

  it('survives a malformed jar without throwing', () => {
    expect(harvestClaudeCookies(undefined as never).cookies).toEqual([])
  })
})
