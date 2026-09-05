// @vitest-environment node
//
// Plan P2 (rc.15): an OPEN account -- one a live session is using -- already has
// its usage on screen (that session's statusline delivered it), so the account-
// usage page reuses that figure and makes NO network call. Only CLOSED accounts
// call, one at a time. The exception is the agreed Q1b case: when the page would
// show a credits row the buckets-only statusline figure cannot carry, the open
// account falls back to ONE GET with its live token -- never a rotation.
//
// The observable is the network: a served-from-delivered account issues no
// request at all; a fallen-through open account issues a GET to api.anthropic.com
// but NEVER a refresh POST to console.anthropic.com (Phase 1's guard).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AccountProfile } from '../../src/shared/account-types'
import type { UsageBucket } from '../../src/shared/usage-types'

let profiles: AccountProfile[] = []
let tmpHome = ''
/** sessionId -> profileId, as claude-account-identity would resolve it. */
const profileBySession = new Map<string, string | undefined>()
/** profileIds the guard reports in-use. */
const inUse = new Set<string>()
/** Seeded last-good snapshots (a prior real fetch), by profileId. */
let seededSnapshots: Record<string, { buckets: UsageBucket[]; credits?: unknown; fetchedAt: number }> = {}

vi.mock('../../src/main/account-profiles', () => ({
  listProfiles: () => profiles,
  getProfileConfigDir: () => tmpHome,
  readProfileAccountEmail: () => null,
  atomicWriteSecure: vi.fn(),
  hardenCredentialFile: vi.fn(),
}))
vi.mock('../../src/main/claude-account-identity', () => ({
  isProfileInUseByLiveSession: (id: string) => inUse.has(id),
  getClaudeProfileId: (sessionId: string) => profileBySession.get(sessionId),
}))
vi.mock('../../src/main/usage/usage-snapshots', () => ({
  loadSnapshots: () => new Map(Object.entries(seededSnapshots)),
  saveSnapshots: () => true,
}))
vi.mock('../../src/main/debug-logger', () => ({ logWarn: vi.fn(), logInfo: vi.fn() }))

const requestedHosts: string[] = []
vi.mock('https', () => {
  const request = (opts: any, cb: (res: any) => void) => {
    requestedHosts.push(opts?.hostname ?? '')
    // A GET to the usage endpoint returns a tiny valid payload; anything else 400s.
    const isUsageGet = opts?.hostname === 'api.anthropic.com'
    const res: any = {
      statusCode: isUsageGet ? 200 : 400,
      headers: {},
      on: (ev: string, fn: (arg?: unknown) => void) => {
        if (ev === 'data' && isUsageGet) fn(JSON.stringify({ limits: [{ group: 'session', percent: 3, resets_at: '' }] }))
        if (ev === 'end') fn()
        return res
      },
    }
    cb(res)
    return { on: () => ({}), write: () => {}, end: () => {}, destroy: () => {}, setTimeout: () => {} }
  }
  return { default: { request }, request }
})

const { fetchAccountUsage, fetchAllAccountsUsage, fetchAllAccountsUsageStreaming, recordLiveUsageForSession, _resetLiveUsageForTest, _resetSnapshotsForTest, LIVE_USAGE_MAX_AGE_MS } =
  await import('../../src/main/usage/account-usage')

const USAGE_HOST = 'api.anthropic.com'
const REFRESH_HOST = 'console.anthropic.com'

const profile = (over: Partial<AccountProfile>): AccountProfile => ({
  id: 'profile-x-1', name: 'Acct', accountEmail: 'x@example.com', createdAt: 0, ...over,
})
const bucket = (over: Partial<UsageBucket> = {}): UsageBucket =>
  ({ key: 'session:', label: '5h', group: 'session', percent: 12, resetsAt: '', severity: 'normal', ...over })

/** A credentials file so a fall-through GET has a token: fresh (non-lapsed) by
 *  default; pass a past `expiresAt` for a token the closed-account path would refresh. */
