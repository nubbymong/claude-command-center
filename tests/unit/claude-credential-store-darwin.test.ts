// @vitest-environment node
//
// The macOS Keychain backend (src/main/claude-credential-store-darwin.ts).
// `security` is never run: a fake runner records argv and stdin and answers
// as /usr/bin/security does (exit 44 = errSecItemNotFound -25300 & 0xff).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  keychainServiceForConfigDir, isClaudeKeychainService, CLAUDE_KEYCHAIN_DEFAULT_SERVICE,
  readKeychainCreds, writeKeychainSecret, deleteKeychainItem, parseKeychainSecret,
  decodeSecurityPasswordOutput, quoteSecurityInteractiveArg, buildAddGenericPasswordLine,
  keychainStamp, _setSecurityRunnerForTest, type SecurityResult,
} from '../../src/main/claude-credential-store-darwin'

const SECRET = JSON.stringify({ claudeAiOauth: { accessToken: 'at-123', refreshToken: 'rt-456', expiresAt: 1_900_000_000_000, subscriptionType: 'max' } })

interface Call { args: string[]; input?: string }
let calls: Call[] = []
/** A tiny fake Keychain: service -> secret. */
let store = new Map<string, string>()
let answer: ((c: Call) => SecurityResult | 'timeout') | null = null

