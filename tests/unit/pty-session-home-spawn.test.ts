// Bug 2: verify the spawn-time home-selection logic. EVERY session of an account --
// shell-only AND interactive Claude -- now runs in the account's shared PROFILE home
// (account-profiles/<id>/), so concurrent sessions share ONE rotating-OAuth
// credential store. There is no longer a per-session home under account-homes/.
//
// We test via the account-profiles API directly (the same seam pty-manager uses)
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
  getProfileConfigDir,
  getProfilesRoot,
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

describe('spawn home selection (shared profile home)', () => {
  it('a profile session uses the profile dir as its home (setupProfileLinks + getProfileConfigDir)', () => {
    const p = createProfile('Test')
    writeCanonicalIdentity(p.id, {
      claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'test@example.com' } }),
      credentials: '{"token":"y"}',
    })

    // Simulate what pty-manager does for ANY session with a profileId.
    setupProfileLinks(p.id)
    const home = getProfileConfigDir(p.id)

    expect(home).not.toContain('account-homes') // no per-session home
    expect(home).toContain(p.id)
    expect(fs.existsSync(home)).toBe(true)
    // No account-homes tree is created by the spawn path at all.
    expect(fs.existsSync(getSessionHomesRoot())).toBe(false)
  })

  it('two sessions of the SAME profile resolve to the SAME home and credential file', () => {
    const p = createProfile('Shared')
    setupProfileLinks(p.id)

    // Both sessions (whatever their session ids) resolve to the one profile home.
    const homeForSessionA = getProfileConfigDir(p.id)
    const homeForSessionB = getProfileConfigDir(p.id)
    expect(homeForSessionA).toBe(homeForSessionB)

    // A credential written by one session is the exact file the other reads --
    // no divergence, so rotating OAuth tokens coordinate.
    const credPath = path.join(getProfileConfigDir(p.id), '.claude', '.credentials.json')
    fs.mkdirSync(path.dirname(credPath), { recursive: true })
    fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { refreshToken: 'shared' } }))
    const fromB = JSON.parse(fs.readFileSync(path.join(homeForSessionB, '.claude', '.credentials.json'), 'utf8'))
    expect(fromB.claudeAiOauth.refreshToken).toBe('shared')
  })

  it('different profiles resolve to different homes (isolation preserved)', () => {
    const a = createProfile('A')
    const b = createProfile('B')
    expect(getProfileConfigDir(a.id)).not.toBe(getProfileConfigDir(b.id))
  })

  it('account-homes root is distinct from the account-profiles root', () => {
    const homesRoot = getSessionHomesRoot()
    const profilesRoot = getProfilesRoot()
    expect(path.resolve(homesRoot)).not.toBe(path.resolve(profilesRoot))
    expect(homesRoot).toContain('account-homes')
  })
})
