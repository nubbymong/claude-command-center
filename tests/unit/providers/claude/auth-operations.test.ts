// WP2 PR 4 (owner answers, 2026-10-04): the Claude adapter's sign-in status
// and sign-out, and the declaration that says what runs. [host] Fake ports
// only: no CLI runs and no home is read; the app's own probe and sign-out
// have their tests in tests/unit/claude-cli-auth-read.test.ts and
// tests/unit/claude-cli-logout.test.ts.
import { describe, it, expect, vi } from 'vitest'
import {
  createClaudeAuthOperations, createClaudePackage, claudeCapabilities, claudeWiredCapabilities, CLAUDE_MAC_SIGN_OUT_REFUSAL,
} from '../../../../src/main/providers/claude'
import type { ClaudeAuthPorts, ClaudeProfileAuthStatus, ClaudeProfileLogout, ClaudeReviewPorts } from '../../../../src/main/providers/claude'
import { packageRegistrationProblem } from '../../../../src/main/providers/core'
import { resolveCapability } from '../../../../src/shared/providers'
import type { AuthRealm } from '../../../../src/shared/providers'

const PA = 'profile-aaa-111'
const PB = 'profile-bbb-222'
const realm = (id: string, pathRef: string, over: Partial<AuthRealm> = {}): AuthRealm => ({
  id, providerId: 'claude', kind: 'claude-config-home', ownership: 'conductor-managed', pathRef, lifecycle: 'active', ...over,
} as AuthRealm)
const REALMS: Record<string, AuthRealm> = {
  'realm-a': realm('realm-a', `claude-profile:${PA}`),
  'realm-b': realm('realm-b', `claude-profile:${PB}`),
}

function ports(over: Partial<ClaudeAuthPorts> & { states?: Record<string, ClaudeProfileAuthStatus>; logouts?: Record<string, ClaudeProfileLogout> } = {}) {
  const calls = { status: [] as string[], logout: [] as string[] }
  const p: ClaudeAuthPorts = {
    lookupRealm: async (ref) => (REALMS[ref.authRealmId] ? { ok: true, realm: REALMS[ref.authRealmId] } : { ok: false }),
    readStatus: async (profileId) => { calls.status.push(profileId); return over.states?.[profileId] ?? { authenticated: true } },
    logout: async (profileId) => { calls.logout.push(profileId); return over.logouts?.[profileId] ?? { ran: true, after: { authenticated: false } } },
    platform: 'win32',
    ...over,
  }
  return { p, calls }
}

