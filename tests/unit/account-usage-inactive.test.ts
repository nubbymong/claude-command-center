// @vitest-environment node
//
// BUG 2 (#239 follow-up): a parked (inactive) account must be LISTED on the usage
// page but never network-polled or token-refreshed. fetchAccountUsage short-
// circuits to status 'inactive' before it reads credentials, refreshes a token,
// or hits the network. These tests prove that short-circuit: remove it and an
// inactive account falls through to the normal (needs-login/error) path, so the
// status assertion fails.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AccountProfile } from '../../src/shared/account-types'

let profiles: AccountProfile[] = []

vi.mock('../../src/main/account-profiles', () => ({
  listProfiles: () => profiles,
  // Reached only if the short-circuit is REMOVED (readProfileToken path). Point
  // it at a dir with no credentials so a fall-through resolves to signed-out,
  // which is a different status than 'inactive' — that difference is the proof.
  getProfileConfigDir: (id: string) => `/nonexistent/${id}`,
  readProfileAccountEmail: () => null,
  atomicWriteSecure: vi.fn(),
  hardenCredentialFile: vi.fn(),
}))
vi.mock('../../src/main/claude-account-identity', () => ({
  isProfileInUseByLiveSession: () => false,
}))
vi.mock('../../src/main/debug-logger', () => ({ logWarn: vi.fn(), logInfo: vi.fn() }))

const { fetchAccountUsage, fetchAllAccountsUsage } = await import('../../src/main/usage/account-usage')

const profile = (over: Partial<AccountProfile>): AccountProfile => ({
  id: 'profile-x-1',
  name: 'Acct',
  accountEmail: 'x@example.com',
  createdAt: 0,
  ...over,
})

beforeEach(() => { profiles = [] })

describe('fetchAccountUsage — parked accounts short-circuit', () => {
  it('an inactive account reports status "inactive" with active:false and no buckets', async () => {
    profiles = [profile({ id: 'profile-parked-1', active: false })]
    const r = await fetchAccountUsage('profile-parked-1')
    expect(r.status).toBe('inactive')
    expect(r.active).toBe(false)
    expect(r.buckets).toEqual([])
  })

  it('does NOT short-circuit an active account (undefined active = active)', async () => {
    // No creds on disk, so it lands on needs-login/error — the point is only that
    // it is NOT 'inactive': an active account still takes the live path.
    profiles = [profile({ id: 'profile-active-1' })] // active undefined => active
    const r = await fetchAccountUsage('profile-active-1')
    expect(r.status).not.toBe('inactive')
    expect(r.active).toBe(true)
  })

  it('the PRIMARY account is always active even if marked inactive', async () => {
    profiles = [profile({ id: 'profile-primary-1', isPrimary: true, active: false })]
    const r = await fetchAccountUsage('profile-primary-1')
    expect(r.status).not.toBe('inactive')
    expect(r.active).toBe(true)
  })
})

describe('fetchAllAccountsUsage — inactive rows are listed but not networked', () => {
  it('returns a row for every account, inactive ones marked and short-circuited', async () => {
    profiles = [
      profile({ id: 'profile-parked-1', active: false }),
      profile({ id: 'profile-parked-2', active: false }),
    ]
    const rows = await fetchAllAccountsUsage()
    expect(rows.map((r) => r.profileId)).toEqual(['profile-parked-1', 'profile-parked-2'])
    expect(rows.every((r) => r.status === 'inactive' && r.active === false)).toBe(true)
  })
})
