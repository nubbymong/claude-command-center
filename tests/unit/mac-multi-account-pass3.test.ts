// @vitest-environment node
//
// Regression tests for the adversarial review of the experimental macOS
// multi-account feature, pass 3 (M1-M4, m2-m4, m8). Real account-profiles over
// a temp root; the `security` process is faked through the darwin store's
// runner seam, with a Keychain map and per-call failure hooks.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { composeProviders } from '../../src/main/providers/compose'
import { _setSecurityRunnerForTest, _resetKeychainReadCacheForTest, keychainServiceForConfigDir, CLAUDE_KEYCHAIN_DEFAULT_SERVICE, type SecurityResult } from '../../src/main/claude-credential-store-darwin'

const cred = (at: string, rt: string) =>
  JSON.stringify({ claudeAiOauth: { accessToken: at, refreshToken: rt, expiresAt: 1_900_000_000_000, subscriptionType: 'max' } })
const ident = (email: string) => JSON.stringify({ oauthAccount: { emailAddress: email }, projects: {} })

interface Call { args: string[]; input?: string }
let calls: Call[] = []
let kc = new Map<string, string>()
let fail: ((c: Call) => SecurityResult | null) | null = null
/** Runs after a call is answered (to simulate the CLI acting in between). */
let after: ((c: Call) => void) | null = null

const OK = (stdout = ''): SecurityResult => ({ code: 0, stdout, stderr: '', timedOut: false })
const NOT_FOUND: SecurityResult = { code: 44, stdout: '', stderr: '', timedOut: false }
const LOCKED: SecurityResult = { code: 36, stdout: '', stderr: 'locked', timedOut: false }

