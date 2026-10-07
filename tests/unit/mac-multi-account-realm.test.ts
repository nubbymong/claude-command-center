// Experimental macOS multi-account realm (src/shared/mac-multi-account.ts).
//
// With the setting OFF, macOS composes exactly what it did before for the PRIMARY
// (D2: one Claude account, HOME left real for the login keychain, #117), and a
// NON-primary profile's launch is refused (pass 3, M4). With it ON, a
// NON-primary profile runs with CLAUDE_CONFIG_DIR (and the secure-storage and
// Anthropic store roots) pointed at ONE stable string per profile -- Claude Code
// keys its macOS Keychain entry by a hash of that string -- and HOME is still
// the real home. win32 and Linux never change, setting on or off.
//
// HOST QUARANTINE: profile homes are created under a temp resources folder;
// the source environment is synthetic.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { composeProviders } from '../../src/main/providers/compose'
import { realmEnvForProvider } from '../../src/main/providers/core'
import { claudeOwnedLaunchVariables, claudeAuthorityVariables } from '../../src/main/providers/claude'
import { macMultiAccountEnabled, claudeMultiAccountBlocked, MAC_MULTI_ACCOUNT_SETTING } from '../../src/shared/mac-multi-account'
import { _resetMacRealmVerdictsForTest } from '../../src/main/mac-realm-verdict'
import { seedMacRealmVerdict } from './helpers/mac-realm-verdict-seed'

const REALM_KEYS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR'] as const

describe('the macOS multi-account setting rule (shared by main and renderer)', () => {
  it('is on only on darwin with the saved value exactly true', () => {
    expect(macMultiAccountEnabled('darwin', { [MAC_MULTI_ACCOUNT_SETTING]: true })).toBe(true)
    for (const v of [false, undefined, null, 'true', 1, {}]) {
      expect(macMultiAccountEnabled('darwin', { [MAC_MULTI_ACCOUNT_SETTING]: v }), String(v)).toBe(false)
    }
    expect(macMultiAccountEnabled('darwin', {})).toBe(false)
    expect(macMultiAccountEnabled('darwin', null)).toBe(false)
    for (const p of ['win32', 'linux', undefined, 'freebsd']) {
      expect(macMultiAccountEnabled(p, { [MAC_MULTI_ACCOUNT_SETTING]: true }), String(p)).toBe(false)
    }
  })

  it('blocks multi-account on darwin only, and only while the setting is off', () => {
    expect(claudeMultiAccountBlocked('darwin', {})).toBe(true)
    expect(claudeMultiAccountBlocked('darwin', { [MAC_MULTI_ACCOUNT_SETTING]: true })).toBe(false)
    for (const p of ['win32', 'linux']) {
      expect(claudeMultiAccountBlocked(p, {})).toBe(false)
      expect(claudeMultiAccountBlocked(p, { [MAC_MULTI_ACCOUNT_SETTING]: true })).toBe(false)
    }
  })
})

describe('the Claude package owns CLAUDE_CONFIG_DIR, and still strips it everywhere', () => {
  it('is an owned launch variable (settable by the realm patch) ruled `strip` on both axes', () => {
    expect(claudeOwnedLaunchVariables).toContain('CLAUDE_CONFIG_DIR')
    const entry = claudeAuthorityVariables().find((v) => v.name === 'CLAUDE_CONFIG_DIR')
    expect(entry?.ambient).toBe('strip')
    expect(entry?.settingsEnv).toBe('strip')
  })

  it('an inherited value is removed by the policy whatever the patch sets', () => {
    composeProviders()
    const env = realmEnvForProvider('claude', { CLAUDE_CONFIG_DIR: '/elsewhere', PATH: '/x' }, { set: { USERPROFILE: '/h' } })
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    const set = realmEnvForProvider('claude', { CLAUDE_CONFIG_DIR: '/elsewhere' }, { set: { CLAUDE_CONFIG_DIR: '/h/.claude' } })
    expect(set.CLAUDE_CONFIG_DIR).toBe('/h/.claude')
  })
})

