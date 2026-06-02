import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import {
  _setRootsForTest, createProfile, writeCanonicalIdentity, getProfileConfigDir,
  getSessionHomeDir, readProfileAccountEmail, readCanonicalIdentityEmail,
  captureDetectedAccount, restoreProfileHomeFromCanonical, listProfiles,
} from '../../src/main/account-profiles'

let base: string; let resourcesDir: string; let sharedRoot: string
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-capdet-'))
  resourcesDir = path.join(base, 'res'); sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true }); fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => { _setRootsForTest(null); fs.rmSync(base, { recursive: true, force: true }) })

/** Write a /login result directly into a session's working home. */
function writeSessionHomeIdentity(sessionId: string, email: string, token: string) {
  const home = getSessionHomeDir(sessionId)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ token }))
}

describe('captureDetectedAccount', () => {
  it('captures new account from session home into a fresh profile; source profile untouched', () => {
    const src = createProfile('Live')
    // Give the source profile its canonical identity (the original account).
    writeCanonicalIdentity(src.id, {
      claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'live@x.com' } }),
      credentials: '{"token":"livetok"}',
    })
    // Seed the profile home from canonical (mirrors setupSessionHome behavior).
    const srcHome = getProfileConfigDir(src.id)
    fs.writeFileSync(path.join(srcHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'live@x.com' } }))

    // Simulate a /login in the SESSION writing a new account to the session home.
    const sessionId = 'sess-abc123'
    writeSessionHomeIdentity(sessionId, 'icloud@x.com', 'icloudtok')

    const np = captureDetectedAccount(sessionId, 'iCloud')

    expect(np).not.toBeNull()
    expect(np!.name).toBe('iCloud')
    expect(np!.accountEmail).toBe('icloud@x.com')
    expect(np!.isPrimary).not.toBe(true) // captured accounts are never primary

    // New profile carries the new account identity.
    expect(readProfileAccountEmail(np!.id)).toBe('icloud@x.com')
    expect(fs.existsSync(path.join(getProfileConfigDir(np!.id), '.claude', '.credentials.json'))).toBe(true)
    expect(readCanonicalIdentityEmail(np!.id)).toBe('icloud@x.com')

    // SOURCE PROFILE IS UNTOUCHED — /login only wrote the session home.
    expect(readProfileAccountEmail(src.id)).toBe('live@x.com')
    expect(readCanonicalIdentityEmail(src.id)).toBe('live@x.com')

    // Two profiles now exist.
    expect(listProfiles().length).toBe(2)
  })

  it('returns null when the session home has no identity to capture', () => {
    // No session home at all.
    expect(captureDetectedAccount('sess-empty', 'X')).toBeNull()
  })

  it('returns null when the session home .claude.json has no email', () => {
    const sessionId = 'sess-noemail'
    const home = getSessionHomeDir(sessionId)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ noEmail: true }))
    expect(captureDetectedAccount(sessionId, 'Y')).toBeNull()
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