describe('Claude sign-in status: the profile the realm names, through the app\'s probe [host]', () => {
  it('reads exactly the named profile and reports its state; another profile is never touched', async () => {
    const t = ports({ states: { [PA]: { authenticated: true }, [PB]: { authenticated: false } } })
    const auth = createClaudeAuthOperations(t.p)
    expect(await auth.status({ authRealmId: 'realm-a' })).toEqual({ ok: true, state: 'signed-in' })
    expect(t.calls.status).toEqual([PA])
    expect(await auth.status({ authRealmId: 'realm-b' })).toEqual({ ok: true, state: 'signed-out' })
    expect(t.calls.status).toEqual([PA, PB])
  })

  it('an answer that says nothing, or a probe that throws, is never a state', async () => {
    const e = createClaudeAuthOperations(ports({ states: { [PA]: { authenticated: false, error: 'could not determine CLI auth state' } } }).p)
    expect(await e.status({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'status-unrecognised', state: 'error' })
    const odd = createClaudeAuthOperations(ports({ states: { [PA]: { authenticated: 'yes' as never } } }).p)
    expect(await odd.status({ authRealmId: 'realm-a' })).toMatchObject({ ok: false, state: 'error' })
    const thrown = createClaudeAuthOperations(ports({ readStatus: async () => { throw new Error('x') } }).p)
    expect(await thrown.status({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'not-started', state: 'error' })
  })

  it('a realm that names no live profile is refused before anything runs', async () => {
    const bad: Array<[string, AuthRealm | null]> = [
      ['unknown', null],
      ['codex-kind', realm('x', `claude-profile:${PA}`, { kind: 'codex-home' as never })],
      ['not-a-profile', realm('x', 'claude-profile:../../escape')],
      ['other-prefix', realm('x', `codex-realm:${PA}`)],
      ['other-id', realm('another-id', `claude-profile:${PA}`)],
    ]
    for (const [label, r] of bad) {
      const t = ports({ lookupRealm: async () => (r ? { ok: true, realm: r } : { ok: false }) })
      const auth = createClaudeAuthOperations(t.p)
      expect(await auth.status({ authRealmId: 'x' }), label).toEqual({ ok: false, code: 'realm-unavailable', state: 'error' })
      expect(await auth.logout({ authRealmId: 'x' }), label).toMatchObject({ ok: false, code: 'realm-unavailable' })
      expect(t.calls.status, label).toEqual([])
      expect(t.calls.logout, label).toEqual([])
    }
    const throwing = ports({ lookupRealm: async () => { throw new Error('registry') } })
    expect(await createClaudeAuthOperations(throwing.p).status({ authRealmId: 'realm-a' })).toMatchObject({ code: 'realm-unavailable' })
    expect(await createClaudeAuthOperations(ports().p).status({} as never)).toMatchObject({ code: 'realm-unavailable' })
  })

  it('a check no longer wanted starts nothing, and one stopped while it runs answers no state', async () => {
    const t = ports()
    const ac = new AbortController()
    ac.abort()
    expect(await createClaudeAuthOperations(t.p).status({ authRealmId: 'realm-a' }, { signal: ac.signal })).toEqual({ ok: false, code: 'cancelled', state: 'error' })
    expect(t.calls.status).toEqual([])
    const late = new AbortController()
    const u = ports({ readStatus: async () => { late.abort(); return { authenticated: true } } })
    expect(await createClaudeAuthOperations(u.p).status({ authRealmId: 'realm-a' }, { signal: late.signal })).toEqual({ ok: false, code: 'cancelled', state: 'error' })
  })
})

describe('Claude sign-out: the profile the realm names, judged by its state afterwards [host]', () => {
  it('signs out exactly the named profile and reports signed-out only when the profile says so', async () => {
    const t = ports()
    const auth = createClaudeAuthOperations(t.p)
    expect(await auth.logout({ authRealmId: 'realm-b' })).toEqual({ ok: true, state: 'signed-out' })
    expect(t.calls.logout).toEqual([PB])
  })

  it('a profile still signed in afterwards, or an unreadable state, is not a sign-out (and says it ran)', async () => {
    const still = createClaudeAuthOperations(ports({ logouts: { [PA]: { ran: true, after: { authenticated: true } } } }).p)
    expect(await still.logout({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'still-signed-in', state: 'signed-in', ran: true })
    for (const after of [null, { authenticated: false, error: 'x' }]) {
      const unread = createClaudeAuthOperations(ports({ logouts: { [PA]: { ran: true, after } } }).p)
      expect(await unread.logout({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'status-unrecognised', ran: true })
    }
    const slow = createClaudeAuthOperations(ports({ logouts: { [PA]: { ran: true, after: { authenticated: false }, timedOut: true } } }).p)
    expect(await slow.logout({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'timed-out', ran: true })
  })

  it('a profile in use is refused as busy; the other refusals start nothing and say so', async () => {
    const busy = createClaudeAuthOperations(ports({ logouts: { [PA]: { ran: false, after: null, refused: 'in-use' } } }).p)
    expect(await busy.logout({ authRealmId: 'realm-a' })).toMatchObject({ ok: false, code: 'busy' })
    for (const [refused, code] of [['no-home', 'realm-unavailable'], ['invalid-profile', 'realm-unavailable'], ['host-control', 'not-started']] as const) {
      const r = createClaudeAuthOperations(ports({ logouts: { [PA]: { ran: false, after: null, refused } } }).p)
      const out = await r.logout({ authRealmId: 'realm-a' })
      expect(out, refused).toEqual({ ok: false, code })
      expect(out.ran, refused).toBeUndefined()
    }
    const thrown = createClaudeAuthOperations(ports({ logout: async () => { throw new Error('x') } }).p)
    expect(await thrown.logout({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'not-started' })
    const notRun = createClaudeAuthOperations(ports({ logouts: { [PA]: { ran: false, after: { authenticated: false } } } }).p)
    expect(await notRun.logout({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'not-started' })
  })

  it('macOS: refused before anything is resolved or run (one keychain sign-in is shared by every Claude Code there)', async () => {
    const t = ports({ platform: 'darwin' })
    const lookup = vi.spyOn(t.p, 'lookupRealm')
    expect(await createClaudeAuthOperations(t.p).logout({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'method-unsupported', message: CLAUDE_MAC_SIGN_OUT_REFUSAL })
    expect(t.calls.logout).toEqual([])
    expect(lookup).not.toHaveBeenCalled()
    // The status check is the panel's own and is offered there too.
    expect(await createClaudeAuthOperations(t.p).status({ authRealmId: 'realm-a' })).toEqual({ ok: true, state: 'signed-in' })
  })

  it('sign-in is not offered through the package (the CLI login in a Conductor terminal is)', async () => {
    const t = ports()
    expect(await createClaudeAuthOperations(t.p).login({ authRealmId: 'realm-a' }, 'browser')).toEqual({ ok: false, code: 'method-unsupported' })
    expect(t.calls).toEqual({ status: [], logout: [] })
  })
})

describe('the Claude declaration claims what the ports back, and says what runs [host]', () => {
  const reviewPorts = (): ClaudeReviewPorts => ({
    lookupRealm: async () => ({ ok: false }), profileRealmLaunch: () => ({ refused: 'x' }), holdProfile: async () => null,
    recordPreflight: () => {}, resolveExecutable: async () => null, commandLine: () => ({ refused: 'x' }), shellEnv: (e: unknown) => e as Record<string, string>,
    run: async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false }),
  } as unknown as ClaudeReviewPorts)

  it('as the composition root composes it (CLI and sign-in ports): every WP1-required key supported, the notes name the operation', () => {
    const pkg = createClaudePackage({ review: reviewPorts(), auth: ports().p })
    expect(packageRegistrationProblem(pkg)).toBeNull()
    expect(pkg.capabilities).toBe(claudeWiredCapabilities)
    expect(typeof pkg.auth?.status).toBe('function')
    expect(typeof pkg.auth?.logout).toBe('function')
    for (const k of ['cli.discovery', 'auth.status', 'auth.logout'] as const) expect(pkg.capabilities[k].state, k).toBe('supported')
    expect(pkg.capabilities['cli.discovery'].note).toMatch(/claude --version/)
    expect(pkg.capabilities['auth.status'].note).toMatch(/claude auth status in the account's own profile home/)
    expect(pkg.capabilities['auth.logout'].note).toMatch(/claude auth logout in the account's own profile home/)
    // Sign-in itself stays undeclared (not unsupported): it is unfinished, not impossible.
    expect(pkg.capabilities['auth.browser'].state).toBe('unknown')
  })

  it('the sign-out is off on macOS only, and resolves so', () => {
    expect(claudeWiredCapabilities['auth.logout'].platformOverrides).toEqual({ darwin: 'unsupported' })
    const on = (platform: 'win32' | 'darwin' | 'linux') => resolveCapability(claudeWiredCapabilities, 'auth.logout', { providerId: 'claude', platform }).enabled
    expect([on('win32'), on('linux'), on('darwin')]).toEqual([true, true, false])
    expect(resolveCapability(claudeWiredCapabilities, 'auth.status', { providerId: 'claude', platform: 'darwin' }).enabled).toBe(true)
  })

  it('a package with fewer ports claims fewer keys, and registers', () => {
    const bare = createClaudePackage()
    expect(bare.capabilities).toBe(claudeCapabilities)
    expect(bare.auth).toBeUndefined()
    for (const k of ['cli.discovery', 'auth.status', 'auth.logout'] as const) expect(bare.capabilities[k].state, k).toBe('unknown')
    const authOnly = createClaudePackage({ auth: ports().p })
    expect(packageRegistrationProblem(authOnly)).toBeNull()
    expect([authOnly.capabilities['cli.discovery'].state, authOnly.capabilities['auth.status'].state, authOnly.capabilities['auth.logout'].state]).toEqual(['unknown', 'supported', 'supported'])
    const setupOnly = createClaudePackage({ review: reviewPorts() })
    expect(packageRegistrationProblem(setupOnly)).toBeNull()
    expect([setupOnly.capabilities['cli.discovery'].state, setupOnly.capabilities['auth.status'].state, setupOnly.capabilities['auth.logout'].state]).toEqual(['supported', 'unknown', 'unknown'])
  })
})
