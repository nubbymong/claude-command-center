import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

import {
  isValidProfileId,
  getProfileConfigDir,
  getProfilesRoot,
  _setRootsForTest,
} from '../../src/main/account-profiles'

// Companion guard to the run-id fix. A profile id is caller-supplied (it arrives
// over IPC on insights:run, and from stored session/agent records elsewhere) and
// becomes a PATH COMPONENT under the profiles root. The resolved path is then
// handed to setupProfileLinks (mkdir + junction creation) and used as the HOME of
// a spawned process, so an unvalidated id is a write primitive, not just a read.
//
// The guard lives in getProfileConfigDir — the single place every profile home is
// built — so all ~20 call sites are covered and a future caller cannot
// reintroduce the pattern by forgetting a check.

describe('isValidProfileId', () => {
  it('accepts the ids the app actually generates', () => {
    // createProfile(): `profile-${Date.now().toString(36)}-${randomBytes(3).hex}`
    expect(isValidProfileId('profile-ms2g2ioy-36efc8')).toBe(true)
    expect(isValidProfileId('profile-mpwf25b0-90707c')).toBe(true)
  })

  it('rejects every separator a traversal could be built from', () => {
    for (const bad of [
      '..',
      '../x',
      '..\\x',
      'a/b',
      'a\\b',
      './x',
      'x/../../y',
      '%2e%2e/x',
      'C:\\Windows',
      '/etc',
      '\\\\server\\share',
      'profile-ok/../..',
    ]) {
      expect(isValidProfileId(bad), bad).toBe(false)
    }
  })

  it('rejects empty, over-long, uppercase, and non-string ids', () => {
    expect(isValidProfileId('')).toBe(false)
    expect(isValidProfileId('a'.repeat(129))).toBe(false)
    expect(isValidProfileId('Profile-Upper')).toBe(false)
    expect(isValidProfileId(undefined)).toBe(false)
    expect(isValidProfileId(null)).toBe(false)
    expect(isValidProfileId(42)).toBe(false)
    // Regressions on the old `RE.test(id)` signature: it stringified its argument
    // first, so an object with a conforming toString() passed the check.
    expect(isValidProfileId({ toString: () => 'profile-abc-123' })).toBe(false)
    expect(isValidProfileId(['profile-abc-123'])).toBe(false)
  })
})

describe('getProfileConfigDir', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'profile-id-guard-'))
    _setRootsForTest({ resourcesDir: join(root, 'resources'), sharedRoot: join(root, 'shared') })
    mkdirSync(getProfilesRoot(), { recursive: true })
  })

  afterEach(() => {
    _setRootsForTest(null)
    rmSync(root, { recursive: true, force: true })
  })

  it('returns a contained path for a valid id', () => {
    const dir = getProfileConfigDir('profile-ms2g2ioy-36efc8')
    expect(resolve(dir)).toBe(resolve(getProfilesRoot(), 'profile-ms2g2ioy-36efc8'))
    expect(resolve(dir).startsWith(resolve(getProfilesRoot()) + sep)).toBe(true)
  })

  it('refuses a traversing id', () => {
    for (const bad of ['../../elsewhere', '..\\..\\elsewhere', 'a/../../b', '..']) {
      expect(() => getProfileConfigDir(bad), bad).toThrow(/invalid profile id/)
    }
  })

  it('the refused ids would otherwise have escaped the profiles root', () => {
    // Pins WHY the guard is needed: reproduce the unguarded join verbatim and show
    // it resolves outside. If path.join ever stopped escaping, this test fails and
    // the guard's rationale is re-examined rather than silently outliving it.
    const profilesRoot = resolve(getProfilesRoot())
    for (const bad of ['../../elsewhere', 'a/../../b']) {
      const unguarded = resolve(join(getProfilesRoot(), bad))
      expect(unguarded.startsWith(profilesRoot + sep), bad).toBe(false)
    }
  })

  it('does not escape on an absolute id either', () => {
    // path.join (unlike path.resolve) does not reset on an absolute later
    // segment, so this was already contained — pin it so a refactor to
    // path.resolve cannot silently open an absolute-path escape.
    expect(() => getProfileConfigDir('/etc')).toThrow(/invalid profile id/)
    expect(() => getProfileConfigDir('C:\\Windows')).toThrow(/invalid profile id/)
  })
})
