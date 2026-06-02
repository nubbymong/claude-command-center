import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import {
  _setRootsForTest, createProfile, getProfileConfigDir, getAccountIdentityDir,
  readCanonicalIdentityEmail, migrateProfilesToCanonicalLayout,
} from '../../src/main/account-profiles'

let base: string; let resourcesDir: string; let sharedRoot: string
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-migcanon-'))
  resourcesDir = path.join(base, 'res'); sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true }); fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => { _setRootsForTest(null); fs.rmSync(base, { recursive: true, force: true }) })

describe('migrateProfilesToCanonicalLayout', () => {
  it('moves home identity into identity/ and leaves the email readable', () => {
    const p = createProfile('Old')
    const home = getProfileConfigDir(p.id)
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'old@x.com' } }))
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"token":"o"}')

    migrateProfilesToCanonicalLayout()

    expect(readCanonicalIdentityEmail(p.id)).toBe('old@x.com')
    expect(fs.existsSync(path.join(getAccountIdentityDir(p.id), '.credentials.json'))).toBe(true)
  })

  it('is idempotent: a profile already in canonical layout is left untouched', () => {
    const p = createProfile('New')
    // simulate already-migrated: identity/.claude.json exists
    const idDir = getAccountIdentityDir(p.id)
    fs.mkdirSync(idDir, { recursive: true })
    fs.writeFileSync(path.join(idDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'keep@x.com' } }))

    migrateProfilesToCanonicalLayout()

    expect(readCanonicalIdentityEmail(p.id)).toBe('keep@x.com')
  })
})
