// Bug 2 fix: same-account sessions share ONE credential store (the profile home),
// instead of each getting a private per-session copy. Rotating OAuth refresh tokens
// can't survive being copied across N homes, so the per-session-home model forced a
// re-auth on resume. These tests cover the new pieces:
//   - cleanupSessionHomes(): one-time migration that salvages the freshest live token
//     out of the retiring per-session homes into the profile home + canonical, then
//     removes the account-homes tree (junction-safe).
//   - backupProfileHomeToCanonical(): email-guarded so a /login that switches a shared
//     home to a different account can never corrupt the account's canonical backup.
//   - captureDetectedAccount(): reads the PROFILE home (the shared home a /login writes),
//     not a per-session home.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import {
  _setRootsForTest, createProfile, upsertProfile, writeCanonicalIdentity,
  getProfileConfigDir, getAccountIdentityDir, getSessionHomesRoot,
  readCanonicalIdentityEmail, readProfileAccountEmail, listProfiles,
  backupProfileHomeToCanonical, captureDetectedAccount, cleanupSessionHomes,
  restoreProfileHomeFromCanonical,
} from '../../src/main/account-profiles'

let base: string; let resourcesDir: string; let sharedRoot: string
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-credshare-'))
  resourcesDir = path.join(base, 'res'); sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true }); fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => { _setRootsForTest(null); fs.rmSync(base, { recursive: true, force: true }) })

function writeProfileHome(profileId: string, email: string, oauth: object) {
  const home = getProfileConfigDir(profileId)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }))
}

function writeSessionHome(sessionId: string, email: string, oauth: object) {
  const home = path.join(getSessionHomesRoot(), sessionId)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }))
}

function homeRefreshToken(profileId: string): string {
  const raw = fs.readFileSync(path.join(getProfileConfigDir(profileId), '.claude', '.credentials.json'), 'utf8')
  return JSON.parse(raw).claudeAiOauth.refreshToken
}
function canonRefreshToken(profileId: string): string {
  const raw = fs.readFileSync(path.join(getAccountIdentityDir(profileId), '.credentials.json'), 'utf8')
  return JSON.parse(raw).claudeAiOauth.refreshToken
}

