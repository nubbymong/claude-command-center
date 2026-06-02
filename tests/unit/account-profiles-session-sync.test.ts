import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import {
  _setRootsForTest, createProfile, upsertProfile, writeCanonicalIdentity,
  getProfileConfigDir, getSessionHomeDir, getAccountIdentityDir,
  readSessionHomeEmail, syncSessionHomeToAccount, readCanonicalIdentityEmail,
} from '../../src/main/account-profiles'

let base: string; let resourcesDir: string; let sharedRoot: string
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-sesssync-'))
  resourcesDir = path.join(base, 'res'); sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true }); fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => { _setRootsForTest(null); fs.rmSync(base, { recursive: true, force: true }) })

function writeSessionHome(sessionId: string, email: string, token: string) {
  const home = getSessionHomeDir(sessionId)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ token }))
}

describe('readSessionHomeEmail', () => {
  it('returns the email from the session home .claude.json', () => {
    const sessionId = 'sess-read1'
    writeSessionHome(sessionId, 'a@x.com', 'tok1')
    expect(readSessionHomeEmail(sessionId)).toBe('a@x.com')
  })

  it('returns null when the session home does not exist', () => {
    expect(readSessionHomeEmail('sess-absent')).toBeNull()
  })

  it('returns null when .claude.json has no email field', () => {
    const sessionId = 'sess-noemail'
    const home = getSessionHomeDir(sessionId)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ noEmail: true }))
    expect(readSessionHomeEmail(sessionId)).toBeNull()
  })
})

describe('syncSessionHomeToAccount', () => {
  it('writes refreshed credentials from session home back to the matching profile canonical + home', () => {
    // Set up a profile whose accountEmail is a@x.com.
    const p = createProfile('Alice')
    upsertProfile({ ...p, accountEmail: 'a@x.com' })
    writeCanonicalIdentity(p.id, {
      claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }),
      credentials: '{"token":"old"}',
    })
    // Seed the profile home .claude.json (mirrors setupSessionHome).
    fs.writeFileSync(path.join(getProfileConfigDir(p.id), '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }))

    // Session home has a refreshed token for the same email.
    const sessionId = 'sess-sync1'
    writeSessionHome(sessionId, 'a@x.com', 'refreshed')

    syncSessionHomeToAccount(sessionId)

    // Canonical identity should now hold the refreshed credentials.
    expect(readCanonicalIdentityEmail(p.id)).toBe('a@x.com')
    const canonCreds = JSON.parse(
      fs.readFileSync(path.join(getAccountIdentityDir(p.id), '.credentials.json'), 'utf8')
    )
    expect(canonCreds.token).toBe('refreshed')

    // Profile home .credentials.json should also be updated.
    const homeCreds = JSON.parse(
      fs.readFileSync(path.join(getProfileConfigDir(p.id), '.claude', '.credentials.json'), 'utf8')
    )
    expect(homeCreds.token).toBe('refreshed')
  })

  it('is a no-op when no profile email matches the session home email', () => {
    // A profile exists but with a different email.
    const p = createProfile('Bob')
    upsertProfile({ ...p, accountEmail: 'bob@x.com' })

    // Session home holds an unrecognised email.
    const sessionId = 'sess-nomatch'
    writeSessionHome(sessionId, 'stranger@x.com', 'tok')

    // Should not throw and should not touch bob's canonical.
    expect(() => syncSessionHomeToAccount(sessionId)).not.toThrow()
    expect(readCanonicalIdentityEmail(p.id)).toBeNull() // never written
  })

  it('is a no-op when the session home does not exist', () => {
    expect(() => syncSessionHomeToAccount('sess-gone')).not.toThrow()
  })

  it('is a no-op when the session home .claude.json has no email', () => {
    const sessionId = 'sess-noemail'
    const home = getSessionHomeDir(sessionId)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ noEmail: true }))
    expect(() => syncSessionHomeToAccount(sessionId)).not.toThrow()
  })
})
