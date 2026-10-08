// @vitest-environment node
//
// The credential platform seam (account-profiles: profileCredentialLocation
// and the functions routed through it) with the experimental macOS
// multi-account setting on/off, and on win32/linux. The `security` process is
// faked (claude-credential-store-darwin's runner seam); every file is under a
// temp root. Asserts the two invariants that matter most: off macOS nothing
// runs `security` at all, and on macOS with the setting off nothing READS or
// WRITES through it (the one exception is deleting a removed profile's own
// suffixed item, pass 3 m2 -- mac-multi-account-pass3.test.ts); and nothing
// ever deletes or rewrites the unsuffixed default item.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { composeProviders } from '../../src/main/providers/compose'
import { _setSecurityRunnerForTest, keychainServiceForConfigDir, CLAUDE_KEYCHAIN_DEFAULT_SERVICE, type SecurityResult } from '../../src/main/claude-credential-store-darwin'

const cred = (at: string, rt: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ claudeAiOauth: { accessToken: at, refreshToken: rt, expiresAt: 1_900_000_000_000, refreshTokenExpiresAt: 1_950_000_000_000, subscriptionType: 'max', ...extra } })
const ident = (email: string) => JSON.stringify({ oauthAccount: { emailAddress: email }, projects: {} })

interface Call { args: string[]; input?: string }
let calls: Call[] = []
let kc = new Map<string, string>()
let fail: ((c: Call) => SecurityResult | null) | null = null

