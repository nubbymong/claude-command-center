// WP1.38 -- WP2 commit 5b: a Claude reviewer launch composes exactly what a
// session's profile home composes (withProfileHome), through the accounts
// service's hardening instead of its own; account-profiles stays the only
// module that composes a profile home's variables. On macOS the review runs
// on the normal sign-in -- the primary account, nothing redirected.
//
// HOST QUARANTINE: this suite builds profile homes (folders and links) under
// a temp resources folder. It runs in CI and on the VM, never on the owner's
// workstation. The source environment is synthetic: nothing is read from, or
// written to, this process's own environment.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { realmEnvForProvider } from '../../src/main/providers/core'
import { composeProviders } from '../../src/main/providers/compose'

describe('a reviewer launch in a profile home (WP2 5b)', () => {
  let tmp = ''
  let profiles: typeof import('../../src/main/account-profiles')
  const realPlatform = process.platform
  const source = (bin: string): Record<string, string> => ({ PATH: bin, EDITOR: 'vim', ANTHROPIC_BASE_URL: 'http://example.invalid' })

  beforeAll(async () => {
    composeProviders()
    profiles = await import('../../src/main/account-profiles')
  })
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-review-home-'))
    profiles._setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'shared') })
    fs.mkdirSync(path.join(tmp, 'resources'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'shared'), { recursive: true })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    profiles._setRootsForTest(null)
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('sets the profile home up; hardened, the reviewer\'s environment IS the session\'s', () => {
    const p = profiles.createProfile('Reviewer')
    const home = profiles.getProfileConfigDir(p.id)
    fs.rmSync(home, { recursive: true, force: true })
    const src = source(path.join(tmp, 'bin'))
    const l = profiles.profileRealmLaunch(p.id, src)
    if ('refused' in l) throw new Error(l.refused)
    expect(l.home).toBe(home)
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(true)
    expect(l.sessionsDir).toBe(path.join(home, '.claude', 'projects'))
    expect(l.realmEnv.set.USERPROFILE).toBe(home)
    expect(realmEnvForProvider('claude', l.baseEnv, l.realmEnv)).toEqual(profiles.withProfileHome({ ...src }, home))
  })

  it('records the ambient variables the hardening will remove, and the hardening removes them', () => {
    const p = profiles.createProfile('Reviewer')
    const l = profiles.profileRealmLaunch(p.id, source(path.join(tmp, 'bin')))
    if ('refused' in l) throw new Error(l.refused)
    expect(profiles.lastAmbientStripFor(l.home)).toContain('ANTHROPIC_BASE_URL')
    const hardened = realmEnvForProvider('claude', l.baseEnv, l.realmEnv)
    expect(hardened.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(hardened.EDITOR).toBe('vim')
  })

  it('refuses an id that is not a profile id, before touching anything', () => {
    for (const bad of ['../x', '', 'Profile-A', 'a/b']) expect(() => profiles.profileRealmLaunch(bad, source('/bin')), bad).toThrow()
    expect(fs.existsSync(profiles.getProfilesRoot())).toBe(false)
  })

  it('on macOS runs on the normal sign-in, for the primary account only: the real home, nothing redirected', () => {
    const primary = profiles.createProfile('Primary')
    const other = profiles.createProfile('Other')
    profiles.setPrimaryProfile(primary.id)
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const l = profiles.profileRealmLaunch(primary.id, source('/usr/bin'))
    expect(l).toEqual({ home: os.homedir(), baseEnv: source('/usr/bin'), realmEnv: { set: {} }, sessionsDir: path.join(os.homedir(), '.claude', 'projects') })
    expect(profiles.profileRealmLaunch(other.id, source('/usr/bin'))).toEqual({ refused: expect.stringContaining('primary account') })
  })
})