describe('cleanupSessionHomes (UPGRADE GUARD: salvage creds, then keep + re-point, never delete)', () => {
  function isJunction(p: string): boolean {
    try { return fs.lstatSync(p).isSymbolicLink() } catch { return false }
  }

  it('salvages the freshest live token into the profile home + canonical, and KEEPS each home re-pointed to canonical', () => {
    const p = createProfile('Live')
    upsertProfile({ ...p, accountEmail: 'live@x.com' })
    // Profile home + canonical hold the STALE seed (this is the dead token that
    // caused re-auth). Two retired session homes hold the live, diverged tokens.
    writeProfileHome(p.id, 'live@x.com', { expiresAt: 1000, refreshToken: 'stale-seed' })
    writeCanonicalIdentity(p.id, {
      claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'live@x.com' } }),
      credentials: JSON.stringify({ claudeAiOauth: { expiresAt: 1000, refreshToken: 'stale-seed' } }),
    })
    writeSessionHome('s1', 'live@x.com', { expiresAt: 3000, refreshToken: 'mid' })
    writeSessionHome('s2', 'live@x.com', { expiresAt: 9000, refreshToken: 'freshest' })

    cleanupSessionHomes()

    // Credential salvage unchanged: freshest token wins.
    expect(homeRefreshToken(p.id)).toBe('freshest')
    expect(canonRefreshToken(p.id)).toBe('freshest')
    // UPGRADE GUARD: homes are KEPT so a resumed session that still names
    // account-homes\<sessionId>\... keeps resolving (the divergence fix).
    expect(fs.existsSync(getSessionHomesRoot())).toBe(true)
    const s1 = path.join(getSessionHomesRoot(), 's1')
    // Private per-session credential copies stripped (Bug-2 cannot recur).
    expect(fs.existsSync(path.join(s1, '.claude.json'))).toBe(false)
    expect(fs.existsSync(path.join(s1, '.claude', '.credentials.json'))).toBe(false)
    // Shared dirs re-pointed to canonical (memory continuity preserved).
    expect(isJunction(path.join(s1, '.claude', 'memory'))).toBe(true)
    expect(isJunction(path.join(s1, '.claude', 'projects'))).toBe(true)
  })

  it('keeps the profile home token when it is already fresher than every session home (homes still kept)', () => {
    const p = createProfile('Live')
    upsertProfile({ ...p, accountEmail: 'live@x.com' })
    writeProfileHome(p.id, 'live@x.com', { expiresAt: 9000, refreshToken: 'already-fresh' })
    writeSessionHome('s1', 'live@x.com', { expiresAt: 1000, refreshToken: 'old' })

    cleanupSessionHomes()

    expect(homeRefreshToken(p.id)).toBe('already-fresh')
    expect(fs.existsSync(getSessionHomesRoot())).toBe(true)
  })

  it('does not salvage a session home that matches no profile, but still keeps + re-points it', () => {
    const p = createProfile('Live')
    upsertProfile({ ...p, accountEmail: 'live@x.com' })
    writeProfileHome(p.id, 'live@x.com', { expiresAt: 5000, refreshToken: 'mine' })
    writeSessionHome('orphan', 'stranger@x.com', { expiresAt: 9999, refreshToken: 'not-mine' })

    cleanupSessionHomes()

    expect(homeRefreshToken(p.id)).toBe('mine') // unchanged by the stranger
    const orphan = path.join(getSessionHomesRoot(), 'orphan')
    expect(fs.existsSync(orphan)).toBe(true)
    expect(fs.existsSync(path.join(orphan, '.claude', '.credentials.json'))).toBe(false)
    expect(isJunction(path.join(orphan, '.claude', 'memory'))).toBe(true)
  })

  it('re-points a session home junction WITHOUT deleting its target (critical safety invariant)', () => {
    fs.mkdirSync(path.join(sharedRoot, 'projects'), { recursive: true })
    fs.writeFileSync(path.join(sharedRoot, 'projects', 'keep.txt'), 'keep')
    const homesRoot = getSessionHomesRoot()
    const sHome = path.join(homesRoot, 's1', '.claude')
    fs.mkdirSync(sHome, { recursive: true })
    fs.writeFileSync(path.join(homesRoot, 's1', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }))
    fs.symlinkSync(path.join(sharedRoot, 'projects'), path.join(sHome, 'projects'), 'junction')

    cleanupSessionHomes()

    // Home kept; junction TARGET never deleted (the never-wipe invariant).
    expect(fs.existsSync(homesRoot)).toBe(true)
    expect(fs.readFileSync(path.join(sharedRoot, 'projects', 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('is a no-op when there are no session homes', () => {
    expect(() => cleanupSessionHomes()).not.toThrow()
  })
})

describe('backupProfileHomeToCanonical (email-guarded)', () => {
  it('backs up when the home identity matches the profile account (token refresh)', () => {
    const p = createProfile('X')
    upsertProfile({ ...p, accountEmail: 'a@x.com' })
    writeProfileHome(p.id, 'a@x.com', { expiresAt: 5000, refreshToken: 'fresh' })

    backupProfileHomeToCanonical(p.id)

    expect(readCanonicalIdentityEmail(p.id)).toBe('a@x.com')
    expect(canonRefreshToken(p.id)).toBe('fresh')
  })

  it('SKIPS backup when the home drifted to a different account (protects canonical)', () => {
    const p = createProfile('X')
    upsertProfile({ ...p, accountEmail: 'orig@x.com' })
    writeCanonicalIdentity(p.id, {
      claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'orig@x.com' } }),
      credentials: JSON.stringify({ claudeAiOauth: { refreshToken: 'orig' } }),
    })
    // A /login switched the SHARED home to a different account.
    writeProfileHome(p.id, 'switched@y.com', { refreshToken: 'switched' })

    backupProfileHomeToCanonical(p.id)

    // Canonical must NOT have been clobbered by the switch.
    expect(readCanonicalIdentityEmail(p.id)).toBe('orig@x.com')
    expect(canonRefreshToken(p.id)).toBe('orig')
  })

  it('still backs up a first capture when the profile has no accountEmail yet', () => {
    const p = createProfile('New') // accountEmail '' (placeholder)
    writeProfileHome(p.id, 'first@x.com', { refreshToken: 't' })

    backupProfileHomeToCanonical(p.id)

    expect(readCanonicalIdentityEmail(p.id)).toBe('first@x.com')
  })

  it('is a no-op (does not throw) when the home has no .claude.json', () => {
    const p = createProfile('Empty')
    expect(() => backupProfileHomeToCanonical(p.id)).not.toThrow()
    expect(readCanonicalIdentityEmail(p.id)).toBeNull()
  })

  it('SKIPS backup when the home .claude.json has no email but the profile has a known account', () => {
    const p = createProfile('X')
    upsertProfile({ ...p, accountEmail: 'good@x.com' })
    writeCanonicalIdentity(p.id, {
      claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'good@x.com' } }),
      credentials: JSON.stringify({ claudeAiOauth: { refreshToken: 'good' } }),
    })
    // A .claude.json exists but has no parseable oauthAccount.emailAddress
    // (an in-progress/corrupt login). It must not clobber the good canonical.
    const home = getProfileConfigDir(p.id)
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ noOauth: true }))
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { refreshToken: 'junk' } }))

    backupProfileHomeToCanonical(p.id)

    expect(readCanonicalIdentityEmail(p.id)).toBe('good@x.com')
    expect(canonRefreshToken(p.id)).toBe('good')
  })
})

