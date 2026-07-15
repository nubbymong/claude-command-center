import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import {
  _setRootsForTest, createProfile, listProfiles, getPrimaryProfileId, setPrimaryProfile,
} from '../../src/main/account-profiles'

let base: string; let resourcesDir: string; let sharedRoot: string
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-primary-'))
  resourcesDir = path.join(base, 'res'); sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true }); fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => { _setRootsForTest(null); fs.rmSync(base, { recursive: true, force: true }) })

describe('getPrimaryProfileId / setPrimaryProfile', () => {
  it('returns null when no profiles exist', () => {
    expect(getPrimaryProfileId()).toBeNull()
  })

  it('marks a profile as primary and getPrimaryProfileId returns its id', () => {
    const a = createProfile('Alice')
    const b = createProfile('Bob')

    setPrimaryProfile(a.id)
    expect(getPrimaryProfileId()).toBe(a.id)

    setPrimaryProfile(b.id)
    expect(getPrimaryProfileId()).toBe(b.id)
  })

  it('clears the flag from all others when setting a new primary (only one primary at a time)', () => {
    const a = createProfile('Alice')
    const b = createProfile('Bob')

    setPrimaryProfile(a.id)
    setPrimaryProfile(b.id)

    const profiles = listProfiles()
    const primaryProfiles = profiles.filter((p) => p.isPrimary)
    expect(primaryProfiles).toHaveLength(1)
    expect(primaryProfiles[0].id).toBe(b.id)
  })
})