function fakeSecurity(c: Call): SecurityResult | 'timeout' {
  const [cmd] = c.args
  const svcOf = (a: string[]) => a[a.indexOf('-s') + 1]
  if (cmd === 'find-generic-password') {
    const v = store.get(svcOf(c.args))
    return v === undefined ? { code: 44, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n', timedOut: false } : { code: 0, stdout: `${v}\n`, stderr: '', timedOut: false }
  }
  if (cmd === 'delete-generic-password') {
    const s = svcOf(c.args)
    if (!store.has(s)) return { code: 44, stdout: '', stderr: '', timedOut: false }
    store.delete(s)
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  if (cmd === '-i') {
    // Parse our own line the way security's split_line does for what we send.
    const m = /^add-generic-password -U -a "((?:\\.|[^"\\])*)" -s "((?:\\.|[^"\\])*)" -X ([0-9a-f]+)\n$/.exec(c.input ?? '')
    if (!m) return { code: 1, stdout: '', stderr: 'add-generic-password: returned 1\n', timedOut: false }
    store.set(m[2].replace(/\\(.)/g, '$1'), Buffer.from(m[3], 'hex').toString('utf8'))
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  return { code: 1, stdout: '', stderr: '', timedOut: false }
}

beforeEach(() => {
  calls = []
  store = new Map()
  answer = null
  _setSecurityRunnerForTest(async (args, opts) => {
    const c: Call = { args: [...args], input: opts.input }
    calls.push(c)
    const r = (answer ?? fakeSecurity)(c)
    if (r === 'timeout') return { code: null, stdout: '', stderr: '', timedOut: true }
    return r
  }, () => 'someone')
})
afterEach(() => { _setSecurityRunnerForTest(null) })

describe('service naming', () => {
  it('is the default service plus sha256(dir)[0:8] of the exact string (golden values)', () => {
    expect(keychainServiceForConfigDir('/Users/test/ccc-acct-test/.claude')).toBe('Claude Code-credentials-adb0bf60')
    expect(keychainServiceForConfigDir('/Users/test/Library/Application Support/AI Code Conductor/account-profiles/profile-abc/.claude'))
      .toBe('Claude Code-credentials-4cc37467')
  })
  it('a different string for the same folder is a different service (no normalisation beyond NFC)', () => {
    const a = keychainServiceForConfigDir('/Users/test/x/.claude')
    expect(keychainServiceForConfigDir('/Users/test/x/.claude/')).not.toBe(a)
    expect(keychainServiceForConfigDir('/Users/test/x/../x/.claude')).not.toBe(a)
    // NFD and NFC spellings of one name hash alike (the launch passes NFC).
    expect(keychainServiceForConfigDir('/Users/tést/.claude')).toBe(keychainServiceForConfigDir('/Users/tést/.claude'))
  })
  it('recognises only the two Claude shapes', () => {
    expect(isClaudeKeychainService(CLAUDE_KEYCHAIN_DEFAULT_SERVICE)).toBe(true)
    expect(isClaudeKeychainService('Claude Code-credentials-0123abcd')).toBe(true)
    for (const s of ['Claude Code-credentials-0123ABCD', 'Claude Code-credentials-123', 'Other', 'Claude Code-credentials-0123abcd\n']) {
      expect(isClaudeKeychainService(s), s).toBe(false)
    }
  })
})

describe('read', () => {
  const svc = 'Claude Code-credentials-0123abcd'
  it('found: parses the credential and runs security with no secret and no shell', async () => {
    store.set(svc, SECRET)
    const r = await readKeychainCreds(svc)
    expect(r.status).toBe('found')
    if (r.status !== 'found') return
    expect(r.creds.accessToken).toBe('at-123')
    expect(r.creds.refreshToken).toBe('rt-456')
    expect(r.creds.secret).toBe(SECRET)
    expect(calls[0].args).toEqual(['find-generic-password', '-a', 'someone', '-s', svc, '-w'])
  })
  it('not found: exit 44', async () => {
    expect(await readKeychainCreds(svc)).toEqual({ status: 'not-found' })
  })
  it('locked / denied: any other exit is UNKNOWN, never not-found', async () => {
    answer = () => ({ code: 36, stdout: '', stderr: 'User interaction is not allowed.', timedOut: false })
    expect((await readKeychainCreds(svc)).status).toBe('unknown')
  })
  it('timeout (a dialog left open): UNKNOWN', async () => {
    answer = () => 'timeout'
    expect((await readKeychainCreds(svc)).status).toBe('unknown')
  })
  it('garbage or an unexpected shape: UNKNOWN', async () => {
    for (const v of ['not json', '[]', '{}', '{"claudeAiOauth":{}}', '{"claudeAiOauth":"x"}']) {
      store.set(svc, v)
      expect((await readKeychainCreds(svc)).status, v).toBe('unknown')
    }
  })
  it('hex output (security prints hex when a byte is not printable) is decoded', async () => {
    const pretty = JSON.stringify(JSON.parse(SECRET), null, 2)
    answer = () => ({ code: 0, stdout: `${Buffer.from(pretty, 'utf8').toString('hex')}\n`, stderr: '', timedOut: false })
    const r = await readKeychainCreds(svc)
    expect(r.status).toBe('found')
    expect(decodeSecurityPasswordOutput(`${SECRET}\n`)).toBe(SECRET)
  })
  it('refuses a service that is not Claude Code\'s, without running anything', async () => {
    expect((await readKeychainCreds('login')).status).toBe('unknown')
    expect(calls).toEqual([])
  })
})

describe('write (argv-free)', () => {
  const svc = 'Claude Code-credentials-0123abcd'
  it('argv is ["-i"] only; the secret is on stdin as hex; it reads back', async () => {
    const r = await writeKeychainSecret(svc, SECRET)
    expect(r).toEqual({ ok: true })
    const w = calls.find((c) => c.args[0] === '-i')!
    expect(w.args).toEqual(['-i'])
    for (const a of w.args) {
      expect(a).not.toContain('at-123')
      expect(a).not.toContain('rt-456')
    }
    expect(w.input).toContain(Buffer.from(SECRET, 'utf8').toString('hex'))
    expect(w.input).not.toContain('at-123')
    expect(store.get(svc)).toBe(SECRET)
  })
  it('hostile secret content (quotes, backslashes, newlines, a second command) cannot leave the -X argument', () => {
    const hostile = JSON.stringify({ claudeAiOauth: { accessToken: 'a"b\\c\n"\ndelete-generic-password -s "Claude Code-credentials"\n\'x\'', refreshToken: 'r' } })
    const line = buildAddGenericPasswordLine('someone', svc, hostile)
    expect(line.split('\n')).toEqual([expect.stringMatching(/^add-generic-password -U -a "someone" -s "Claude Code-credentials-0123abcd" -X [0-9a-f]+$/), ''])
    const hex = /-X ([0-9a-f]+)\n$/.exec(line)![1]
    expect(Buffer.from(hex, 'hex').toString('utf8')).toBe(hostile)
  })
  it('quotes the account for security -i: escapes " and \\, refuses line breaks and NUL', () => {
    expect(quoteSecurityInteractiveArg('plain')).toBe('"plain"')
    expect(quoteSecurityInteractiveArg('a"b')).toBe('"a\\"b"')
    expect(quoteSecurityInteractiveArg('a\\b')).toBe('"a\\\\b"')
    expect(quoteSecurityInteractiveArg("it's me")).toBe('"it\'s me"')
    for (const bad of ['a\nb', 'a\rb', 'a\0b']) expect(() => quoteSecurityInteractiveArg(bad)).toThrow()
  })
  it('a hostile user name stays one argument', () => {
    const line = buildAddGenericPasswordLine('evil" -s "Claude Code-credentials', svc, SECRET)
    expect(line.startsWith('add-generic-password -U -a "evil\\" -s \\"Claude Code-credentials" -s "Claude Code-credentials-0123abcd" -X ')).toBe(true)
  })
  it('a line security -i would truncate is refused before anything runs', async () => {
    const big = JSON.stringify({ claudeAiOauth: { accessToken: 'x'.repeat(2500), refreshToken: 'r' } })
    expect(await writeKeychainSecret(svc, big)).toMatchObject({ ok: false })
    expect(calls).toEqual([])
  })
  it('refuses a non-credential secret and a foreign service', async () => {
    expect(await writeKeychainSecret(svc, 'not json')).toMatchObject({ ok: false })
    expect(await writeKeychainSecret('login', SECRET)).toMatchObject({ ok: false })
    expect(calls).toEqual([])
  })
  it('exit 0 is not enough: a read-back that differs is a failed write', async () => {
    answer = (c) => (c.args[0] === '-i' ? { code: 0, stdout: '', stderr: '', timedOut: false } : fakeSecurity(c))
    expect(await writeKeychainSecret(svc, SECRET)).toMatchObject({ ok: false })
  })
  it('a "returned N" on stderr is a failed write', async () => {
    answer = (c) => (c.args[0] === '-i' ? { code: 0, stdout: '', stderr: 'add-generic-password: returned -25299\n', timedOut: false } : fakeSecurity(c))
    expect(await writeKeychainSecret(svc, SECRET)).toMatchObject({ ok: false })
  })
})

describe('delete', () => {
  it('never targets the unsuffixed default item -- the user\'s normal sign-in', async () => {
    store.set(CLAUDE_KEYCHAIN_DEFAULT_SERVICE, SECRET)
    expect(await deleteKeychainItem(CLAUDE_KEYCHAIN_DEFAULT_SERVICE)).toMatchObject({ unknown: expect.any(String) })
    expect(calls).toEqual([])
    expect(store.has(CLAUDE_KEYCHAIN_DEFAULT_SERVICE)).toBe(true)
  })
  it('deletes a profile item; not-found and failure are told apart', async () => {
    const svc = 'Claude Code-credentials-0123abcd'
    store.set(svc, SECRET)
    expect(await deleteKeychainItem(svc)).toBe('deleted')
    expect(calls[0].args).toEqual(['delete-generic-password', '-a', 'someone', '-s', svc])
    expect(await deleteKeychainItem(svc)).toBe('not-found')
    answer = () => 'timeout'
    expect(await deleteKeychainItem(svc)).toMatchObject({ unknown: expect.any(String) })
  })
})

describe('shape and stamp', () => {
  it('parse keeps every field; the stamp is one-way and changes with the secret', () => {
    const p = parseKeychainSecret(SECRET)!
    expect(p.subscriptionType).toBe('max')
    expect(keychainStamp(p)).toMatch(/^kc:[0-9a-f]{16}$/)
    expect(keychainStamp(p)).not.toContain('at-123')
    const q = parseKeychainSecret(SECRET.replace('at-123', 'at-999'))!
    expect(keychainStamp(q)).not.toBe(keychainStamp(p))
  })
})
