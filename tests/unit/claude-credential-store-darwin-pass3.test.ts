// @vitest-environment node
//
// The macOS Keychain backend, adversarial review pass 3: the account
// attribute's source (m5), read coalescing and the negative cache (m9), and the
// write size cap's reason and exact boundary (m11). `security` is faked.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import {
  _setSecurityRunnerForTest, _resetKeychainReadCacheForTest, readKeychainCreds, writeKeychainSecret, deleteKeychainItem,
  defaultKeychainAccount, maxSecretBytesFor, buildAddGenericPasswordLine, SECURITY_INTERACTIVE_MAX_LINE,
  KEYCHAIN_UNKNOWN_CACHE_MS, type SecurityResult,
} from '../../src/main/claude-credential-store-darwin'

const SVC = 'Claude Code-credentials-0123abcd'
const cred = (at: string) => JSON.stringify({ claudeAiOauth: { accessToken: at, refreshToken: 'rt', expiresAt: 1 } })

let calls: string[][] = []
afterEach(() => { _setSecurityRunnerForTest(null) })

describe('m5: the Keychain account attribute is $USER, else the OS user name (the CLI order)', () => {
  it('prefers a non-empty USER', () => {
    expect(defaultKeychainAccount({ USER: 'alice' })).toBe('alice')
    expect(defaultKeychainAccount({ USER: '' })).toBe(os.userInfo().username)
    expect(defaultKeychainAccount({})).toBe(os.userInfo().username)
  })
  it('a read with no injected user name passes -a $USER', async () => {
    const saved = process.env.USER
    process.env.USER = 'env-user-x'
    try {
      _setSecurityRunnerForTest(async (args) => { calls.push([...args]); return { code: 44, stdout: '', stderr: '', timedOut: false } })
      calls = []
      await readKeychainCreds(SVC)
      expect(calls[0][calls[0].indexOf('-a') + 1]).toBe('env-user-x')
    } finally {
      if (saved === undefined) delete process.env.USER
      else process.env.USER = saved
    }
  })
})

describe('m9: concurrent reads share one process; an UNKNOWN answer is reused for a while', () => {
  let now = 1_000_000
  let answer: SecurityResult = { code: 0, stdout: `${cred('a')}\n`, stderr: '', timedOut: false }
  let release: (() => void) | null = null
  beforeEach(() => {
    calls = []
    now = 1_000_000
    release = null
    _setSecurityRunnerForTest(async (args) => {
      calls.push([...args])
      if (release === null) await new Promise<void>((r) => { release = r; setTimeout(r, 0) })
      return answer
    }, () => 'someone')
    _resetKeychainReadCacheForTest(() => now)
  })

  it('two overlapping reads of one service run ONE `security`', async () => {
    answer = { code: 0, stdout: `${cred('a')}\n`, stderr: '', timedOut: false }
    const [a, b] = await Promise.all([readKeychainCreds(SVC), readKeychainCreds(SVC)])
    expect(a.status).toBe('found')
    expect(b).toEqual(a)
    expect(calls.filter((c) => c[0] === 'find-generic-password')).toHaveLength(1)
  })

  it('after an unknown, reads within the window ask nothing; after it, they ask again; fresh always asks', async () => {
    answer = { code: 36, stdout: '', stderr: '', timedOut: false }
    expect((await readKeychainCreds(SVC)).status).toBe('unknown')
    expect((await readKeychainCreds(SVC)).status).toBe('unknown')
    expect(calls).toHaveLength(1)
    await readKeychainCreds(SVC, { fresh: true })
    expect(calls).toHaveLength(2)
    now += KEYCHAIN_UNKNOWN_CACHE_MS + 1
    answer = { code: 0, stdout: `${cred('b')}\n`, stderr: '', timedOut: false }
    expect((await readKeychainCreds(SVC)).status).toBe('found')
    expect(calls).toHaveLength(3)
  })

  it('a definite answer (found / not-found) is never cached', async () => {
    answer = { code: 44, stdout: '', stderr: '', timedOut: false }
    await readKeychainCreds(SVC)
    await readKeychainCreds(SVC)
    expect(calls).toHaveLength(2)
  })

  it('a successful delete forgets a cached unknown', async () => {
    answer = { code: 36, stdout: '', stderr: '', timedOut: false }
    await readKeychainCreds(SVC)
    answer = { code: 0, stdout: '', stderr: '', timedOut: false }
    expect(await deleteKeychainItem(SVC)).toBe('deleted')
    answer = { code: 44, stdout: '', stderr: '', timedOut: false }
    expect((await readKeychainCreds(SVC)).status).toBe('not-found')
  })
})

