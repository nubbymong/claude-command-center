import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// #202: two profile homes were found signed into the SAME account. That is not
// cosmetic — refreshing in one rotates the OAuth refresh token and invalidates the
// copies in the others, producing exactly the "OAuth session expired and could not
// be refreshed" failures seen in #191.
//
// Crucially, `refreshIdentity` OVERWRITES profiles.json's accountEmail with
// whatever the home reports, so a wrong sign-in silently RELABELS the profile and
// the label-vs-home divergence disappears while the duplication remains. Both
// checks are therefore required, and these tests pin that.

const h = vi.hoisted(() => ({ root: '', profiles: [] as Array<{ id: string; accountEmail: string }> }))

vi.mock('../../src/main/account-profiles', () => ({
  getProfileConfigDir: (id: string) => join(h.root, id),
  listProfiles: () => h.profiles
}))

import { readAllProfileAuthInfo, readProfileAuthInfo } from '../../src/main/account-auth-info'

function seed(
  id: string,
  opts: { oauthEmail?: string; refreshToken?: string; expiresAt?: number; refreshTokenExpiresAt?: number; noCreds?: boolean } = {}
): void {
  const home = join(h.root, id)
  mkdirSync(join(home, '.claude'), { recursive: true })
  if (!opts.noCreds) {
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'a'.repeat(20),
          refreshToken: opts.refreshToken ?? 'r'.repeat(20),
          expiresAt: opts.expiresAt ?? 1785800025758,
          refreshTokenExpiresAt: opts.refreshTokenExpiresAt ?? 1787000000000,
          subscriptionType: 'team'
        }
      })
    )
  }
  if (opts.oauthEmail !== undefined) {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: opts.oauthEmail } }))
  }
}

describe('readProfileAuthInfo', () => {
  beforeEach(() => {
    h.root = mkdtempSync(join(tmpdir(), 'auth-info-'))
    h.profiles = []
  })
  afterEach(() => {
    try { rmSync(h.root, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('reads both expiries and the subscription tier', () => {
    seed('p1', { oauthEmail: 'a@example.com', expiresAt: 111, refreshTokenExpiresAt: 222 })
    const info = readProfileAuthInfo('p1', 'a@example.com')
    expect(info.credentialsMissing).toBeUndefined()
    expect(info.hasRefreshToken).toBe(true)
    expect(info.expiresAt).toBe(111)
    expect(info.refreshTokenExpiresAt).toBe(222)
    expect(info.subscriptionType).toBe('team')
    expect(info.oauthEmail).toBe('a@example.com')
  })

  it('flags missing credentials instead of throwing', () => {
    seed('p1', { noCreds: true, oauthEmail: 'a@example.com' })
    expect(readProfileAuthInfo('p1', 'a@example.com').credentialsMissing).toBe(true)
  })

  it('survives an unparseable credentials file', () => {
    const home = join(h.root, 'p1')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', '.credentials.json'), '{ truncated')
    expect(readProfileAuthInfo('p1').credentialsMissing).toBe(true)
  })

  it('reports an absent refresh token distinctly from absent credentials', () => {
    seed('p1', { refreshToken: '' })
    const info = readProfileAuthInfo('p1')
    expect(info.credentialsMissing).toBeUndefined()
    expect(info.hasRefreshToken).toBe(false)
  })
})

describe('readAllProfileAuthInfo identity cross-check', () => {
  beforeEach(() => {
    h.root = mkdtempSync(join(tmpdir(), 'auth-info-'))
    h.profiles = []
  })
  afterEach(() => {
    try { rmSync(h.root, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('detects the real contamination: three homes on one account', () => {
    // Exactly the observed dev state: two profiles labelled se01/severson whose
    // homes both report se03.
    h.profiles = [
      { id: 'se01', accountEmail: 'aai-se01@broadnet.com' },
      { id: 'severson', accountEmail: 'severson@broadnet.com' },
      { id: 'se02', accountEmail: 'aai-se02@broadnet.com' },
      { id: 'se03', accountEmail: 'aai-se03@broadnet.com' }
    ]
    seed('se01', { oauthEmail: 'aai-se03@broadnet.com' })
    seed('severson', { oauthEmail: 'aai-se03@broadnet.com' })
    seed('se02', { oauthEmail: 'aai-se02@broadnet.com' })
    seed('se03', { oauthEmail: 'aai-se03@broadnet.com' })

    const infos = readAllProfileAuthInfo()
    const byId = new Map(infos.map((i) => [i.profileId, i]))

    expect(byId.get('se01')!.identityMismatch).toBe(true)
    expect(byId.get('severson')!.identityMismatch).toBe(true)
    expect(byId.get('se02')!.identityMismatch).toBe(false)

    // The duplication is the part that actually breaks tokens.
    expect(byId.get('se01')!.duplicateOfProfileIds?.sort()).toEqual(['se03', 'severson'])
    expect(byId.get('se03')!.duplicateOfProfileIds?.sort()).toEqual(['se01', 'severson'])
    expect(byId.get('se02')!.duplicateOfProfileIds).toBeUndefined()
  })

  it('still detects duplicates after refreshIdentity has relabelled the profiles', () => {
    // The case a divergence-only check would MISS: profiles.json has been
    // overwritten to match each home, so nothing diverges — yet two profiles are
    // still one account and will keep invalidating each other.
    h.profiles = [
      { id: 'p1', accountEmail: 'shared@example.com' },
      { id: 'p2', accountEmail: 'shared@example.com' }
    ]
    seed('p1', { oauthEmail: 'shared@example.com' })
    seed('p2', { oauthEmail: 'shared@example.com' })

    const infos = readAllProfileAuthInfo()
    expect(infos.every((i) => i.identityMismatch === false)).toBe(true)
    expect(infos[0].duplicateOfProfileIds).toEqual(['p2'])
    expect(infos[1].duplicateOfProfileIds).toEqual(['p1'])
  })

  it('matches identities case-insensitively', () => {
    h.profiles = [
      { id: 'p1', accountEmail: 'A@Example.com' },
      { id: 'p2', accountEmail: 'a@example.com' }
    ]
    seed('p1', { oauthEmail: 'A@Example.COM' })
    seed('p2', { oauthEmail: 'a@example.com' })
    const infos = readAllProfileAuthInfo()
    expect(infos[0].duplicateOfProfileIds).toEqual(['p2'])
    expect(infos[0].identityMismatch).toBe(false)
  })

  it('does not pair profiles that merely both lack a home identity', () => {
    h.profiles = [
      { id: 'p1', accountEmail: 'a@example.com' },
      { id: 'p2', accountEmail: 'b@example.com' }
    ]
    seed('p1')
    seed('p2')
    const infos = readAllProfileAuthInfo()
    expect(infos.every((i) => i.duplicateOfProfileIds === undefined)).toBe(true)
    // No home identity to compare against, so no mismatch claim either.
    expect(infos.every((i) => i.identityMismatch === undefined)).toBe(true)
  })

  it('returns a row per profile even when a home is entirely missing', () => {
    h.profiles = [{ id: 'ghost', accountEmail: 'g@example.com' }]
    const infos = readAllProfileAuthInfo()
    expect(infos).toHaveLength(1)
    expect(infos[0].credentialsMissing).toBe(true)
  })
})
