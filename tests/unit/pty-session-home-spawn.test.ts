// Verify the spawn-time home-selection logic (RW-3):
//  - non-shell Claude session with a valid profileId → per-session home under account-homes/
//  - shell-only session with the same profileId       → profile dir directly
//  - teardownSessionHome removes the non-shell session home on exit
//
// We test via the account-profiles API directly (same seam used by pty-manager)
// rather than mocking the full PTY harness, which would be prohibitively heavy.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _setRootsForTest,
  createProfile,
  writeCanonicalIdentity,
  setupProfileLinks,
  setupSessionHome,
  teardownSessionHome,
  getProfileConfigDir,
  getProfilesRoot,
  getSessionHomeDir,
  getSessionHomesRoot,
} from '../../src/main/account-profiles'

let base: string
let resourcesDir: string
let sharedRoot: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-spawnh-'))
  resourcesDir = path.join(base, 'res')
  sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true })
  fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => {
  _setRootsForTest(null)
  fs.rmSync(base, { recursive: true, force: true })
})

describe('RW-3 spawn home selection', () => {
  it('non-shell session: setupSessionHome creates home under account-homes/<sessionId>', () => {
    const p = createProfile('Test')
    writeCanonicalIdentity(p.id, {
      claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'test@example.com' } }),
      credentials: '{"token":"y"}',
    })

    // Simulate what pty-manager does for a non-shell Claude session with a profileId.
    const home = setupSessionHome('sess-nonshell-1', p.id)

    // Must be under account-homes/<sessionId>, NOT the profile dir.
    expect(home).toBe(getSessionHomeDir('sess-nonshell-1'))
    expect(home).toContain(path.join('account-homes', 'sess-nonshell-1'))
    expect(fs.existsSync(home)).toBe(true)

    // Identity seeded from canonical.
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toContain('test@example.com')
    expect(fs.existsSync(path.join(home, '.claude', '.credentials.json'))).toBe(true)

    // Profile dir itself is NOT used as the home.
    expect(home).not.toBe(getProfileConfigDir(p.id))
  })

  it('shell-only session: uses profile dir directly (setupProfileLinks + getProfileConfigDir)', () => {
    const p = createProfile('Shell')
    writeCanonicalIdentity(p.id, {
      claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'shell@example.com' } }),
    })

    // Simulate what pty-manager does for a shell-only session with a profileId.
    setupProfileLinks(p.id)
    const home = getProfileConfigDir(p.id)

    // Must be the profile dir, NOT under account-homes.
    expect(home).not.toContain('account-homes')
    expect(home).toContain(p.id)
    expect(fs.existsSync(home)).toBe(true)
    // No session home created in account-homes.
    const sessionHome = getSessionHomeDir('sess-shell-1')
    expect(fs.existsSync(sessionHome)).toBe(false)
  })

  it('teardownSessionHome removes the non-shell session home on exit', () => {
    const p = createProfile('Exit')
    writeCanonicalIdentity(p.id, { claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'exit@example.com' } }) })
    // Also create a shared dir so teardown can exercise the junction removal path.
    fs.mkdirSync(path.join(sharedRoot, 'projects'), { recursive: true })
    fs.writeFileSync(path.join(sharedRoot, 'projects', 'keep.txt'), 'keep')

    const home = setupSessionHome('sess-exit-1', p.id)
    expect(fs.existsSync(home)).toBe(true)

    teardownSessionHome('sess-exit-1')

    // Session home torn down.
    expect(fs.existsSync(home)).toBe(false)
    // Junction target (shared projects) unharmed.
    expect(fs.readFileSync(path.join(sharedRoot, 'projects', 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('teardownSessionHome is a no-op when no session home was created (shell-only path)', () => {
    // This should not throw and should not affect anything.
    expect(() => teardownSessionHome('sess-never-created')).not.toThrow()
  })

  it('account-homes root is distinct from account-profiles root', () => {
    // Belt-and-suspenders: confirm the two roots don't overlap.
    const homesRoot = getSessionHomesRoot()
    const profilesRoot = getProfilesRoot()
    expect(path.resolve(homesRoot)).not.toBe(path.resolve(profilesRoot))
    expect(homesRoot).toContain('account-homes')
  })
})