describe('re-attack round 2: no stale shared reads across a mutation; latest reads are rate-limited', () => {
  // A Keychain whose `find` calls can be held open, to put a read IN FLIGHT
  // across a write.
  let item: string | null = null
  let held: Array<() => void> = []
  let holdFinds = false
  let now = 9_000_000
  let locked = false
  beforeEach(() => {
    calls = []
    item = cred('old')
    held = []
    holdFinds = false
    locked = false
    now = 9_000_000
    _setSecurityRunnerForTest(async (args, opts) => {
      calls.push([...args])
      if (args[0] === 'find-generic-password') {
        const answer = (): SecurityResult => locked ? { code: 36, stdout: '', stderr: '', timedOut: false }
          : item === null ? { code: 44, stdout: '', stderr: '', timedOut: false } : { code: 0, stdout: `${item}\n`, stderr: '', timedOut: false }
        if (holdFinds) { const snap = answer(); return new Promise<SecurityResult>((r) => held.push(() => r(snap))) }
        return answer()
      }
      if (args[0] === '-i') {
        const m = /-X ([0-9a-f]+)\n$/.exec(opts.input ?? '')
        if (m) item = Buffer.from(m[1], 'hex').toString('utf8')
        return { code: 0, stdout: '', stderr: '', timedOut: false }
      }
      if (args[0] === 'delete-generic-password') { item = null; return { code: 0, stdout: '', stderr: '', timedOut: false } }
      return { code: 1, stdout: '', stderr: '', timedOut: false }
    }, () => 'someone')
    _resetKeychainReadCacheForTest(() => now)
  })

  it('item2: a read started BEFORE a write is never shared with a read started after it', async () => {
    holdFinds = true
    const stale = readKeychainCreds(SVC) // in flight, will answer "old"
    await Promise.resolve()
    holdFinds = false
    expect((await writeKeychainSecret(SVC, cred('new'))).ok).toBe(true)
    const after = await readKeychainCreds(SVC)
    expect(after.status === 'found' && after.creds.accessToken).toBe('new')
    held.forEach((f) => f())
    const s = await stale
    expect(s.status === 'found' && s.creds.accessToken).toBe('old') // its own caller only
    // ...and its late answer was not recorded for anyone else.
    const later = await readKeychainCreds(SVC, { latest: true })
    expect(later.status === 'found' && later.creds.accessToken).toBe('new')
  })

  it('item2: the same across a delete', async () => {
    holdFinds = true
    const stale = readKeychainCreds(SVC)
    await Promise.resolve()
    holdFinds = false
    expect(await deleteKeychainItem(SVC)).toBe('deleted')
    expect((await readKeychainCreds(SVC)).status).toBe('not-found')
    held.forEach((f) => f())
    await stale
  })

  it('item3: latest reads share the in-flight read and spawn at most once per 10 s while locked', async () => {
    locked = true
    const finds = () => calls.filter((c) => c[0] === 'find-generic-password').length
    await Promise.all([readKeychainCreds(SVC, { latest: true }), readKeychainCreds(SVC, { latest: true })])
    expect(finds()).toBe(1)
    for (let t = 0; t < 2; t++) { now += 4_000; await readKeychainCreds(SVC, { latest: true }) }
    expect(finds()).toBe(1) // ticks at +4 s and +8 s: no new process
    now += 3_000
    await readKeychainCreds(SVC, { latest: true })
    expect(finds()).toBe(2) // +11 s: one new process
  })

  it('item3: a write\'s verification read is its own, started after the write -- even with a latest read in flight', async () => {
    holdFinds = true
    const inflight = readKeychainCreds(SVC, { latest: true })
    await Promise.resolve()
    holdFinds = false
    const w = await writeKeychainSecret(SVC, cred('new'))
    expect(w.ok).toBe(true)
    const writeAt = calls.findIndex((c) => c[0] === '-i')
    expect(calls.slice(writeAt + 1).some((c) => c[0] === 'find-generic-password')).toBe(true)
    held.forEach((f) => f())
    await inflight
  })
})

describe('m11: the write size cap -- a distinct reason, and the exact boundary', () => {
  /** A valid credential JSON of exactly `bytes` UTF-8 bytes. */
  function credOfBytes(bytes: number): string {
    const shell = (pad: string) => `{"claudeAiOauth":{"accessToken":"${pad}"}}`
    const s = shell('x'.repeat(bytes - Buffer.byteLength(shell(''), 'utf8')))
    expect(Buffer.byteLength(s, 'utf8')).toBe(bytes)
    return s
  }

  for (const user of ['someone', 'üüüü-ünïcode-user']) {
    it(`account ${JSON.stringify(user)}: the max is accepted, max+1 refused`, async () => {
      const max = maxSecretBytesFor(user, SVC)
      const line = buildAddGenericPasswordLine(user, SVC, credOfBytes(max))
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(SECURITY_INTERACTIVE_MAX_LINE)
      expect(Buffer.byteLength(line, 'utf8')).toBeGreaterThanOrEqual(SECURITY_INTERACTIVE_MAX_LINE - 2)
      expect(() => buildAddGenericPasswordLine(user, SVC, credOfBytes(max + 1))).toThrow('credential too large for the Keychain write path')

      calls = []
      _setSecurityRunnerForTest(async (args) => { calls.push([...args]); return { code: 0, stdout: '', stderr: '', timedOut: false } }, () => user)
      expect(await writeKeychainSecret(SVC, credOfBytes(max + 1))).toEqual({ ok: false, reason: 'credential too large for the Keychain write path' })
      expect(calls).toEqual([]) // refused before anything ran
    })
  }

  it('the account name\'s BYTE length counts: a multibyte name lowers the max', () => {
    expect(maxSecretBytesFor('üüüü', SVC)).toBe(maxSecretBytesFor('uuuu', SVC) - 2)
  })
})
