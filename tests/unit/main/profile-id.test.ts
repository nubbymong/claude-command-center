// #48: claude-headless recovers the profile a run belongs to from its HOME path,
// so it can register as a consumer without importing the account-profiles graph.
// The inverse is structural (`<...>/account-profiles/<id>`), never a guess: the
// real user home has a basename that passes the id charset and must map to null.
import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import { isValidProfileId, profileIdFromHome, PROFILES_ROOT_DIRNAME } from '../../../src/main/profile-id'
import { isValidProfileId as reExported, _setRootsForTest, getProfileConfigDir, getProfilesRoot } from '../../../src/main/account-profiles'

describe('isValidProfileId', () => {
  it('accepts the generated shape and rejects traversal, case, and non-strings', () => {
    expect(isValidProfileId('profile-abc-0f')).toBe(true)
    expect(isValidProfileId('a')).toBe(true)
    expect(isValidProfileId('')).toBe(false)
    expect(isValidProfileId('../x')).toBe(false)
    expect(isValidProfileId('..\\..\\.claude')).toBe(false)
    expect(isValidProfileId('Profile-A')).toBe(false)
    expect(isValidProfileId('-leading')).toBe(false)
    expect(isValidProfileId('x'.repeat(129))).toBe(false)
    expect(isValidProfileId({ toString: () => 'ok' })).toBe(false)
    expect(isValidProfileId(undefined)).toBe(false)
  })

  it('is the SAME function account-profiles exports — one definition of the charset', () => {
    expect(reExported).toBe(isValidProfileId)
  })
})

describe('profileIdFromHome', () => {
  it('recovers the id from a profile home on either separator', () => {
    expect(profileIdFromHome(path.join('F:', 'res', PROFILES_ROOT_DIRNAME, 'profile-a1b2-ff'))).toBe('profile-a1b2-ff')
    expect(profileIdFromHome('/home/pi/res/account-profiles/profile-a1b2-ff')).toBe('profile-a1b2-ff')
    expect(profileIdFromHome('F:\\res\\account-profiles\\profile-a1b2-ff')).toBe('profile-a1b2-ff')
  })

  it('round-trips through the REAL getProfileConfigDir -- the root dirname is one constant, not a copy', () => {
    // If account-profiles ever renamed the profiles root without this module
    // following, every real home would map to null and claude-headless would
    // silently stop registering (#48) and waiting (#49). Build the home the way
    // the app does, not from a literal.
    _setRootsForTest({ resourcesDir: path.join(os.tmpdir(), 'ccc-pid-res'), sharedRoot: path.join(os.tmpdir(), 'ccc-pid-shared') })
    try {
      expect(path.basename(getProfilesRoot())).toBe(PROFILES_ROOT_DIRNAME)
      expect(profileIdFromHome(getProfileConfigDir('profile-a1b2-ff'))).toBe('profile-a1b2-ff')
    } finally {
      _setRootsForTest(null)
    }
  })

  it('maps the default home and any non-profile path to null', () => {
    expect(profileIdFromHome(null)).toBeNull()
    expect(profileIdFromHome(undefined)).toBeNull()
    expect(profileIdFromHome('')).toBeNull()
    expect(profileIdFromHome('/home')).toBeNull()
    // The real user home: the basename passes the charset, the parent is not the profiles root.
    expect(profileIdFromHome('C:\\Users\\nicho')).toBeNull()
    expect(profileIdFromHome('/home/pi')).toBeNull()
    // A profile-shaped basename outside the profiles root is not a profile.
    expect(profileIdFromHome('/res/other/profile-a1b2-ff')).toBeNull()
    // A traversal that lands on a profile-shaped name is not one either.
    expect(profileIdFromHome('/res/account-profiles/../profile-a1b2-ff')).toBeNull()
    // An invalid id under the right parent is still invalid.
    expect(profileIdFromHome('/res/account-profiles/Profile-X')).toBeNull()
  })
})