function writeCreds(expiresAt = Date.now() + 3_600_000): void {
  const dir = path.join(tmpHome, '.claude')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'live-token', refreshToken: 'r', expiresAt },
  }))
}
const writeFreshCreds = (): void => writeCreds()

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-live-open-'))
  profiles = [profile({ id: 'profile-x-1' })]
  profileBySession.clear()
  inUse.clear()
  seededSnapshots = {}
  requestedHosts.length = 0
  _resetLiveUsageForTest()
  _resetSnapshotsForTest() // so each test's seededSnapshots is hydrated fresh
  writeFreshCreds()
})
afterEach(() => { try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('fetchAccountUsage — an OPEN account reuses its delivered figure (no call)', () => {
  it('serves the delivered buckets with status ok and NO network request', async () => {
    inUse.add('profile-x-1')
    profileBySession.set('sess-1', 'profile-x-1')
    recordLiveUsageForSession('sess-1', [bucket({ percent: 41 })], false)

    const r = await fetchAccountUsage('profile-x-1')
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(false)
    expect(r.buckets.map((b) => b.percent)).toEqual([41])
    expect(requestedHosts).toEqual([]) // reused the delivered figure, made no call
  })

  it('a CLOSED account still hits the usage endpoint', async () => {
    // not in use, fresh token -> the normal GET path.
    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toContain(USAGE_HOST)
    expect(r.status).toBe('ok')
  })

  it('falls through to a GET (never a refresh) when the delivered payload had credits (Q1b)', async () => {
    inUse.add('profile-x-1')
    profileBySession.set('sess-1', 'profile-x-1')
    recordLiveUsageForSession('sess-1', [bucket()], /* hasCredits */ true)

    await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toContain(USAGE_HOST)   // one GET to fill the credits row
    expect(requestedHosts).not.toContain(REFRESH_HOST) // never a rotation while in use
  })

  it('REGRESSION (adversarial pass on #598): the Q1b GET never rotates even when the live token has LAPSED', async () => {
    // The fixture above is fresh, so "never a rotation" was unreachable there;
    // an expired token is the case in which the closed-account path WOULD refresh.
    writeCreds(Date.now() - 60_000)
    inUse.add('profile-x-1')
    profileBySession.set('sess-1', 'profile-x-1')
    recordLiveUsageForSession('sess-1', [bucket()], /* hasCredits */ true)

    await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).not.toContain(REFRESH_HOST)
  })

  it('control: the same lapsed token on a CLOSED account does go to the refresh endpoint', async () => {
    writeCreds(Date.now() - 60_000)
    await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toContain(REFRESH_HOST)
  })

  it('falls through to a GET when a prior fetch cached credits the delivered figure cannot carry (Q1b)', async () => {
    seededSnapshots = { 'profile-x-1': { buckets: [bucket()], credits: { currency: 'USD', used: 1, limit: null, remaining: null, enabled: true }, fetchedAt: Date.now() - 1000 } }
    inUse.add('profile-x-1')
    profileBySession.set('sess-1', 'profile-x-1')
    recordLiveUsageForSession('sess-1', [bucket()], false) // delivered has no credits...

    await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toContain(USAGE_HOST) // ...but the cached credits force the GET
  })

  it('falls through to a GET when the delivered figure is STALE (older than the max age)', async () => {
    inUse.add('profile-x-1')
    profileBySession.set('sess-1', 'profile-x-1')
    recordLiveUsageForSession('sess-1', [bucket()], false, Date.now() - LIVE_USAGE_MAX_AGE_MS - 1)

    await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toContain(USAGE_HOST)
  })

  it('falls through to a GET when the account is in use but NO figure was delivered yet', async () => {
    inUse.add('profile-x-1') // session just spawned; nothing recorded
    await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toContain(USAGE_HOST)
  })

  it('the PRIMARY account is NOT served from a delivered figure -- it keeps the network path', async () => {
    profiles = [profile({ id: 'profile-x-1', isPrimary: true })]
    inUse.add('profile-x-1')
    profileBySession.set('sess-1', 'profile-x-1')
    recordLiveUsageForSession('sess-1', [bucket()], false)

    await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toContain(USAGE_HOST)
  })
})

describe('recordLiveUsageForSession — what it stores', () => {
  it('stores nothing for a session with no local profile (SSH / default home)', async () => {
    inUse.add('profile-x-1')
    profileBySession.set('sess-ssh', undefined) // getClaudeProfileId -> undefined
    recordLiveUsageForSession('sess-ssh', [bucket()], false)

    await fetchAccountUsage('profile-x-1') // in use, but nothing was stored for it
    expect(requestedHosts).toContain(USAGE_HOST) // so it GETs
  })

  it('ignores an empty or all-malformed bucket set', async () => {
    inUse.add('profile-x-1')
    profileBySession.set('sess-1', 'profile-x-1')
    recordLiveUsageForSession('sess-1', [], false)
    recordLiveUsageForSession('sess-1', [{ nope: 1 }, 'bad', null], false)

    await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toContain(USAGE_HOST) // nothing servable -> GET
  })

  it('drops malformed buckets but keeps the valid ones', async () => {
    inUse.add('profile-x-1')
    profileBySession.set('sess-1', 'profile-x-1')
    recordLiveUsageForSession('sess-1', [bucket({ percent: 7 }), { key: 1 }, bucket({ key: 'weekly:', label: 'Weekly', group: 'weekly', percent: 20 })], false)

    const r = await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toEqual([])
    expect(r.buckets.map((b) => b.percent)).toEqual([7, 20])
  })
})

describe('fetchAllAccountsUsage — open accounts make no call and take no stagger slot', () => {
  it('only the closed account hits the network; both open accounts are served from their figures', async () => {
    profiles = [
      profile({ id: 'profile-open-1', accountEmail: 'a@x.com' }),
      profile({ id: 'profile-open-2', accountEmail: 'b@x.com' }),
      profile({ id: 'profile-closed-3', accountEmail: 'c@x.com' }),
    ]
    inUse.add('profile-open-1'); inUse.add('profile-open-2')
    profileBySession.set('s1', 'profile-open-1'); profileBySession.set('s2', 'profile-open-2')
    recordLiveUsageForSession('s1', [bucket({ percent: 10 })], false)
    recordLiveUsageForSession('s2', [bucket({ percent: 20 })], false)

    const rows = await fetchAllAccountsUsage()
    expect(rows.map((r) => r.profileId)).toEqual(['profile-open-1', 'profile-open-2', 'profile-closed-3'])
    // Exactly one network call: the closed account's GET. The two open accounts
    // were served from their delivered figures and made no request.
    expect(requestedHosts).toEqual([USAGE_HOST])
    expect(rows[0].buckets[0].percent).toBe(10)
    expect(rows[1].buckets[0].percent).toBe(20)
  })

  // The stagger exists to space out NETWORK calls; an open account makes none, so
  // it must not trigger one -- otherwise the page waits STAGGER_MS per open row
  // for calls that never happen, the opposite of the "instant open rows" goal.
  it('an all-open fetchAll issues ZERO stagger sleeps', async () => {
    profiles = [
      profile({ id: 'profile-open-1' }), profile({ id: 'profile-open-2' }), profile({ id: 'profile-open-3' }),
    ]
    for (let i = 1; i <= 3; i++) {
      inUse.add(`profile-open-${i}`)
      profileBySession.set(`s${i}`, `profile-open-${i}`)
      recordLiveUsageForSession(`s${i}`, [bucket()], false)
    }
    const timeoutSpy = vi.spyOn(global, 'setTimeout')
    await fetchAllAccountsUsage()
    // STAGGER_MS is 300; no networked account, so no stagger sleep is scheduled.
    expect(timeoutSpy.mock.calls.filter((c) => c[1] === 300)).toHaveLength(0)
    expect(requestedHosts).toEqual([])
    timeoutSpy.mockRestore()
  })

  it('two CLOSED accounts DO stagger once between them (the control for the zero above)', async () => {
    profiles = [profile({ id: 'profile-a' }), profile({ id: 'profile-b' })] // neither in use -> both network
    const timeoutSpy = vi.spyOn(global, 'setTimeout')
    await fetchAllAccountsUsage()
    expect(timeoutSpy.mock.calls.filter((c) => c[1] === 300)).toHaveLength(1)
    timeoutSpy.mockRestore()
  })

  it('on the FIRST fetchAll, an open cached-credits account is counted toward the stagger (hydrate before the decision)', async () => {
    // The account is open and its current tick has no credits, but a prior fetch
    // cached credits -> it must take the GET path (Q1b) AND be paced with the
    // closed account. fetchAll must hydrate the snapshot BEFORE deciding, or the
    // stagger decision reads an empty cache and skips the slot -> two un-paced GETs.
    seededSnapshots = { 'profile-cc': { buckets: [bucket()], credits: { currency: 'USD', used: 1, limit: null, remaining: null, enabled: true }, fetchedAt: Date.now() - 1000 } }
    profiles = [profile({ id: 'profile-cc' }), profile({ id: 'profile-closed' })]
    inUse.add('profile-cc')
    profileBySession.set('sc', 'profile-cc')
    recordLiveUsageForSession('sc', [bucket()], false) // delivered tick: no credits
    const timeoutSpy = vi.spyOn(global, 'setTimeout')
    await fetchAllAccountsUsage()
    // Both hit the usage endpoint (the cached credits force the open one to GET)...
    expect(requestedHosts.filter((h) => h === USAGE_HOST)).toHaveLength(2)
    // ...and they are paced: exactly one stagger between the two networked accounts.
    expect(timeoutSpy.mock.calls.filter((c) => c[1] === 300)).toHaveLength(1)
    timeoutSpy.mockRestore()
  })
})

describe('fetchAllAccountsUsageStreaming — per-account delivery in load order (plan P3)', () => {
  it('calls onResult once per account, in listProfiles order, and the batch API collects the same set', async () => {
    profiles = [
      profile({ id: 'profile-open-1' }), profile({ id: 'profile-closed-2' }), profile({ id: 'profile-open-3' }),
    ]
    inUse.add('profile-open-1'); inUse.add('profile-open-3')
    profileBySession.set('s1', 'profile-open-1'); profileBySession.set('s3', 'profile-open-3')
    recordLiveUsageForSession('s1', [bucket({ percent: 10 })], false)
    recordLiveUsageForSession('s3', [bucket({ percent: 30 })], false)

    const streamed: string[] = []
    await fetchAllAccountsUsageStreaming((u) => streamed.push(u.profileId))
    expect(streamed).toEqual(['profile-open-1', 'profile-closed-2', 'profile-open-3'])

    // The batch shape returns the same rows (it is the streaming fn collected).
    const rows = await fetchAllAccountsUsage()
    expect(rows.map((r) => r.profileId)).toEqual(['profile-open-1', 'profile-closed-2', 'profile-open-3'])
  })

  it('delivers an OPEN account before a slower CLOSED one that precedes it in a stagger', async () => {
    // open-1 is served instantly; closed-2 waits a stagger only if it is not first.
    profiles = [profile({ id: 'profile-open-1' }), profile({ id: 'profile-closed-2' })]
    inUse.add('profile-open-1')
    profileBySession.set('s1', 'profile-open-1')
    recordLiveUsageForSession('s1', [bucket({ percent: 5 })], false)

    const order: Array<{ id: string; hadCall: boolean }> = []
    await fetchAllAccountsUsageStreaming((u) => order.push({ id: u.profileId, hadCall: u.buckets[0]?.percent !== 5 }))
    // open-1 lands first, from its delivered figure (percent 5, no call); closed-2 after.
    expect(order[0]).toEqual({ id: 'profile-open-1', hadCall: false })
    expect(order[1].id).toBe('profile-closed-2')
    expect(requestedHosts).toEqual([USAGE_HOST]) // only the closed account called
  })

  it('propagates a throw from onResult (the caller owns its handler)', async () => {
    profiles = [profile({ id: 'profile-open-1' })]
    inUse.add('profile-open-1')
    profileBySession.set('s1', 'profile-open-1')
    recordLiveUsageForSession('s1', [bucket()], false)
    await expect(fetchAllAccountsUsageStreaming(() => { throw new Error('handler boom') })).rejects.toThrow('handler boom')
  })
})
