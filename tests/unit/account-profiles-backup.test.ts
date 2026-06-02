import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import {
  _setRootsForTest, createProfile, getProfileConfigDir,
  readCanonicalIdentityEmail, getAccountIdentityDir,
  backupProfileHomeToCanonical, captureDetectedAccount, getSessionHomeDir,
} from '../../src/main/account-profiles'

let base: string; let resourcesDir: string; let sharedRoot: string
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-backup-'))
  resourcesDir = path.join(base, 'res'); sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true }); fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => { _setRootsForTest(null); fs.rmSync(base, { recursive: true, force: true }) })

describe('backupProfileHomeToCanonical', () => {
  it('copies home identity into canonical backup', () => {
    const p = createProfile('Test')
    const home = getProfileConfigDir(p.id)
    // Write identity files to the profile home
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }))
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ token: 'tok' }))

    backupProfileHomeToCanonical(p.id)

    expect(readCanonicalIdentityEmail(p.id)).toBe('a@x.com')
    expect(fs.existsSync(path.join(getAccountIdentityDir(p.id), '.credentials.json'))).toBe(true)
  })

  it('is a no-op (does not throw) when the home has no .claude.json', () => {
    const p = createProfile('Empty')
    expect(() => backupProfileHomeToCanonical(p.id)).not.toThrow()
    expect(readCanonicalIdentityEmail(p.id)).toBeNull()
  })

  it('end-to-end: capture-detected reads from session home, not the source profile', () => {
    // Create source profile P2 with its identity backed up canonically.
    const p2 = createProfile('P2')
    const p2Home = getProfileConfigDir(p2.id)
    fs.writeFileSync(path.join(p2Home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'p2@x.com' } }))
    fs.mkdirSync(path.join(p2Home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(p2Home, '.claude', '.credentials.json'), JSON.stringify({ token: 'p2tok' }))
    backupProfileHomeToCanonical(p2.id)

    // Simulate a /login in a SESSION writing a third account into the session home.
    const sessionId = 'sess-e2e'
    const sessHome = getSessionHomeDir(sessionId)
    fs.mkdirSync(path.join(sessHome, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(sessHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'third@x.com' } }))
    fs.writeFileSync(path.join(sessHome, '.claude', '.credentials.json'), JSON.stringify({ token: 'thirdtok' }))

    // captureDetectedAccount reads the SESSION home (not the source profile home).
    const captured = captureDetectedAccount(sessionId, 'Third')

    expect(captured).not.toBeNull()
    expect(captured!.accountEmail).toBe('third@x.com')
    // Source profile home is completely untouched.
    expect(readCanonicalIdentityEmail(p2.id)).toBe('p2@x.com')
  })
})
