// #48: claude-headless recovers the profile a run belongs to from its HOME path,
// so it can register as a consumer without importing the account-profiles graph.
// The inverse is structural (`<...>/account-profiles/<id>`), never a guess: the
// real user home has a basename that passes the id charset and must map to null.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

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

// Adversarial pass on #598: Windows and macOS hand a path back in whatever case
// it was asked with (Windows also in 8.3 short form); the directory is the same
// one, and reading it as "not a profile" silently dropped the consumer
// registration (#48) and the rotation wait (#49).
describe('profileIdFromHome compares the parent segment the way the filesystem does', () => {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'

  it('a differently-cased profiles-root segment maps to the id on a case-insensitive platform, to null elsewhere', () => {
    expect(profileIdFromHome(path.join('F:', 'res', 'Account-Profiles', 'profile-a1b2-ff'))).toBe(caseInsensitive ? 'profile-a1b2-ff' : null)
    expect(profileIdFromHome('/res/ACCOUNT-PROFILES/profile-a1b2-ff')).toBe(caseInsensitive ? 'profile-a1b2-ff' : null)
  })

  it('an EXISTING parent is judged by its on-disk name; a missing one by its text, without throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-pid-case-'))
    try {
      fs.mkdirSync(path.join(root, PROFILES_ROOT_DIRNAME, 'profile-a1b2-ff'), { recursive: true })
      // The same directory asked for in another case resolves through its real path.
      expect(profileIdFromHome(path.join(root, PROFILES_ROOT_DIRNAME.toUpperCase(), 'profile-a1b2-ff'))).toBe(caseInsensitive ? 'profile-a1b2-ff' : null)
      // A parent that does not exist is judged on its text.
      expect(profileIdFromHome(path.join(root, 'nowhere', PROFILES_ROOT_DIRNAME, 'profile-a1b2-ff'))).toBe('profile-a1b2-ff')
      expect(profileIdFromHome(path.join(root, 'nowhere', 'elsewhere', 'profile-a1b2-ff'))).toBeNull()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('the id itself stays exact: a differently-cased id is not a profile', () => {
    expect(profileIdFromHome(path.join('F:', 'res', PROFILES_ROOT_DIRNAME, 'Profile-A1B2'))).toBeNull()
  })

  it('REGRESSION (re-attack on #598): a profiles root that is a junction to a differently named directory still names its profiles', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-pid-junction-'))
    try {
      const target = path.join(root, 'profiles-elsewhere')
      fs.mkdirSync(path.join(target, 'profile-a1b2-ff'), { recursive: true })
      const link = path.join(root, PROFILES_ROOT_DIRNAME)
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      // The on-disk name of the parent is `profiles-elsewhere`; the TEXT still says
      // account-profiles, and either is enough.
      expect(profileIdFromHome(path.join(link, 'profile-a1b2-ff'))).toBe('profile-a1b2-ff')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('a Windows 8.3 short name for the profiles root resolves through its on-disk name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-pid-short-'))
    try {
      const long = path.join(root, PROFILES_ROOT_DIRNAME)
      fs.mkdirSync(path.join(long, 'profile-a1b2-ff'), { recursive: true })
      const short = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${long}').ShortPath`],
        { encoding: 'utf8', windowsHide: true },
      ).trim()
      // 8.3 name generation can be disabled for a volume; then the "short" path IS
      // the long one and there is nothing to exercise here.
      if (path.basename(short).toLowerCase() === PROFILES_ROOT_DIRNAME) return
      expect(path.basename(short)).toContain('~')
      expect(profileIdFromHome(path.join(short, 'profile-a1b2-ff'))).toBe('profile-a1b2-ff')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