describe('restoreProfileHomeFromCanonical', () => {
  it('restores home identity from canonical and returns true; false when no canonical', () => {
    const p = createProfile('P')
    expect(restoreProfileHomeFromCanonical(p.id)).toBe(false) // no canonical yet
    writeCanonicalIdentity(p.id, {
      claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }),
      credentials: '{"token":"t"}',
    })
    // Pollute the home (a /login switch), then restore.
    fs.writeFileSync(path.join(getProfileConfigDir(p.id), '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'polluted@x.com' } }))
    expect(restoreProfileHomeFromCanonical(p.id)).toBe(true)
    expect(readProfileAccountEmail(p.id)).toBe('a@x.com')
  })
})

describe('captureDetectedAccount (reads the shared profile home)', () => {
  it('captures a switched account out of the profile home into a fresh profile', () => {
    const src = createProfile('Live')
    upsertProfile({ ...src, accountEmail: 'live@x.com' })
    writeCanonicalIdentity(src.id, {
      claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'live@x.com' } }),
      credentials: JSON.stringify({ claudeAiOauth: { refreshToken: 'livetok' } }),
    })
    // A /login wrote a new, unknown account into the SHARED profile home.
    writeProfileHome(src.id, 'icloud@x.com', { refreshToken: 'ictok' })

    const np = captureDetectedAccount(src.id, 'iCloud')

    expect(np).not.toBeNull()
    expect(np!.name).toBe('iCloud')
    expect(np!.accountEmail).toBe('icloud@x.com')
    expect(np!.isPrimary).not.toBe(true)
    expect(readProfileAccountEmail(np!.id)).toBe('icloud@x.com')
    expect(readCanonicalIdentityEmail(np!.id)).toBe('icloud@x.com')
    expect(listProfiles().length).toBe(2)
  })

  it('returns null for an unknown / invalid profile id', () => {
    expect(captureDetectedAccount('no-such-profile', 'X')).toBeNull()
  })

  it('returns null when the profile home has no email to capture', () => {
    const p = createProfile('Empty')
    expect(captureDetectedAccount(p.id, 'Y')).toBeNull()
  })
})