describe('the macOS realm on a profile home', () => {
  let tmp = ''
  let profiles: typeof import('../../src/main/account-profiles')
  const realPlatform = process.platform
  let flag = false
  const asPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p })
  const REAL_HOME = '/Users/someone'
  const source = (): Record<string, string> => ({ PATH: '/usr/bin', HOME: REAL_HOME, CLAUDE_CONFIG_DIR: '/poison', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/poison', ANTHROPIC_CONFIG_DIR: '/poison' })

  beforeAll(async () => {
    composeProviders()
    profiles = await import('../../src/main/account-profiles')
  })
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-multi-realm-'))
    profiles._setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'shared') })
    fs.mkdirSync(path.join(tmp, 'resources'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'shared'), { recursive: true })
    flag = false
    profiles.setMacMultiAccountProbe(() => flag)
    _resetMacRealmVerdictsForTest()
  })
  afterEach(() => {
    asPlatform(realPlatform)
    profiles.setMacMultiAccountProbe(() => false)
    profiles._setRootsForTest(null)
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function twoProfiles() {
    const primary = profiles.createProfile('Primary')
    const other = profiles.createProfile('Other')
    profiles.setPrimaryProfile(primary.id)
    const r = { primary, other, primaryHome: profiles.getProfileConfigDir(primary.id), otherHome: profiles.getProfileConfigDir(other.id) }
    // These tests are about the realm ENVIRONMENT: the #172 guard is passed
    // (its own tests are in mac-realm-guard.test.ts).
    seedMacRealmVerdict(tmp, r.primaryHome, r.otherHome)
    return r
  }

  it('setting OFF on macOS: the PRIMARY gets exactly the D2 environment -- USERPROFILE only, HOME real, every realm root stripped', () => {
    const { primaryHome, otherHome } = twoProfiles()
    asPlatform('darwin')
    const env = profiles.withProfileHome(source(), primaryHome)
    expect(env.USERPROFILE).toBe(primaryHome)
    expect(env.HOME).toBe(REAL_HOME)
    for (const k of REALM_KEYS) expect(env[k], k).toBeUndefined()
    expect(profiles.macProfileConfigDir(otherHome)).toBeNull()
    expect(profiles.profileRealmConfigRoot(otherHome)).toBeNull()
    expect(profiles.profileSecureStorageRoot(otherHome)).toBeNull()
  })

  // Adversarial review pass 3, M4: a non-primary macOS profile with the setting
  // OFF would run on the primary's Keychain sign-in while labelled as itself.
  it('M4: setting OFF on macOS, a NON-primary profile launch is REFUSED with the managed-launch marker and the reason', () => {
    const { otherHome } = twoProfiles()
    asPlatform('darwin')
    let err: unknown
    try { profiles.withProfileHome(source(), otherHome) } catch (e) { err = e }
    expect(String((err as Error)?.message)).toContain(profiles.MANAGED_LAUNCH_REFUSAL)
    expect(String((err as Error)?.message)).toContain(profiles.MAC_MULTI_ACCOUNT_OFF_REFUSAL)
    expect(profiles.MAC_MULTI_ACCOUNT_OFF_REFUSAL).toMatch(/turned off; turn it on in Settings > Accounts or use your normal sign-in/)
    // Turned on: the same launch runs on its own realm.
    flag = true
    expect(profiles.withProfileHome(source(), otherHome).CLAUDE_CONFIG_DIR).toBe(path.resolve(otherHome, '.claude').normalize('NFC'))
  })

  it('M4/r7: a home that is no profile is not refused; with profiles.json unreadable the primary cannot be told -- refused', () => {
    const { otherHome } = twoProfiles()
    asPlatform('darwin')
    expect(() => profiles.withProfileHome(source(), path.join(tmp, 'not-a-profile'))).not.toThrow()
    fs.writeFileSync(path.join(profiles.getProfilesRoot(), 'profiles.json'), '{not json')
    expect(() => profiles.withProfileHome(source(), otherHome)).toThrow(profiles.MAC_MULTI_ACCOUNT_OFF_REFUSAL_UNKNOWN)
  })

  it('setting ON, a non-primary profile on macOS: one stable config dir keys all three; HOME stays the real home', () => {
    const { otherHome } = twoProfiles()
    asPlatform('darwin')
    flag = true
    const env = profiles.withProfileHome(source(), otherHome)
    const dir = path.resolve(otherHome, '.claude').normalize('NFC')
    expect(env.CLAUDE_CONFIG_DIR).toBe(dir)
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(dir)
    expect(env.ANTHROPIC_CONFIG_DIR).toBe(path.join(dir, 'anthropic'))
    // HOME is never redirected on macOS: the login keychain is found through it (#117).
    expect(env.HOME).toBe(REAL_HOME)
    expect(env.USERPROFILE).toBe(otherHome)
    // The Keychain entry is keyed by the STRING: absolute, no tilde, no
    // trailing separator, NFC, and the same on every launch.
    expect(path.isAbsolute(dir)).toBe(true)
    expect(dir.includes('~')).toBe(false)
    expect(dir.endsWith(path.sep)).toBe(false)
    expect(dir).toBe(dir.normalize('NFC'))
    expect(profiles.withProfileHome(source(), otherHome).CLAUDE_CONFIG_DIR).toBe(dir)
    // Exactly these keys are added over the setting-off environment (the
    // primary's: a non-primary is refused with the setting off, M4).
    asPlatform('darwin')
    flag = false
    const off = profiles.withProfileHome(source(), profiles.getProfileConfigDir(profiles.listProfiles().find((p) => p.isPrimary)!.id))
    flag = true
    const added = Object.keys(env).filter((k) => !(k in off)).sort()
    expect(added).toEqual([...REALM_KEYS].sort())
  })

  it('two non-primary profiles get two different config dirs', () => {
    const { otherHome } = twoProfiles()
    const third = profiles.createProfile('Third')
    const thirdHome = profiles.getProfileConfigDir(third.id)
    seedMacRealmVerdict(tmp, thirdHome)
    asPlatform('darwin')
    flag = true
    const a = profiles.withProfileHome(source(), otherHome).CLAUDE_CONFIG_DIR
    const b = profiles.withProfileHome(source(), thirdHome).CLAUDE_CONFIG_DIR
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(a).not.toBe(b)
  })

  it('setting ON, the PRIMARY profile on macOS: unchanged -- it is the normal sign-in on the real ~/.claude', () => {
    const { primaryHome } = twoProfiles()
    asPlatform('darwin')
    flag = true
    const on = profiles.withProfileHome(source(), primaryHome)
    flag = false
    const off = profiles.withProfileHome(source(), primaryHome)
    expect(on).toEqual(off)
    for (const k of REALM_KEYS) expect(on[k], k).toBeUndefined()
  })

  it('setting ON but profiles.json unreadable: isolates (a sign-in prompt, never another profile on the real sign-in)', () => {
    const { primaryHome } = twoProfiles()
    const meta = path.join(profiles.getProfilesRoot(), 'profiles.json')
    expect(fs.existsSync(meta)).toBe(true)
    fs.writeFileSync(meta, '{not json')
    asPlatform('darwin')
    flag = true
    expect(profiles.withProfileHome(source(), primaryHome).CLAUDE_CONFIG_DIR).toBe(path.resolve(primaryHome, '.claude').normalize('NFC'))
  })

  it('a probe that throws is OFF (a non-primary launch is then refused, M4; the primary runs unredirected)', () => {
    const { otherHome, primaryHome } = twoProfiles()
    asPlatform('darwin')
    profiles.setMacMultiAccountProbe(() => { throw new Error('settings unreadable') })
    expect(() => profiles.withProfileHome(source(), otherHome)).toThrow(profiles.MAC_MULTI_ACCOUNT_OFF_REFUSAL)
    expect(profiles.withProfileHome(source(), primaryHome).CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  for (const platform of ['win32', 'linux'] as const) {
    it(`${platform}: the setting changes nothing`, () => {
      const { otherHome, primaryHome } = twoProfiles()
      asPlatform(platform)
      for (const home of [otherHome, primaryHome]) {
        flag = false
        const off = profiles.withProfileHome(source(), home)
        flag = true
        const on = profiles.withProfileHome(source(), home)
        expect(on).toEqual(off)
        expect(on.CLAUDE_CONFIG_DIR).toBeUndefined()
        expect(profiles.profileIdentityFile(home)).toBe(path.join(home, '.claude.json'))
      }
    })
  }

  it('the identity file: <home>/.claude.json, or inside the config dir on the macOS realm', () => {
    const { other, otherHome, primaryHome } = twoProfiles()
    asPlatform('darwin')
    expect(profiles.profileIdentityFile(otherHome)).toBe(path.join(otherHome, '.claude.json'))
    flag = true
    const dir = path.resolve(otherHome, '.claude').normalize('NFC')
    expect(profiles.profileIdentityFile(otherHome)).toBe(path.join(dir, '.claude.json'))
    // The primary runs with no redirect, so its identity is the REAL home's
    // file (the test seam's real home is the shared root's parent).
    expect(profiles.profileIdentityFile(primaryHome)).toBe(path.join(tmp, '.claude.json'))
    flag = false
    expect(profiles.profileIdentityFile(primaryHome)).toBe(path.join(primaryHome, '.claude.json'))
    flag = true
    // The email reader follows it.
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(otherHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'stale@example.com' } }))
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'realm@example.com' } }))
    expect(profiles.readProfileAccountEmail(other.id)).toBe('realm@example.com')
    flag = false
    expect(profiles.readProfileAccountEmail(other.id)).toBe('stale@example.com')
  })

  // The SYNCHRONOUS file paths refuse on the realm; the capture IPC uses the
  // async seam variants, which move/clear the Keychain item
  // (mac-multi-account-credential-seam.test.ts).
  it('the synchronous file capture/restore refuse on the macOS realm (they cannot reach the Keychain)', () => {
    const { other, otherHome } = twoProfiles()
    asPlatform('darwin')
    flag = true
    const dir = path.resolve(otherHome, '.claude').normalize('NFC')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'new@example.com' } }))
    const before = profiles.listProfiles().length
    expect(profiles.captureDetectedAccount(other.id, 'New')).toBeNull()
    expect(profiles.listProfiles().length).toBe(before)
    expect(profiles.restoreProfileIdentityFromCanonical(other.id)).toBe(false)
    expect(profiles.profileOnMacRealm(other.id)).toBe(true)
  })

  it('reviews: with the setting on, no macOS profile is refused; with it off, only the primary reviews', () => {
    const { primary, other } = twoProfiles()
    expect(profiles.profileReviewRefusal(other.id, 'darwin')).toMatch(/normal Claude sign-in/)
    flag = true
    expect(profiles.profileReviewRefusal(other.id, 'darwin')).toBeNull()
    expect(profiles.profileReviewRefusal(primary.id, 'darwin')).toBeNull()
    for (const p of ['win32', 'linux'] as const) expect(profiles.profileReviewRefusal(other.id, p)).toBeNull()
    // The primary's review launch is still the normal sign-in, nothing redirected.
    asPlatform('darwin')
    const l = profiles.profileRealmLaunch(primary.id, { PATH: '/usr/bin' })
    expect(l).toEqual({ home: os.homedir(), baseEnv: { PATH: '/usr/bin' }, realmEnv: { set: {} }, sessionsDir: path.join(os.homedir(), '.claude', 'projects') })
  })

  it('reviews: a non-primary review launch on the macOS realm carries the same realm set as its session', (ctx) => {
    const { other, otherHome } = twoProfiles()
    asPlatform('darwin')
    flag = true
    let l: ReturnType<typeof profiles.profileRealmLaunch>
    try {
      l = profiles.profileRealmLaunch(other.id, { PATH: '/usr/bin', HOME: REAL_HOME })
    } catch (e) {
      // setupProfileLinks builds POSIX links; a Windows runner without the
      // symlink privilege cannot. The env assertions above cover the realm set.
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    if ('refused' in l) throw new Error(l.refused)
    const dir = path.resolve(otherHome, '.claude').normalize('NFC')
    expect(l.home).toBe(otherHome)
    expect(l.realmEnv.set).toEqual({ USERPROFILE: otherHome, CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: dir, ANTHROPIC_CONFIG_DIR: path.join(dir, 'anthropic') })
    const hardened = realmEnvForProvider('claude', l.baseEnv, l.realmEnv)
    expect(hardened.HOME).toBe(REAL_HOME)
    expect(hardened.CLAUDE_CONFIG_DIR).toBe(dir)
  })
})
