// #216 — session-status and CLI-auth interpretation.
//
// Both are decisions the UI acts on: whether to prompt for a sign-in, and
// whether to enable "Open my artifacts". Getting them wrong is silent, so they
// are pure and pinned.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/main/channel-storage', () => ({
  readJsonFile: (_n: string, seed: () => unknown) => seed(),
  writeJsonFile: vi.fn(),
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('../../src/main/account-profiles', () => ({ getProfileConfigDir: () => '' }))

const { statusOf } = await import('../../src/main/account-web/session-store')
const { parseCliAuth } = await import('../../src/main/account-web/claude-cli-auth')

const NOW = 1_700_000_000_000

describe('statusOf — when a web session counts as usable', () => {
  it('is none when there is no record', () => {
    expect(statusOf(undefined, NOW)).toBe('none')
  })

  it('is active before the earliest cookie expiry, expired after', () => {
    const base = { profileId: 'profile-a', accountEmail: null, acquiredAt: 0, origin: 'system-browser' as const }
    expect(statusOf({ ...base, expiresAt: NOW + 60_000 }, NOW)).toBe('active')
    expect(statusOf({ ...base, expiresAt: NOW - 1 }, NOW)).toBe('expired')
    // Boundary: expiry exactly now is expired, not active.
    expect(statusOf({ ...base, expiresAt: NOW }, NOW)).toBe('expired')
  })

  it('treats a session-cookie-only record as active rather than expiring it', () => {
    // expiresAt null means every cookie was a session cookie. Marking that
    // expired would throw away a session that still works; a 401 is the right
    // thing to correct us, not a guess made here.
    const s = { profileId: 'profile-a', accountEmail: null, acquiredAt: 0, expiresAt: null, origin: 'system-browser' as const }
    expect(statusOf(s, NOW)).toBe('active')
  })
})

describe('parseCliAuth — the code-session half', () => {
  it('reads an authenticated credential file without returning the token', () => {
    const r = parseCliAuth(JSON.stringify({
      claudeAiOauth: { accessToken: 'secret-value', subscriptionType: 'max', expiresAt: NOW },
    }))
    expect(r.authenticated).toBe(true)
    expect(r.subscriptionType).toBe('max')
    expect(r.expiresAt).toBe(NOW)
    // The token value must never leave this function.
    expect(JSON.stringify(r)).not.toContain('secret-value')
  })

  it('is not authenticated when the OAuth block is missing or empty', () => {
    expect(parseCliAuth(JSON.stringify({})).authenticated).toBe(false)
    expect(parseCliAuth(JSON.stringify({ claudeAiOauth: {} })).authenticated).toBe(false)
    expect(parseCliAuth(JSON.stringify({ claudeAiOauth: { accessToken: '' } })).authenticated).toBe(false)
  })

  it('FAILS CLOSED on a malformed file', () => {
    // The UI decides whether to prompt for a sign-in from this. Guessing
    // "authenticated" on unreadable input would hide a broken account.
    const r = parseCliAuth('{ not json')
    expect(r.authenticated).toBe(false)
    expect(r.error).toMatch(/not readable/)
  })

  it('ignores an mcpOAuth-only file — that is a different credential', () => {
    expect(parseCliAuth(JSON.stringify({ mcpOAuth: { 'srv|abc': {} } })).authenticated).toBe(false)
  })
})
