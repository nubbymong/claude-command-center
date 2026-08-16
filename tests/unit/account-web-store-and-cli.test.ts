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

// claude-cli-auth promisifies execFile at module load, so the mock must expose
// execFile as a function. This suite doesn't call readClaudeCliAuth, so the stub
// is never invoked; it only needs to satisfy promisify() at import time.
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error) => void) => cb(new Error('no cli')),
}))

const { statusOf } = await import('../../src/main/account-web/session-store')
const { parseCliAuth, parseAuthStatus, claudeAuthCommand } = await import('../../src/main/account-web/claude-cli-auth')

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

describe('parseAuthStatus — the CLI’s own interface, preferred over the file', () => {
  // Verified against the real CLI: `claude auth status` with USERPROFILE set to a
  // profile home reports THAT account. Two profiles returned two different
  // emails, which is the question the credential file cannot answer.
  it('reads a signed-in account, with the identity the file does not carry', () => {
    const r = parseAuthStatus(JSON.stringify({
      loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
      email: 'a@example.com', orgName: 'Broadnet', subscriptionType: 'team',
    }))!
    expect(r.authenticated).toBe(true)
    expect(r.email).toBe('a@example.com')
    expect(r.orgName).toBe('Broadnet')
    expect(r.subscriptionType).toBe('team')
    expect(r.source).toBe('cli-status')
  })

  it('reads a signed-out profile', () => {
    const r = parseAuthStatus(JSON.stringify({ loggedIn: false, authMethod: 'none' }))!
    expect(r.authenticated).toBe(false)
    expect(r.email).toBeUndefined()
  })

  it('returns null on anything that is not a status payload, so the caller falls back', () => {
    // The CLI also prints human prose (e.g. a missing-config warning). Returning
    // null — rather than a confident "signed out" — is what lets the credential
    // file answer instead of the UI wrongly prompting for a sign-in.
    expect(parseAuthStatus('Claude configuration file not found at: ...')).toBeNull()
    expect(parseAuthStatus('{ not json')).toBeNull()
    expect(parseAuthStatus(JSON.stringify({ email: 'a@b.c' }))).toBeNull()
  })
})

describe('claudeAuthCommand — the flow is per account, not assumed', () => {
  it('emits the flag for each of the CLI’s actual choices', () => {
    // Hardcoding --sso was wrong: an org account uses SSO, a personal
    // subscription does not, and a Console account bills API usage. Getting it
    // wrong fails at the identity provider, not in CCC.
    expect(claudeAuthCommand('claudeai')).toBe('claude auth login --claudeai')
    expect(claudeAuthCommand('sso')).toBe('claude auth login --sso')
    expect(claudeAuthCommand('console')).toBe('claude auth login --console')
  })

  it('defaults to the subscription flow, which is the CLI’s own default', () => {
    expect(claudeAuthCommand()).toBe('claude auth login --claudeai')
  })

  it('falls back to the default rather than emitting an unknown flag', () => {
    expect(claudeAuthCommand('nonsense' as never)).toBe('claude auth login --claudeai')
  })

  it('pre-populates a plausible email', () => {
    expect(claudeAuthCommand('sso', 'a@example.com')).toBe('claude auth login --sso --email a@example.com')
  })

  it('drops anything that is not address-shaped rather than interpolating it', () => {
    // This string is shown to a human and may be typed into a terminal.
    for (const bad of ['a@b.c; rm -rf /', 'a b@c.d', '$(whoami)@x.y', 'not-an-email', '']) {
      expect(claudeAuthCommand('sso', bad)).toBe('claude auth login --sso')
    }
  })
})

describe('parseCliAuth — the credential-file fallback', () => {
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
