// @vitest-environment node
//
// Per-account usage on macOS with the experimental multi-account setting on
// (src/shared/mac-multi-account.ts): the token is a Keychain item, read and
// refreshed through the credential seam with the SAME semantics as the file
// on win32/linux -- "Sign in" only when the credential is genuinely absent,
// an unreadable one is never a sign-out, and a refresh writes back only if
// the refresh token it spent is still the one stored (compare-before-write).
// `security` and the network are faked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AccountProfile } from '../../src/shared/account-types'

const SVC = 'Claude Code-credentials-0123abcd'
let profiles: AccountProfile[] = []
let location: { kind: 'file'; path: string } | { kind: 'keychain'; service: string; fallbackFile: string; primary: boolean } = { kind: 'file', path: '/nonexistent/.credentials.json' }
let inUse = false
const kc = new Map<string, string>()
let securityCalls: { args: string[]; input?: string }[] = []
let forceFind: (() => { code: number | null; timedOut: boolean } | null) | null = null
let refreshResponse: { status: number; body: unknown } = { status: 200, body: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 } }
let onRefreshPosted: (() => void) | null = null
/** Answers the NEXT find with this secret (a stale shared read), once. */
let staleFindOnce: string | null = null
const removedListeners: Array<(id: string) => void> = []
const requests: { host: string; path: string; auth?: string }[] = []

vi.mock('../../src/main/account-profiles', async () => {
  const store = await vi.importActual<typeof import('../../src/main/claude-credential-store-darwin')>('../../src/main/claude-credential-store-darwin')
  return {
    listProfiles: () => profiles,
    getProfileConfigDir: () => '/nonexistent-profile-home',
    readProfileAccountEmail: () => null,
    atomicWriteSecure: vi.fn(),
    hardenCredentialFile: vi.fn(),
    profileCredentialLocation: () => location,
    onProfileCredentialRemoved: (fn: (id: string) => void) => { removedListeners.push(fn); return () => {} },
    // The real read order minus the fallback file (none exists here).
    readMacCredential: async (loc: { service: string }) => {
      const r = await store.readKeychainCreds(loc.service)
      return r.status === 'found' ? { status: 'found', source: 'keychain', creds: r.creds } : r
    },
  }
})
vi.mock('../../src/main/claude-account-identity', () => ({
  isProfileInUseByLiveSession: () => inUse,
  getClaudeProfileId: () => undefined,
}))
vi.mock('../../src/main/usage/usage-snapshots', () => ({ loadSnapshots: () => new Map(), saveSnapshots: () => true }))
vi.mock('../../src/main/debug-logger', () => ({ logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('https', () => {
  const request = (opts: any, cb: (res: any) => void) => {
    const handlers: Record<string, ((...a: any[]) => void)[]> = {}
    const req = {
      on: (ev: string, fn: (...a: any[]) => void) => { (handlers[ev] ||= []).push(fn); return req },
      write: () => {},
      destroy: () => {},
      end: () => {
        requests.push({ host: opts.hostname, path: opts.path, auth: opts.headers?.Authorization })
        const isRefresh = opts.path === '/v1/oauth/token'
        if (isRefresh) onRefreshPosted?.()
        const status = isRefresh ? refreshResponse.status : 200
        const body = isRefresh ? JSON.stringify(refreshResponse.body) : JSON.stringify({ five_hour: { utilization: 10, resets_at: '' } })
        const resHandlers: Record<string, ((...a: any[]) => void)[]> = {}
        const res = { statusCode: status, headers: {}, on: (ev: string, fn: (...a: any[]) => void) => { (resHandlers[ev] ||= []).push(fn); return res } }
        cb(res)
        setTimeout(() => { for (const f of resHandlers.data ?? []) f(body); for (const f of resHandlers.end ?? []) f() }, 0)
      },
    }
    return req
  }
  return { default: { request }, request }
})

const { _setSecurityRunnerForTest } = await import('../../src/main/claude-credential-store-darwin')
const { fetchAccountUsage, _resetLiveUsageForTest, _resetSnapshotsForTest, _pendingKeychainWriteBackForTest } = await import('../../src/main/usage/account-usage')

const realPlatform = process.platform
const other: AccountProfile = { id: 'profile-other-1', name: 'Other', accountEmail: 'o@example.com', createdAt: 0 }
const creds = (at: string, rt: string, expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: at, refreshToken: rt, expiresAt, scopes: ['user:inference'], subscriptionType: 'max' } })

beforeEach(() => {
  profiles = [other]
  location = { kind: 'keychain', service: SVC, fallbackFile: '/nonexistent/.credentials.json', primary: false }
  inUse = false
  kc.clear()
  securityCalls = []
  forceFind = null
  onRefreshPosted = null
  staleFindOnce = null
  refreshResponse = { status: 200, body: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 } }
  requests.length = 0
  _resetLiveUsageForTest()
  _resetSnapshotsForTest()
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  _setSecurityRunnerForTest(async (args, opts) => {
    securityCalls.push({ args: [...args], input: opts.input })
    const svc = args[args.indexOf('-s') + 1]
    if (args[0] === 'find-generic-password') {
      if (staleFindOnce !== null) { const s = staleFindOnce; staleFindOnce = null; return { code: 0, stdout: `${s}\n`, stderr: '', timedOut: false } }
      const f = forceFind?.()
      if (f) return { ...f, stdout: '', stderr: '' }
      const v = kc.get(svc)
      return v === undefined ? { code: 44, stdout: '', stderr: '', timedOut: false } : { code: 0, stdout: `${v}\n`, stderr: '', timedOut: false }
    }
    if (args[0] === '-i') {
      const m = /-s "([^"]+)" -X ([0-9a-f]+)\n$/.exec(opts.input ?? '')
      if (m) kc.set(m[1], Buffer.from(m[2], 'hex').toString('utf8'))
      return { code: m ? 0 : 1, stdout: '', stderr: '', timedOut: false }
    }
    return { code: 1, stdout: '', stderr: '', timedOut: false }
  }, () => 'someone')
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
  _setSecurityRunnerForTest(null)
})