function security(c: Call): SecurityResult {
  const forced = fail?.(c)
  if (forced) return forced
  const svc = (a: string[]) => a[a.indexOf('-s') + 1]
  if (c.args[0] === 'find-generic-password') {
    const v = kc.get(svc(c.args))
    return v === undefined ? NOT_FOUND : OK(`${v}\n`)
  }
  if (c.args[0] === 'delete-generic-password') {
    const s = svc(c.args)
    if (!kc.has(s)) return NOT_FOUND
    kc.delete(s)
    return OK()
  }
  if (c.args[0] === '-i') {
    const m = /^add-generic-password -U -a "(?:\\.|[^"\\])*" -s "((?:\\.|[^"\\])*)" -X ([0-9a-f]+)\n$/.exec(c.input ?? '')
    if (!m) return { code: 1, stdout: '', stderr: 'returned 1', timedOut: false }
    kc.set(m[1], Buffer.from(m[2], 'hex').toString('utf8'))
    return OK()
  }
  return { code: 1, stdout: '', stderr: '', timedOut: false }
}

describe('macOS multi-account, adversarial pass 3', () => {
  let tmp = ''
  let P: typeof import('../../src/main/account-profiles')
  const realPlatform = process.platform
  let flag = false
  const asPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p })

  beforeAll(async () => {
    composeProviders()
    P = await import('../../src/main/account-profiles')
  })
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-pass3-'))
    P._setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'realhome', '.claude') })
    fs.mkdirSync(path.join(tmp, 'resources'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'realhome', '.claude'), { recursive: true })
    flag = false
    P.setMacMultiAccountProbe(() => flag)
    calls = []
    kc = new Map()
    fail = null
    after = null
    _setSecurityRunnerForTest(async (args, opts) => {
      const c = { args: [...args], input: opts.input }
      calls.push(c)
      const r = security(c)
      after?.(c)
      return r
    }, () => 'someone')
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
    return { primary, other, otherHome, dir, service: keychainServiceForConfigDir(dir), fallback: path.join(dir, '.credentials.json') }
  }

  /** Source profile `other` on the realm, signed in to B by a /login (identity
   *  B in its config dir, B's token in its Keychain item), with A's canonical
   *  identity to restore. */
  function detectedLogin() {
    const s = setup()
    asPlatform('darwin')
    flag = true
    P.writeCanonicalIdentity(s.other.id, { claudeJson: ident('a@example.com') })
    fs.mkdirSync(s.dir, { recursive: true })
    fs.writeFileSync(path.join(s.dir, '.claude.json'), ident('b@example.com'))
    kc.set(s.service, cred('at-B', 'rt-B'))
    return s
  }

  const newServices = (s: { service: string }) => [...kc.keys()].filter((k) => k !== s.service && k !== CLAUDE_KEYCHAIN_DEFAULT_SERVICE)

  // ---- M1 ------------------------------------------------------------------

  it('M1: a Keychain that cannot be read is UNKNOWN even when the fallback file holds a credential', async () => {
    const { other, fallback } = setup()
    asPlatform('darwin')
    flag = true
    fs.mkdirSync(path.dirname(fallback), { recursive: true })
    fs.writeFileSync(fallback, cred('stale-at', 'stale-rt'))
    fail = (c) => (c.args[0] === 'find-generic-password' ? LOCKED : null)
    const loc = P.profileCredentialLocation(other.id)
    if (loc.kind !== 'keychain') throw new Error('expected keychain')
    const r = await P.readMacCredential(loc)
    expect(r.status).toBe('unknown')
  })

  it('M1: the fallback file is used ONLY after a confirmed not-found (exit 44)', async () => {
    const { other, fallback } = setup()
    asPlatform('darwin')
    flag = true
    fs.mkdirSync(path.dirname(fallback), { recursive: true })
    fs.writeFileSync(fallback, cred('file-at', 'file-rt'))
    const loc = P.profileCredentialLocation(other.id)
    if (loc.kind !== 'keychain') throw new Error('expected keychain')
    expect(await P.readMacCredential(loc)).toMatchObject({ status: 'found', source: 'file' })
  })

  it('m12: Keychain not-found and a fallback file that does not parse (or is not a file) -- UNKNOWN, never signed out', async () => {
    const { other, fallback } = setup()
    asPlatform('darwin')
    flag = true
    const loc = P.profileCredentialLocation(other.id)
    if (loc.kind !== 'keychain') throw new Error('expected keychain')
    fs.mkdirSync(path.dirname(fallback), { recursive: true })
    fs.writeFileSync(fallback, '{"claudeAiOauth": {"accessTo')
    expect(await P.readMacCredential(loc)).toMatchObject({ status: 'unknown' })
    fs.rmSync(fallback)
    fs.mkdirSync(fallback)
    expect(await P.readMacCredential(loc)).toMatchObject({ status: 'unknown' })
    // and the stamp says so explicitly (m7)
    expect(await P.readProfileCredentialStampAsync(other.id)).toEqual({ stamp: null, signedIn: false, unknown: true })
  })

  it('M1: capture refuses when the Keychain and the fallback file hold DIFFERENT credentials; nothing is created or cleared', async () => {
    const s = detectedLogin()
    fs.writeFileSync(s.fallback, cred('at-OLD', 'rt-OLD'))
    const before = P.listProfiles().length
    const r = await P.captureDetectedAccountAndClearSource(s.other.id, 'B')
    expect(r).toMatchObject({ error: expect.stringMatching(/two different saved sign-ins/) })
    expect(P.listProfiles().length).toBe(before)
    expect(kc.get(s.service)).toBe(cred('at-B', 'rt-B'))
    expect(fs.existsSync(s.fallback)).toBe(true)
    expect(newServices(s)).toEqual([])
  })

  it('M1: capture proceeds when the fallback file holds the SAME tokens (and clears both)', async (ctx) => {
    const s = detectedLogin()
    fs.writeFileSync(s.fallback, JSON.stringify(JSON.parse(cred('at-B', 'rt-B')), null, 2))
    let r: Awaited<ReturnType<typeof P.captureDetectedAccountAndClearSource>>
    try { r = await P.captureDetectedAccountAndClearSource(s.other.id, 'B') } catch (e) {
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    expect(r && !('error' in r)).toBe(true)
    expect(kc.has(s.service)).toBe(false)
    expect(fs.existsSync(s.fallback)).toBe(false)
    expect(newServices(s).map((k) => kc.get(k))).toEqual([cred('at-B', 'rt-B')])
  })

  // ---- m4 ------------------------------------------------------------------

  it('m4: no source credential at all on the realm -- refused with an error, no profile created', async () => {
    const s = detectedLogin()
    kc.delete(s.service)
    const before = P.listProfiles().length
    const r = await P.captureDetectedAccountAndClearSource(s.other.id, 'B')
    expect(r).toMatchObject({ error: expect.stringMatching(/No sign-in was found/) })
    expect(P.listProfiles().length).toBe(before)
    expect(await P.captureDetectedAccountAsync(s.other.id, 'B')).toBeNull()
    expect(P.listProfiles().length).toBe(before)
  })

  // ---- M2 ------------------------------------------------------------------

  it('M2: the source item cannot be deleted -- the capture is ROLLED BACK (new item deleted, new profile removed) and an error returned', async (ctx) => {
    const s = detectedLogin()
    fail = (c) => (c.args[0] === 'delete-generic-password' && c.args.includes(s.service) ? { code: 51, stdout: '', stderr: '', timedOut: false } : null)
    const before = P.listProfiles().map((p) => p.id).sort()
    let r: Awaited<ReturnType<typeof P.captureDetectedAccountAndClearSource>>
    try { r = await P.captureDetectedAccountAndClearSource(s.other.id, 'B') } catch (e) {
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    expect(r).toMatchObject({ error: expect.stringMatching(/could not be added: the original account's Keychain sign-in could not be removed/) })
    // Exactly one holder of the refresh token: the source.
    expect(kc.get(s.service)).toBe(cred('at-B', 'rt-B'))
    expect(newServices(s)).toEqual([])
    expect(P.listProfiles().map((p) => p.id).sort()).toEqual(before)
  })

  // Re-attack R3: a failed source delete must leave the source EXACTLY as it
  // was -- its identity file and its fallback file included -- and say so.
  it('R3: a failed source delete changes nothing on the source (identity + fallback file kept) and the message says so', async (ctx) => {
    const s = detectedLogin()
    fs.writeFileSync(s.fallback, cred('at-B', 'rt-B'))
    fail = (c) => (c.args[0] === 'delete-generic-password' && c.args.includes(s.service) ? { code: 51, stdout: '', stderr: '', timedOut: false } : null)
    let r: Awaited<ReturnType<typeof P.captureDetectedAccountAndClearSource>>
    try { r = await P.captureDetectedAccountAndClearSource(s.other.id, 'B') } catch (e) {
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    expect(r).toMatchObject({ error: expect.stringMatching(/No account was added\. The original account is unchanged\./) })
    expect(JSON.parse(fs.readFileSync(path.join(s.dir, '.claude.json'), 'utf8')).oauthAccount.emailAddress).toBe('b@example.com')
    expect(fs.readFileSync(s.fallback, 'utf8')).toBe(cred('at-B', 'rt-B'))
    expect(kc.get(s.service)).toBe(cred('at-B', 'rt-B'))
    // A retry is possible: the same capture succeeds once the Keychain answers.
    fail = null
    const again = await P.captureDetectedAccountAndClearSource(s.other.id, 'B')
    expect(again && 'id' in again).toBe(true)
  })

  // Re-attack R1: once the source item is DELETED the capture is committed; a
  // failure after that (the identity restore) must not roll back the only copy.
  it('R1: the source delete succeeded, then the identity restore throws -- the capture is KEPT and the new item holds the token', async (ctx) => {
    const s = detectedLogin()
    // The restore's write target is made a non-empty DIRECTORY right when the
    // source item is deleted, so writing the identity file throws.
    after = (c) => {
      if (c.args[0] === 'delete-generic-password' && c.args.includes(s.service)) {
        const idFile = path.join(s.dir, '.claude.json')
        fs.rmSync(idFile, { force: true })
        fs.mkdirSync(path.join(idFile, 'x'), { recursive: true })
      }
    }
    let r: Awaited<ReturnType<typeof P.captureDetectedAccountAndClearSource>>
    try { r = await P.captureDetectedAccountAndClearSource(s.other.id, 'B') } catch (e) {
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    expect(r && 'id' in r).toBe(true)
    expect(kc.has(s.service)).toBe(false)
    expect(newServices(s).map((k) => kc.get(k))).toEqual([cred('at-B', 'rt-B')])
  })

  // Re-attack R2: two captures of one source at once must not both succeed.
  it('R2: two concurrent captures of the same source -- exactly one succeeds; one holder of the token', async (ctx) => {
    const s = detectedLogin()
    let rs: Awaited<ReturnType<typeof P.captureDetectedAccountAndClearSource>>[]
    try {
      rs = await Promise.all([P.captureDetectedAccountAndClearSource(s.other.id, 'B1'), P.captureDetectedAccountAndClearSource(s.other.id, 'B2')])
    } catch (e) {
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    const ok = rs.filter((r) => r && 'id' in r)
    expect(ok).toHaveLength(1)
    // Serialised per source: the second add never even wrote a copy (no
    // window in which two items hold the token).
    expect(calls.filter((c) => c.args[0] === '-i')).toHaveLength(1)
    expect(newServices(s).map((k) => kc.get(k))).toEqual([cred('at-B', 'rt-B')])
    expect(kc.has(s.service)).toBe(false)
  })

  // Round 2, item 1: captures (and deletes) of one source are serialised, so a
  // source that vanishes mid-capture was signed out elsewhere -- the copy is
  // then the ONLY holder and must be kept, not rolled back.
  it('item1: the source vanishes between the re-read and the delete (signed out elsewhere) -- the capture is KEPT', async (ctx) => {
    const s = detectedLogin()
    fail = (c) => {
      if (c.args[0] === 'delete-generic-password' && c.args.includes(s.service)) { kc.delete(s.service); return NOT_FOUND }
      return null
    }
    let r: Awaited<ReturnType<typeof P.captureDetectedAccountAndClearSource>>
    try { r = await P.captureDetectedAccountAndClearSource(s.other.id, 'B') } catch (e) {
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    expect(r && 'id' in r).toBe(true)
    expect(newServices(s).map((k) => kc.get(k))).toEqual([cred('at-B', 'rt-B')])
  })

  it('item1: the source is signed out right after the copy (the pre-delete re-read finds nothing) -- the capture is KEPT', async (ctx) => {
    const s = detectedLogin()
    after = (c) => { if (c.args[0] === '-i') kc.delete(s.service) }
    let r: Awaited<ReturnType<typeof P.captureDetectedAccountAndClearSource>>
    try { r = await P.captureDetectedAccountAndClearSource(s.other.id, 'B') } catch (e) {
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    expect(r && 'id' in r).toBe(true)
    expect(newServices(s).map((k) => kc.get(k))).toEqual([cred('at-B', 'rt-B')])
  })

  it('item1: a delete of the source profile queued during a capture runs only after the capture finished', async (ctx) => {
    const s = detectedLogin()
    let sourceDeletedBeforeDeleteRan: boolean | null = null
    let r: Awaited<ReturnType<typeof P.captureDetectedAccountAndClearSource>>
    try {
      const cap = P.captureDetectedAccountAndClearSource(s.other.id, 'B')
      const del = P.runSerialisedForProfile(s.other.id, async () => {
        sourceDeletedBeforeDeleteRan = calls.some((c) => c.args[0] === 'delete-generic-password' && c.args.includes(s.service))
      })
      ;[r] = await Promise.all([cap, del])
    } catch (e) {
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    expect(r && 'id' in r).toBe(true)
    expect(sourceDeletedBeforeDeleteRan).toBe(true)
  })

  // Round 2, item 5: pending state elsewhere (account-usage) learns that a
  // profile's credential is gone -- its item deleted or the profile torn down.
  it('item5: removing a profile\'s Keychain item and tearing the profile down notify the credential-removed listeners', async () => {
    const { other, service } = setup()
    asPlatform('darwin')
    flag = true
    kc.set(service, cred('a', 'b'))
    const seen: string[] = []
    const off = P.onProfileCredentialRemoved((id) => seen.push(id))
    try {
      expect(await P.removeProfileKeychainItem(other.id)).toEqual({ ok: true })
      expect(seen).toEqual([other.id])
      P.safeTeardownProfile(other.id)
      expect(seen).toEqual([other.id, other.id])
    } finally { off() }
  })

  // r5: the Keychain is asked after a failed delete, for a file-sourced
  // capture too; the file it came from is untouched, so the source holds it.
  it('r5: file-sourced capture, Keychain delete fails -- source kept (its file untouched), rolled back, Keychain re-asked', async (ctx) => {
    const s = detectedLogin()
    kc.delete(s.service)
    fs.writeFileSync(s.fallback, cred('at-F', 'rt-F'))
    fail = (c) => (c.args[0] === 'delete-generic-password' && c.args.includes(s.service) ? { code: 51, stdout: '', stderr: '', timedOut: false } : null)
    let r: Awaited<ReturnType<typeof P.captureDetectedAccountAndClearSource>>
    try { r = await P.captureDetectedAccountAndClearSource(s.other.id, 'B') } catch (e) {
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    expect(r).toMatchObject({ error: expect.any(String) })
    expect(fs.readFileSync(s.fallback, 'utf8')).toBe(cred('at-F', 'rt-F'))
    expect(newServices(s)).toEqual([])
    const delAt = calls.findIndex((c) => c.args[0] === 'delete-generic-password' && c.args.includes(s.service))
    expect(calls.slice(delAt + 1).some((c) => c.args[0] === 'find-generic-password' && c.args.includes(s.service))).toBe(true)
  })

  // r6: the new item cannot be confirmed deleted after a failed capture -- the
  // profile row stays and the message says to remove it.
  it('r6: capture fails after the new item exists and its delete is unknown -- profile kept, honest message', async (ctx) => {
    const s = detectedLogin()
    // The new item's write lands but its read-back fails; then its delete times out.
    let wrote = false
    fail = (c) => {
      if (c.args[0] === '-i') { wrote = true; return null }
      if (wrote && c.args[0] === 'find-generic-password' && !c.args.includes(s.service)) return LOCKED
      if (c.args[0] === 'delete-generic-password' && !c.args.includes(s.service)) return { code: null, stdout: '', stderr: '', timedOut: true }
      return null
    }
    const before = P.listProfiles().length
    let r: Awaited<ReturnType<typeof P.captureDetectedAccountAndClearSource>>
    try { r = await P.captureDetectedAccountAndClearSource(s.other.id, 'B') } catch (e) {
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    expect(r).toMatchObject({ error: expect.stringMatching(/remove it there/) })
    expect(P.listProfiles().length).toBe(before + 1)
    expect(kc.get(s.service)).toBe(cred('at-B', 'rt-B'))
  })

  // r10: nothing returned to the renderer carries a local path.
  it('r10: error messages carry no local path (the reparse-point refusal, a file write failure)', async (ctx) => {
    const s = detectedLogin()
    const idDir = P.getAccountIdentityDir(s.other.id)
    fs.rmSync(idDir, { recursive: true, force: true })
    try { fs.symlinkSync(path.join(tmp, 'elsewhere'), idDir, 'junction') } catch { return ctx.skip() }
    fs.mkdirSync(path.join(tmp, 'elsewhere'), { recursive: true })
    const r = await P.captureDetectedAccountAndClearSource(s.other.id, 'B')
    expect(r).toMatchObject({ error: expect.any(String) })
    const msg = (r as { error: string }).error
    expect(msg).not.toContain(tmp)
    expect(msg).not.toMatch(/[A-Za-z]:\\|\/(tmp|Users|home|var)\//)
  })

  it('M2: a restore that THROWS (identity dir is a reparse point) also rolls back', async (ctx) => {
    const s = detectedLogin()
    const idDir = P.getAccountIdentityDir(s.other.id)
    fs.rmSync(idDir, { recursive: true, force: true })
    try { fs.symlinkSync(path.join(tmp, 'elsewhere'), idDir, 'junction') } catch { return ctx.skip() }
    fs.mkdirSync(path.join(tmp, 'elsewhere'), { recursive: true })
    const before = P.listProfiles().length
    let r: Awaited<ReturnType<typeof P.captureDetectedAccountAndClearSource>>
    try { r = await P.captureDetectedAccountAndClearSource(s.other.id, 'B') } catch (e) {
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    expect(r).toMatchObject({ error: expect.stringMatching(/folder is a link/) })
    expect(kc.get(s.service)).toBe(cred('at-B', 'rt-B'))
    expect(newServices(s)).toEqual([])
    expect(P.listProfiles().length).toBe(before)
  })

  it('M2: the delete reported failure but the source item IS gone -- the capture stands (the copy is the only holder)', async (ctx) => {
    const s = detectedLogin()
    fail = (c) => {
      if (c.args[0] === 'delete-generic-password' && c.args.includes(s.service)) { kc.delete(s.service); return { code: null, stdout: '', stderr: '', timedOut: true } }
      return null
    }
    let r: Awaited<ReturnType<typeof P.captureDetectedAccountAndClearSource>>
    try { r = await P.captureDetectedAccountAndClearSource(s.other.id, 'B') } catch (e) {
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    expect(r && 'id' in r).toBe(true)
    expect(kc.has(s.service)).toBe(false)
    expect(newServices(s).map((k) => kc.get(k))).toEqual([cred('at-B', 'rt-B')])
  })

  // ---- M3 ------------------------------------------------------------------

  it('M3: the CLI rotates the source between the copy and the delete -- nothing deleted, the capture rolled back', async (ctx) => {
    const s = detectedLogin()
    // The new item's write is the moment between the source read and the
    // source delete: the CLI rotates the source item right then.
    after = (c) => { if (c.args[0] === '-i') kc.set(s.service, cred('at-B2', 'rt-B2')) }
    const before = P.listProfiles().length
    let r: Awaited<ReturnType<typeof P.captureDetectedAccountAndClearSource>>
    try { r = await P.captureDetectedAccountAndClearSource(s.other.id, 'B') } catch (e) {
      if (realPlatform === 'win32' && /EPERM|symlink/i.test(String(e))) return ctx.skip()
      throw e
    }
    expect(r).toMatchObject({ error: expect.stringMatching(/changed while it was being copied/) })
    // The live (rotated) token stays where it is; the spent copy is gone.
    expect(kc.get(s.service)).toBe(cred('at-B2', 'rt-B2'))
    expect(newServices(s)).toEqual([])
    expect(P.listProfiles().length).toBe(before)
    expect(calls.some((c) => c.args[0] === 'delete-generic-password' && c.args.includes(s.service))).toBe(false)
  })

  // ---- M4 ------------------------------------------------------------------

  it('M4: win32 and linux never refuse a non-primary launch, setting on or off', () => {
    const { otherHome } = setup()
    for (const p of ['win32', 'linux'] as const) {
      asPlatform(p)
      for (const f of [false, true]) { flag = f; expect(() => P.withProfileHome({ PATH: '/x' }, otherHome)).not.toThrow() }
    }
  })

  // ---- m2 ------------------------------------------------------------------

  it('m2: deleting a non-primary macOS profile with the setting OFF still removes its suffixed item; the default item never', async () => {
    const { primary, other, service } = setup()
    kc.set(service, cred('a', 'b'))
    kc.set(CLAUDE_KEYCHAIN_DEFAULT_SERVICE, cred('c', 'd'))
    asPlatform('darwin')
    flag = false
    expect(await P.removeProfileKeychainItem(other.id)).toEqual({ ok: true })
    expect(kc.has(service)).toBe(false)
    expect(kc.has(CLAUDE_KEYCHAIN_DEFAULT_SERVICE)).toBe(true)
    calls = []
    expect(await P.removeProfileKeychainItem(primary.id)).toEqual({ ok: true })
    expect(calls).toEqual([])
    // r8: with the setting OFF a Keychain that does not answer does not block
    // the delete (best-effort sweep); with it ON it fails closed.
    fail = () => LOCKED
    kc.set(service, cred('a', 'b'))
    expect(await P.removeProfileKeychainItem(other.id)).toEqual({ ok: true })
    flag = true
    expect(await P.removeProfileKeychainItem(other.id)).toMatchObject({ ok: false })
  })

  // r7: the setting OFF and the primary cannot be told.
  it('r7: setting OFF, primary unknown -- refused when the list is unreadable or has >1 profile; allowed with 0-1', () => {
    const { other, otherHome } = setup()
    asPlatform('darwin')
    flag = false
    const meta = path.join(P.getProfilesRoot(), 'profiles.json')
    const raw = fs.readFileSync(meta, 'utf8')
    const parsed = JSON.parse(raw) as { profiles: Array<Record<string, unknown>> }
    // >1 profile, none primary
    fs.writeFileSync(meta, JSON.stringify({ ...parsed, profiles: parsed.profiles.map((p) => ({ ...p, isPrimary: false })) }))
    expect(() => P.withProfileHome({ PATH: '/x' }, otherHome)).toThrow(P.MAC_MULTI_ACCOUNT_OFF_REFUSAL_UNKNOWN)
    // unreadable
    fs.writeFileSync(meta, '{not json')
    expect(() => P.withProfileHome({ PATH: '/x' }, otherHome)).toThrow(P.MANAGED_LAUNCH_REFUSAL)
    // exactly one profile, none primary: no second account exists
    fs.writeFileSync(meta, JSON.stringify({ ...parsed, profiles: parsed.profiles.filter((p) => p.id === other.id).map((p) => ({ ...p, isPrimary: false })) }))
    expect(() => P.withProfileHome({ PATH: '/x' }, otherHome)).not.toThrow()
    // none at all
    fs.writeFileSync(meta, JSON.stringify({ ...parsed, profiles: [] }))
    expect(() => P.withProfileHome({ PATH: '/x' }, otherHome)).not.toThrow()
  })

  // r9: the re-auth baseline read bypasses the 30 s unknown cache.
  it('r9 + round 2 item 3: the baseline stamp read sees an unlock inside the 30 s window, at most one spawn per 10 s', async () => {
    const { other, service } = setup()
    asPlatform('darwin')
    flag = true
    let now = 5_000_000
    _resetKeychainReadCacheForTest(() => now)
    const finds = () => calls.filter((c) => c.args[0] === 'find-generic-password').length
    fail = () => LOCKED
    expect(await P.readProfileCredentialStampAsync(other.id)).toMatchObject({ unknown: true })
    fail = null
    kc.set(service, cred('at', 'rt'))
    const base = finds()
    now += 4_000 // the next 4 s tick: no new process (rate limit)
    expect(await P.readProfileCredentialStampAsync(other.id, { fresh: true })).toMatchObject({ unknown: true })
    expect(finds()).toBe(base)
    now += 7_000 // 11 s after the last spawn: one new process, the unlock is seen
    expect(await P.readProfileCredentialStampAsync(other.id, { fresh: true })).toMatchObject({ signedIn: true })
    expect(finds()).toBe(base + 1)
    // ...while the default poll read still honours the 30 s unknown cache for others
    // (the latest read replaced it with a definite answer, so it reads found now).
    expect(await P.readProfileCredentialStampAsync(other.id)).toMatchObject({ signedIn: true })
  })

  // ---- m3 ------------------------------------------------------------------

  it('m3: the legacy file writers plant no credential file on macOS with the setting on', () => {
    const { primary, other, otherHome, fallback } = setup()
    asPlatform('darwin')
    flag = true
    P.upsertProfile({ ...P.listProfiles().find((p) => p.id === primary.id)!, accountEmail: 'p@example.com' })
    // syncPrimaryCredentialsWithGlobal: primary home and real global both "p",
    // with a fresher token in the primary home -- base would write the global.
    const primaryHome = P.getProfileConfigDir(primary.id)
    fs.writeFileSync(path.join(primaryHome, '.claude.json'), ident('p@example.com'))
    fs.writeFileSync(path.join(tmp, 'realhome', '.claude.json'), ident('p@example.com'))
    fs.mkdirSync(path.join(primaryHome, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(primaryHome, '.claude', '.credentials.json'), cred('x', 'y'))
    expect(P.syncPrimaryCredentialsWithGlobal()).toBe('none')
    expect(fs.existsSync(path.join(tmp, 'realhome', '.claude', '.credentials.json'))).toBe(false)
    // cleanupSessionHomes: a fresher retired session home for `other`.
    const sess = path.join(tmp, 'resources', 'account-homes', 'sess-1')
    fs.mkdirSync(path.join(sess, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(sess, '.claude.json'), ident('a@example.com'))
    fs.writeFileSync(path.join(sess, '.claude', '.credentials.json'), cred('sess-at', 'sess-rt'))
    try { P.cleanupSessionHomes() } catch { /* link building may need privileges; the write is what is checked */ }
    expect(fs.existsSync(fallback)).toBe(false)
    expect(fs.existsSync(path.join(otherHome, '.claude', '.credentials.json'))).toBe(false)
    // captureGlobalLogin: identity captured, no credential file copied.
    fs.writeFileSync(path.join(tmp, 'realhome', '.claude', '.credentials.json'), cred('g', 'h'))
    const g = P.captureGlobalLogin('G')
    expect(g).not.toBeNull()
    expect(fs.existsSync(path.join(P.getProfileConfigDir(g!.id), '.claude', '.credentials.json'))).toBe(false)
    expect(fs.existsSync(path.join(P.getAccountIdentityDir(g!.id), '.credentials.json'))).toBe(false)
    // migrateProfilesToHomeLayout: a realm profile with no <home>/.claude is not reset.
    fs.rmSync(path.join(otherHome, '.claude'), { recursive: true, force: true })
    P.migrateProfilesToHomeLayout()
    expect(P.listProfiles().find((p) => p.id === other.id)!.accountEmail).toBe('a@example.com')
  })

  // ---- m8 ------------------------------------------------------------------

  it('m8: a home that is not a profile home is never a realm, setting on', () => {
    setup()
    asPlatform('darwin')
    flag = true
    const notProfile = path.join(tmp, 'somewhere', 'home')
    expect(P.macClaudeStore(notProfile)).toBeNull()
    expect(P.macProfileConfigDir(notProfile)).toBeNull()
    expect(P.withProfileHome({ PATH: '/x' }, notProfile).CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})
