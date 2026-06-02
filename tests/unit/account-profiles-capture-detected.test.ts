import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import {
  _setRootsForTest, createProfile, writeCanonicalIdentity, getProfileConfigDir,
  readProfileAccountEmail, captureDetectedAccount, restoreProfileHomeFromCanonical, listProfiles,
} from '../../src/main/account-profiles'

let base: string; let resourcesDir: string; let sharedRoot: string
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-capdet-'))
  resourcesDir = path.join(base, 'res'); sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true }); fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => { _setRootsForTest(null); fs.rmSync(base, { recursive: true, force: true }) })

function writeHomeIdentity(id: string, email: string, token: string) {
  const home = getProfileConfigDir(id)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ token }))
}

describe('captureDetectedAccount', () => {
  it('captures the new account into a new profile and restores the source from canonical', () => {
    const src = createProfile('Live')
    // canonical backup = the original (live) account
    writeCanonicalIdentity(src.id, { claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'live@x.com' } }), credentials: '{"token":"live"}' })
    // simulate a /login that switched the source home to a NEW account
    writeHomeIdentity(src.id, 'new@x.com', 'newtok')

    const np = captureDetectedAccount(src.id, 'iCloud')

    expect(np).not.toBeNull()
    expect(np!.name).toBe('iCloud')
    expect(np!.accountEmail).toBe('new@x.com')
    expect(np!.isPrimary).not.toBe(true) // a captured account is never primary
    // new profile carries the new account in both layouts
    expect(readProfileAccountEmail(np!.id)).toBe('new@x.com')
    expect(fs.existsSync(path.join(getProfileConfigDir(np!.id), '.claude', '.credentials.json'))).toBe(true)
    // SOURCE restored to its original (live) account
    expect(readProfileAccountEmail(src.id)).toBe('live@x.com')
    // two profiles now
    expect(listProfiles().length).toBe(2)
  })

  it('returns null when the source home has no identity to capture', () => {
    const src = createProfile('Empty')
    expect(captureDetectedAccount(src.id, 'X')).toBeNull()
  })
})

describe('restoreProfileHomeFromCanonical', () => {
  it('restores home identity from canonical and returns true; false when no canonical', () => {
    const p = createProfile('P')
    expect(restoreProfileHomeFromCanonical(p.id)).toBe(false) // no canonical yet
    writeCanonicalIdentity(p.id, { claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }), credentials: '{"token":"t"}' })
    // pollute the home
    fs.writeFileSync(path.join(getProfileConfigDir(p.id), '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'polluted@x.com' } }))
    expect(restoreProfileHomeFromCanonical(p.id)).toBe(true)
    expect(readProfileAccountEmail(p.id)).toBe('a@x.com')
  })
})