describe('usage on the macOS realm (Keychain-backed)', () => {
  it('a valid Keychain token: live usage with that token', async () => {
    kc.set(SVC, creds('at-live', 'rt-1', Date.now() + 3_600_000))
    const u = await fetchAccountUsage(other.id)
    expect(u.status).toBe('ok')
    expect(u.stale).toBe(false)
    expect(requests).toEqual([{ host: 'api.anthropic.com', path: '/api/oauth/usage', auth: 'Bearer at-live' }])
  })

  it('no Keychain item and no file: "Sign in" (genuinely signed out)', async () => {
    const u = await fetchAccountUsage(other.id)
    expect(u.status).toBe('needs-login')
    expect(requests).toEqual([])
  })

  it('a locked Keychain / a timeout: never "Sign in", no network', async () => {
    for (const f of [{ code: 36, timedOut: false }, { code: null, timedOut: true }]) {
      forceFind = () => f
      const u = await fetchAccountUsage(other.id)
      expect(u.status).not.toBe('needs-login')
      expect(u.detail).toMatch(/open a session/)
    }
    expect(requests).toEqual([])
  })

  it('a lapsed token is refreshed and written back to the SAME item, every other field kept, secret never on argv', async () => {
    kc.set(SVC, creds('at-old', 'rt-old', Date.now() - 1000))
    const u = await fetchAccountUsage(other.id)
    expect(u.status).toBe('ok')
    const stored = JSON.parse(kc.get(SVC)!).claudeAiOauth
    expect(stored).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new', scopes: ['user:inference'], subscriptionType: 'max' })
    expect(requests.map((r) => r.path)).toEqual(['/v1/oauth/token', '/api/oauth/usage'])
    for (const c of securityCalls) for (const a of c.args) { expect(a).not.toContain('rt-new'); expect(a).not.toContain('at-new') }
  })

  it('rotation race: another writer rotated the item mid-flight -- theirs is kept, ours discarded', async () => {
    kc.set(SVC, creds('at-old', 'rt-old', Date.now() - 1000))
    onRefreshPosted = () => { kc.set(SVC, creds('at-cli', 'rt-cli', Date.now() + 3_600_000)) }
    await fetchAccountUsage(other.id)
    expect(JSON.parse(kc.get(SVC)!).claudeAiOauth.refreshToken).toBe('rt-cli')
    expect(securityCalls.some((c) => c.args[0] === '-i')).toBe(false)
  })

  // Re-attack r12: the POST already spent the stored refresh token; a locked
  // Keychain at write-back time must not throw the minted tokens away.
  it('r12: the Keychain locks right after a successful refresh POST -- the minted tokens are kept and written on the next fetch; no second POST', async () => {
    kc.set(SVC, creds('at-old', 'rt-old', Date.now() - 1000))
    onRefreshPosted = () => { forceFind = () => ({ code: 36, timedOut: false }) }
    const u1 = await fetchAccountUsage(other.id)
    expect(u1.status).toBe('ok')
    expect(requests.find((r) => r.path === '/api/oauth/usage')?.auth).toBe('Bearer at-new')
    expect(_pendingKeychainWriteBackForTest(other.id)?.tokens.refreshToken).toBe('rt-new')
    expect(JSON.parse(kc.get(SVC)!).claudeAiOauth.refreshToken).toBe('rt-old') // not written yet
    // The Keychain answers again.
    forceFind = null
    onRefreshPosted = null
    requests.length = 0
    const u2 = await fetchAccountUsage(other.id)
    expect(u2.status).toBe('ok')
    expect(JSON.parse(kc.get(SVC)!).claudeAiOauth).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' })
    expect(requests.filter((r) => r.path === '/v1/oauth/token')).toEqual([])
    expect(_pendingKeychainWriteBackForTest(other.id)).toBeUndefined()
  })

  it('r12: a pending write-back yields to a newer sign-in written meanwhile', async () => {
    kc.set(SVC, creds('at-old', 'rt-old', Date.now() - 1000))
    onRefreshPosted = () => { forceFind = () => ({ code: 36, timedOut: false }) }
    await fetchAccountUsage(other.id)
    forceFind = null
    onRefreshPosted = null
    kc.set(SVC, creds('at-cli', 'rt-cli', Date.now() + 3_600_000))
    await fetchAccountUsage(other.id)
    expect(JSON.parse(kc.get(SVC)!).claudeAiOauth.refreshToken).toBe('rt-cli')
    expect(_pendingKeychainWriteBackForTest(other.id)).toBeUndefined()
  })

  // Round 2, item 2: a status read answered by a read that began before
  // another writer rotated the item shows a spent token; the refresh must
  // re-read the item itself and not POST that token.
  it('item2: a stale status read never leads to a POST of a spent refresh token', async () => {
    kc.set(SVC, creds('at-cur', 'rt-current', Date.now() - 1000))
    staleFindOnce = creds('at-old', 'rt-old', Date.now() - 1000)
    await fetchAccountUsage(other.id)
    expect(requests.find((r) => r.path === '/v1/oauth/token')).toBeUndefined()
  })

  // Round 2, item 4: a newer sign-in stored with NO refresh token is not
  // overwritten by the pending tokens.
  it('item4: a pending write-back is dropped when the item now holds a sign-in with no refresh token', async () => {
    kc.set(SVC, creds('at-old', 'rt-old', Date.now() - 1000))
    onRefreshPosted = () => { forceFind = () => ({ code: 36, timedOut: false }) }
    await fetchAccountUsage(other.id)
    forceFind = null
    onRefreshPosted = null
    const newer = JSON.stringify({ claudeAiOauth: { accessToken: 'at-login', expiresAt: Date.now() + 3_600_000 } })
    kc.set(SVC, newer)
    await fetchAccountUsage(other.id)
    expect(kc.get(SVC)).toBe(newer)
    expect(_pendingKeychainWriteBackForTest(other.id)).toBeUndefined()
  })

  // Round 2, item 5: pending tokens go with the profile.
  it('item5: removing the profile\'s credential drops its pending write-back', async () => {
    kc.set(SVC, creds('at-old', 'rt-old', Date.now() - 1000))
    onRefreshPosted = () => { forceFind = () => ({ code: 36, timedOut: false }) }
    await fetchAccountUsage(other.id)
    expect(_pendingKeychainWriteBackForTest(other.id)).toBeDefined()
    for (const fn of removedListeners) fn(other.id)
    expect(_pendingKeychainWriteBackForTest(other.id)).toBeUndefined()
  })

  // Round 2, item 6: a launch that waits on this profile's refresh also gets
  // the pending write-back landed first.
  it('item6: waitForProfileRefresh lands a pending write-back before a launch reads the item', async () => {
    kc.set(SVC, creds('at-old', 'rt-old', Date.now() - 1000))
    onRefreshPosted = () => { forceFind = () => ({ code: 36, timedOut: false }) }
    await fetchAccountUsage(other.id)
    forceFind = null
    onRefreshPosted = null
    const { waitForProfileRefresh, pendingProfileRefresh } = await import('../../src/main/profile-consumers')
    expect(pendingProfileRefresh(other.id)).not.toBeNull()
    await waitForProfileRefresh(other.id)
    expect(JSON.parse(kc.get(SVC)!).claudeAiOauth.refreshToken).toBe('rt-new')
    expect(pendingProfileRefresh(other.id)).toBeNull()
  })

  it('the item was removed mid-flight: not recreated', async () => {
    kc.set(SVC, creds('at-old', 'rt-old', Date.now() - 1000))
    onRefreshPosted = () => { kc.delete(SVC) }
    await fetchAccountUsage(other.id)
    expect(kc.has(SVC)).toBe(false)
  })

  it('in use by a live session (the CLI may rotate it itself): no refresh, as on win32', async () => {
    inUse = true
    kc.set(SVC, creds('at-old', 'rt-old', Date.now() - 1000))
    await fetchAccountUsage(other.id)
    expect(requests.find((r) => r.path === '/v1/oauth/token')).toBeUndefined()
    expect(securityCalls.some((c) => c.args[0] === '-i')).toBe(false)
  })

  it('the PRIMARY (normal sign-in, default item): read, never refreshed', async () => {
    profiles = [{ ...other, isPrimary: true }]
    location = { kind: 'keychain', service: 'Claude Code-credentials', fallbackFile: '/nonexistent/.credentials.json', primary: true }
    kc.set('Claude Code-credentials', creds('at-p', 'rt-p', Date.now() - 1000))
    await fetchAccountUsage(other.id)
    expect(requests.find((r) => r.path === '/v1/oauth/token')).toBeUndefined()
    expect(securityCalls.some((c) => c.args[0] === '-i')).toBe(false)
  })

  it('setting off (the seam says file): no security call at all', async () => {
    location = { kind: 'file', path: '/nonexistent/.credentials.json' }
    const u = await fetchAccountUsage(other.id)
    expect(u.status).toBe('needs-login')
    expect(securityCalls).toEqual([])
  })
})