function security(c: Call): SecurityResult {
  const forced = fail?.(c)
  if (forced) return forced
  const svc = (a: string[]) => a[a.indexOf('-s') + 1]
  if (c.args[0] === 'find-generic-password') {
    const v = kc.get(svc(c.args))
    return v === undefined ? { code: 44, stdout: '', stderr: '', timedOut: false } : { code: 0, stdout: `${v}\n`, stderr: '', timedOut: false }
  }
  if (c.args[0] === 'delete-generic-password') {
    const s = svc(c.args)
    if (!kc.has(s)) return { code: 44, stdout: '', stderr: '', timedOut: false }
    kc.delete(s)
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  if (c.args[0] === '-i') {
    const m = /^add-generic-password -U -a "(?:\\.|[^"\\])*" -s "((?:\\.|[^"\\])*)" -X ([0-9a-f]+)\n$/.exec(c.input ?? '')
    if (!m) return { code: 1, stdout: '', stderr: 'returned 1', timedOut: false }
    kc.set(m[1], Buffer.from(m[2], 'hex').toString('utf8'))
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  return { code: 1, stdout: '', stderr: '', timedOut: false }
}

describe('the credential seam', () => {
  let tmp = ''
  let P: typeof import('../../src/main/account-profiles')
  let A: typeof import('../../src/main/account-auth-info')
  const realPlatform = process.platform
  let flag = false
  const asPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p })

  beforeAll(async () => {
    composeProviders()
    P = await import('../../src/main/account-profiles')
    A = await import('../../src/main/account-auth-info')
  })
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-seam-'))
    P._setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'realhome', '.claude') })
    fs.mkdirSync(path.join(tmp, 'resources'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'realhome', '.claude'), { recursive: true })
    flag = false
    P.setMacMultiAccountProbe(() => flag)
    calls = []
    kc = new Map()
    fail = null
    _setSecurityRunnerForTest(async (args, opts) => { const c = { args: [...args], input: opts.input }; calls.push(c); return security(c) }, () => 'someone')
  })
  afterEach(() => {
    asPlatform(realPlatform)
    P.setMacMultiAccountProbe(() => false)
    P._setRootsForTest(null)
    _setSecurityRunnerForTest(null)
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function setup() {
    const primary = P.createProfile('Primary')
    const other = P.createProfile('Other')
    P.setPrimaryProfile(primary.id)
    P.upsertProfile({ ...P.listProfiles().find((p) => p.id === other.id)!, accountEmail: 'a@example.com' })
    const otherHome = P.getProfileConfigDir(other.id)
    const dir = path.resolve(otherHome, '.claude').normalize('NFC')
    return { primary, other, otherHome, dir, service: keychainServiceForConfigDir(dir) }
  }

  // ---- location ------------------------------------------------------------

  it('location: file on win32/linux (setting on or off) and on macOS with the setting off', () => {
    const { other, otherHome } = setup()
    const file = { kind: 'file', path: path.join(otherHome, '.claude', '.credentials.json') }
    for (const p of ['win32', 'linux'] as const) {
      asPlatform(p)
      for (const f of [false, true]) { flag = f; expect(P.profileCredentialLocation(other.id), `${p} ${f}`).toEqual(file) }
    }
    asPlatform('darwin')
    flag = false
    expect(P.profileCredentialLocation(other.id)).toEqual(file)
    expect(calls).toEqual([])
  })

  it('location: macOS setting on -- a realm profile is its own suffixed item; the primary is the default item', () => {
    const { primary, other, dir, service } = setup()
    asPlatform('darwin')
    flag = true
    expect(P.profileCredentialLocation(other.id)).toEqual({ kind: 'keychain', service, fallbackFile: path.join(dir, '.credentials.json'), primary: false })
    expect(service).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
    expect(P.profileCredentialLocation(primary.id)).toEqual({ kind: 'keychain', service: CLAUDE_KEYCHAIN_DEFAULT_SERVICE, fallbackFile: path.join(tmp, 'realhome', '.claude', '.credentials.json'), primary: true })
    // The primary's identity is the REAL ~/.claude.json (it runs with no redirect).
    expect(P.profileIdentityFile(P.getProfileConfigDir(primary.id))).toBe(path.join(tmp, 'realhome', '.claude.json'))
    expect(P.claudeDataHomeFor(P.getProfileConfigDir(primary.id))).toBe(path.join(tmp, 'realhome'))
    expect(P.claudeDataHomeFor(P.getProfileConfigDir(other.id))).toBe(P.getProfileConfigDir(other.id))
    flag = false
    expect(P.claudeDataHomeFor(P.getProfileConfigDir(primary.id))).toBe(P.getProfileConfigDir(primary.id))
  })

  // ---- stamp (re-auth poll) ------------------------------------------------

  it('stamp: macOS realm reads the Keychain; a /login changes it; no token in it', async () => {
    const { other, service } = setup()
    asPlatform('darwin')
    flag = true
    expect(await P.readProfileCredentialStampAsync(other.id)).toEqual({ stamp: null, signedIn: false })
    kc.set(service, cred('at-1', 'rt-1'))
    const a = await P.readProfileCredentialStampAsync(other.id)
    expect(a.signedIn).toBe(true)
    expect(a.stamp).toMatch(/^kc:/)
    expect(a.stamp).not.toContain('at-1')
    kc.set(service, cred('at-2', 'rt-2'))
    expect((await P.readProfileCredentialStampAsync(other.id)).stamp).not.toBe(a.stamp)
    fail = () => ({ code: 36, stdout: '', stderr: 'locked', timedOut: false })
    // m7: unreadable is an explicit UNKNOWN, never a plain "no stamp".
    expect(await P.readProfileCredentialStampAsync(other.id)).toEqual({ stamp: null, signedIn: false, unknown: true })
  })

  for (const p of ['win32', 'linux', 'darwin'] as const) {
    it(`stamp: ${p}${p === 'darwin' ? ' (setting off)' : ''} -- the async read IS the file read; no security call`, async () => {
      const { other, otherHome } = setup()
      fs.mkdirSync(path.join(otherHome, '.claude'), { recursive: true })
      fs.writeFileSync(path.join(otherHome, '.claude', '.credentials.json'), cred('x', 'y'))
      asPlatform(p)
      flag = p !== 'darwin'
      expect(await P.readProfileCredentialStampAsync(other.id)).toEqual(P.readProfileCredentialStamp(other.id))
      expect(calls).toEqual([])
    })
  }

  // ---- auth info -------------------------------------------------------------

  it('auth info: macOS realm -- Keychain found / not found / unreadable', async () => {
    const { other, service, dir } = setup()
    asPlatform('darwin')
    flag = true
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude.json'), ident('a@example.com'))
    expect(await A.readProfileAuthInfoAsync(other.id, 'a@example.com')).toMatchObject({ credentialsMissing: true, oauthEmail: 'a@example.com' })
    kc.set(service, cred('at', 'rt'))
    expect(await A.readProfileAuthInfoAsync(other.id, 'a@example.com')).toMatchObject({ hasRefreshToken: true, refreshTokenExpiresAt: 1_950_000_000_000, subscriptionType: 'max' })
    fail = () => ({ code: null, stdout: '', stderr: '', timedOut: true })
    const u = await A.readProfileAuthInfoAsync(other.id, 'a@example.com')
    expect(u.credentialsUnknown).toBe(true)
    expect(u.credentialsMissing).toBeUndefined()
  })

  for (const p of ['win32', 'linux', 'darwin'] as const) {
    it(`auth info: ${p}${p === 'darwin' ? ' (setting off)' : ''} -- the async read equals the sync read`, async () => {
      const { otherHome } = setup()
      fs.mkdirSync(path.join(otherHome, '.claude'), { recursive: true })
      fs.writeFileSync(path.join(otherHome, '.claude', '.credentials.json'), cred('x', 'y'))
      asPlatform(p)
      flag = p !== 'darwin'
      expect(await A.readAllProfileAuthInfoAsync()).toEqual(A.readAllProfileAuthInfo())
      expect(calls).toEqual([])
    })
  }

  // ---- detected-account capture + restore -----------------------------------

  it('capture on the macOS realm moves the token Keychain to Keychain; restore clears the source (one holder)', async (ctx) => {
    const { other, dir, service } = setup()
    asPlatform('darwin')
    flag = true
    // The source profile's canonical identity (account A), then a /login to B.
    P.writeCanonicalIdentity(other.id, { claudeJson: ident('a@example.com') })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude.json'), ident('b@example.com'))
    kc.set(service, cred('at-B', 'rt-B'))
    let np: Awaited<ReturnType<typeof P.captureDetectedAccountAsync>>
    try {
      np = await P.captureDetectedAccountAsync(other.id, 'B')
    } catch (e) {
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    expect(np).not.toBeNull()
    expect(np!.accountEmail).toBe('b@example.com')
    const npDir = path.resolve(P.getProfileConfigDir(np!.id), '.claude').normalize('NFC')
    const npService = keychainServiceForConfigDir(npDir)
    expect(npService).not.toBe(service)
    expect(kc.get(npService)).toBe(cred('at-B', 'rt-B'))
    expect(JSON.parse(fs.readFileSync(path.join(npDir, '.claude.json'), 'utf8')).oauthAccount.emailAddress).toBe('b@example.com')
    // No Keychain secret is copied into a file.
    expect(fs.existsSync(path.join(P.getAccountIdentityDir(np!.id), '.credentials.json'))).toBe(false)
    // The secret never reached argv.
    for (const c of calls) for (const a of c.args) expect(a).not.toContain('rt-B')

    expect(await P.restoreProfileIdentityFromCanonicalAsync(other.id)).toBe(true)
    expect(kc.has(service)).toBe(false)
    expect(kc.get(npService)).toBe(cred('at-B', 'rt-B'))
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).oauthAccount.emailAddress).toBe('a@example.com')
    expect(calls.some((c) => c.args[0] === 'delete-generic-password' && c.args.includes(CLAUDE_KEYCHAIN_DEFAULT_SERVICE))).toBe(false)
  })

  it('capture: an unreadable source sign-in is refused and creates nothing', async () => {
    const { other, dir } = setup()
    asPlatform('darwin')
    flag = true
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude.json'), ident('b@example.com'))
    fail = () => ({ code: 36, stdout: '', stderr: '', timedOut: false })
    const before = P.listProfiles().length
    expect(await P.captureDetectedAccountAsync(other.id, 'B')).toBeNull()
    expect(P.listProfiles().length).toBe(before)
  })

  it('capture: a failed Keychain write removes the new profile', async (ctx) => {
    const { other, dir, service } = setup()
    asPlatform('darwin')
    flag = true
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude.json'), ident('b@example.com'))
    kc.set(service, cred('at-B', 'rt-B'))
    fail = (c) => (c.args[0] === '-i' ? { code: 1, stdout: '', stderr: 'add-generic-password: returned -25308', timedOut: false } : null)
    const before = P.listProfiles().length
    let r: unknown
    try { r = await P.captureDetectedAccountAsync(other.id, 'B') } catch (e) {
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    expect(r).toBeNull()
    expect(P.listProfiles().length).toBe(before)
    expect(kc.get(service)).toBe(cred('at-B', 'rt-B'))
  })

  it('capture and restore of the macOS PRIMARY are refused; no prompt is offered for it', async () => {
    const { primary } = setup()
    asPlatform('darwin')
    flag = true
    kc.set(CLAUDE_KEYCHAIN_DEFAULT_SERVICE, cred('at', 'rt'))
    fs.writeFileSync(path.join(tmp, 'realhome', '.claude.json'), ident('b@example.com'))
    expect(await P.captureDetectedAccountAsync(primary.id, 'B')).toBeNull()
    expect(await P.restoreProfileIdentityFromCanonicalAsync(primary.id)).toBe(false)
    expect(P.profileDetectionCapturable(primary.id)).toBe(false)
    expect(kc.has(CLAUDE_KEYCHAIN_DEFAULT_SERVICE)).toBe(true)
    expect(calls.filter((c) => c.args[0] !== 'find-generic-password')).toEqual([])
    flag = false
    expect(P.profileDetectionCapturable(primary.id)).toBe(true)
  })

  // Re-attack R3: the Keychain delete comes FIRST; when it fails nothing else
  // is touched (the identity in place is the one that matches the token).
  it('restore: a Keychain item that cannot be deleted -- false, and nothing else is changed', async () => {
    const { other, dir, service } = setup()
    asPlatform('darwin')
    flag = true
    P.writeCanonicalIdentity(other.id, { claudeJson: ident('a@example.com') })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude.json'), ident('b@example.com'))
    kc.set(service, cred('at-B', 'rt-B'))
    fail = (c) => (c.args[0] === 'delete-generic-password' ? { code: 51, stdout: '', stderr: '', timedOut: false } : null)
    expect(await P.restoreProfileIdentityFromCanonicalAsync(other.id)).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).oauthAccount.emailAddress).toBe('b@example.com')
    expect(kc.get(service)).toBe(cred('at-B', 'rt-B'))
  })

  // ---- teardown ----------------------------------------------------------------

  it('teardown: deletes the realm profile item only; never the default item; no call off macOS', async () => {
    const { primary, other, service } = setup()
    kc.set(service, cred('a', 'b'))
    kc.set(CLAUDE_KEYCHAIN_DEFAULT_SERVICE, cred('c', 'd'))
    for (const p of ['win32', 'linux'] as const) {
      asPlatform(p)
      flag = true
      expect(await P.removeProfileKeychainItem(other.id)).toEqual({ ok: true })
    }
    expect(calls).toEqual([])
    asPlatform('darwin')
    flag = true
    expect(await P.removeProfileKeychainItem(primary.id)).toEqual({ ok: true })
    expect(calls).toEqual([])
    expect(await P.removeProfileKeychainItem(other.id)).toEqual({ ok: true })
    expect(kc.has(service)).toBe(false)
    expect(kc.has(CLAUDE_KEYCHAIN_DEFAULT_SERVICE)).toBe(true)
    expect(calls.every((c) => !c.args.includes(CLAUDE_KEYCHAIN_DEFAULT_SERVICE))).toBe(true)
    fail = () => ({ code: null, stdout: '', stderr: '', timedOut: true })
    expect(await P.removeProfileKeychainItem(other.id)).toMatchObject({ ok: false })
  })

  // ---- the fallback file Claude Code uses when the Keychain has nothing -------

  it('read order: Keychain first, then the fallback file, as the CLI reads', async () => {
    const { other, dir, service } = setup()
    asPlatform('darwin')
    flag = true
    const loc = P.profileCredentialLocation(other.id)
    if (loc.kind !== 'keychain') throw new Error('expected keychain')
    expect(await P.readMacCredential(loc)).toEqual({ status: 'not-found' })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.credentials.json'), cred('file-at', 'file-rt'))
    expect(await P.readMacCredential(loc)).toMatchObject({ status: 'found', source: 'file' })
    kc.set(service, cred('kc-at', 'kc-rt'))
    expect(await P.readMacCredential(loc)).toMatchObject({ status: 'found', source: 'keychain', creds: { accessToken: 'kc-at' } })
  })
})
