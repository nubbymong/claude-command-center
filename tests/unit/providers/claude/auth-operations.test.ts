// WP2 PR 4 (owner answers, 2026-10-04, and the review fix pass): the Claude
// adapter's sign-in status and sign-out, and the declaration that says what
// runs. [host] Fake ports only: no CLI runs and no home is read; the app's own
// probe and sign-out have their tests in tests/unit/claude-cli-auth-read.test.ts
// and tests/unit/claude-cli-logout.test.ts.
import { describe, it, expect, vi } from 'vitest'
import {
  createClaudeAuthOperations, createClaudePackage, claudeCapabilities, claudeWiredCapabilities, CLAUDE_COMPUTER_SIGN_IN_ACK,
} from '../../../../src/main/providers/claude'
import type { ClaudeAuthPorts, ClaudeAuthCli, ClaudeProfileAuthStatus, ClaudeProfileLogout, ClaudeReviewPorts } from '../../../../src/main/providers/claude'
import { packageRegistrationProblem } from '../../../../src/main/providers/core'
import { resolveCapability } from '../../../../src/shared/providers'
import type { AuthRealm } from '../../../../src/shared/providers'

const PA = 'profile-aaa-111'
const PB = 'profile-bbb-222'
const EXE = '/opt/claude/bin/claude'
const realm = (id: string, pathRef: string, over: Partial<AuthRealm> = {}): AuthRealm => ({
  id, providerId: 'claude', kind: 'claude-config-home', ownership: 'conductor-managed', pathRef, lifecycle: 'active', ...over,
} as AuthRealm)
const REALMS: Record<string, AuthRealm> = {
  'realm-a': realm('realm-a', `claude-profile:${PA}`),
  'realm-b': realm('realm-b', `claude-profile:${PB}`),
}
const cliStatus = (authenticated: boolean): ClaudeProfileAuthStatus => ({ authenticated, source: 'cli-status' })

function ports(over: Partial<ClaudeAuthPorts> & { states?: Record<string, ClaudeProfileAuthStatus>; logouts?: Record<string, ClaudeProfileLogout> } = {}) {
  const calls = { status: [] as Array<[string, string]>, logout: [] as Array<[string, { executable: string; acknowledged: boolean }]> }
  const p: ClaudeAuthPorts = {
    lookupRealm: async (ref) => (REALMS[ref.authRealmId] ? { ok: true, realm: REALMS[ref.authRealmId] } : { ok: false }),
    readStatus: async (profileId, executable) => { calls.status.push([profileId, executable]); return over.states?.[profileId] ?? cliStatus(true) },
    logout: async (profileId, input) => { calls.logout.push([profileId, input]); return over.logouts?.[profileId] ?? { ran: true, after: cliStatus(false) } },
    ...over,
  }
  return { p, calls }
}
const proven: ClaudeAuthCli = { executable: async () => ({ ok: true, executable: EXE }) }

describe('Claude sign-in status: the profile the realm names, through the app\'s probe [host]', () => {
  it('reads exactly the named profile, from the executable discovery proved, and reports its state; another profile is never touched', async () => {
    const t = ports({ states: { [PA]: cliStatus(true), [PB]: cliStatus(false) } })
    const auth = createClaudeAuthOperations(t.p, proven)
    expect(await auth.status({ authRealmId: 'realm-a' })).toEqual({ ok: true, state: 'signed-in' })
    expect(t.calls.status).toEqual([[PA, EXE]])
    expect(await auth.status({ authRealmId: 'realm-b' })).toEqual({ ok: true, state: 'signed-out' })
    expect(t.calls.status).toEqual([[PA, EXE], [PB, EXE]])
  })

  it('without a proved executable nothing is read (cli-unavailable), with the sign-in\'s own reason', async () => {
    for (const cli of [null, { executable: async () => ({ ok: false as const, code: 'cli-unavailable' as const, message: 'Claude Code is not available for reviews: it was not found.' }) }, { executable: async () => { throw new Error('x') } }]) {
      const t = ports()
      const out = await createClaudeAuthOperations(t.p, cli).status({ authRealmId: 'realm-a' })
      expect(out).toMatchObject({ ok: false, code: 'cli-unavailable', state: 'error' })
      expect(t.calls.status).toEqual([])
    }
    // The discovery's own words are the reviewer's ("for reviews"): never shown for a sign-in.
    const named = await createClaudeAuthOperations(ports().p, { executable: async () => ({ ok: false, code: 'cli-unavailable', message: 'Claude Code is not available for reviews: it was not found.' }) }).status({ authRealmId: 'realm-a' })
    expect(named).toMatchObject({ ok: false, code: 'cli-unavailable', state: 'error' })
    expect(named.message).toMatch(/Claude Code was not found/)
    expect(named.message).not.toMatch(/review/)
  })

  it('a CLI that did not answer is no state: a negative answer from the credential file, an error, or a throw', async () => {
    const fromFile = createClaudeAuthOperations(ports({ states: { [PA]: { authenticated: false, source: 'credential-file' } } }).p, proven)
    expect(await fromFile.status({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'status-unrecognised', state: 'error' })
    const noSource = createClaudeAuthOperations(ports({ states: { [PA]: { authenticated: false } } }).p, proven)
    expect(await noSource.status({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'status-unrecognised', state: 'error' })
    // A token the file holds still reads as signed in, as the panel shows it.
    const fileIn = createClaudeAuthOperations(ports({ states: { [PA]: { authenticated: true, source: 'credential-file' } } }).p, proven)
    expect(await fileIn.status({ authRealmId: 'realm-a' })).toEqual({ ok: true, state: 'signed-in' })
    const e = createClaudeAuthOperations(ports({ states: { [PA]: { authenticated: false, error: 'could not determine CLI auth state' } } }).p, proven)
    expect(await e.status({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'status-unrecognised', state: 'error' })
    const odd = createClaudeAuthOperations(ports({ states: { [PA]: { authenticated: 'yes' as never, source: 'cli-status' } } }).p, proven)
    expect(await odd.status({ authRealmId: 'realm-a' })).toMatchObject({ ok: false, state: 'error' })
    const thrown = createClaudeAuthOperations(ports({ readStatus: async () => { throw new Error('x') } }).p, proven)
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
      const auth = createClaudeAuthOperations(t.p, proven)
      expect(await auth.status({ authRealmId: 'x' }), label).toEqual({ ok: false, code: 'realm-unavailable', state: 'error' })
      expect(await auth.logout({ authRealmId: 'x' }), label).toMatchObject({ ok: false, code: 'realm-unavailable' })
      expect(t.calls.status, label).toEqual([])
      expect(t.calls.logout, label).toEqual([])
    }
    const throwing = ports({ lookupRealm: async () => { throw new Error('registry') } })
    expect(await createClaudeAuthOperations(throwing.p, proven).status({ authRealmId: 'realm-a' })).toMatchObject({ code: 'realm-unavailable' })
    expect(await createClaudeAuthOperations(ports().p, proven).status({} as never)).toMatchObject({ code: 'realm-unavailable' })
  })

  it('a check no longer wanted starts nothing, and one stopped while it runs answers no state', async () => {
    const t = ports()
    const ac = new AbortController()
    ac.abort()
    expect(await createClaudeAuthOperations(t.p, proven).status({ authRealmId: 'realm-a' }, { signal: ac.signal })).toEqual({ ok: false, code: 'cancelled', state: 'error' })
    expect(t.calls.status).toEqual([])
    const late = new AbortController()
    const u = ports({ readStatus: async () => { late.abort(); return cliStatus(true) } })
    expect(await createClaudeAuthOperations(u.p, proven).status({ authRealmId: 'realm-a' }, { signal: late.signal })).toEqual({ ok: false, code: 'cancelled', state: 'error' })
  })
})

describe('Claude sign-out: the profile the realm names, judged by its state afterwards [host]', () => {
  it('signs out exactly the named profile from the proved executable and reports signed-out only when the profile says so', async () => {
    const t = ports()
    const auth = createClaudeAuthOperations(t.p, proven)
    expect(await auth.logout({ authRealmId: 'realm-b' })).toEqual({ ok: true, state: 'signed-out' })
    expect(t.calls.logout).toEqual([[PB, { executable: EXE, acknowledged: false }]])
  })

  it('without a proved executable nothing runs (cli-unavailable)', async () => {
    const t = ports()
    expect(await createClaudeAuthOperations(t.p, null).logout({ authRealmId: 'realm-a' })).toMatchObject({ ok: false, code: 'cli-unavailable' })
    expect(await createClaudeAuthOperations(t.p, { executable: async () => ({ ok: false, code: 'cli-unavailable' }) }).logout({ authRealmId: 'realm-a' })).toMatchObject({ ok: false, code: 'cli-unavailable' })
    expect(t.calls.logout).toEqual([])
    const refused = createClaudeAuthOperations(ports({ logouts: { [PA]: { ran: false, after: null, refused: 'cli-unavailable' } } }).p, proven)
    expect(await refused.logout({ authRealmId: 'realm-a' })).toMatchObject({ ok: false, code: 'cli-unavailable' })
  })

  it('this computer\'s own sign-in: the acknowledgement is handed over, and a sign-out refused for the want of it asks for it', async () => {
    const t = ports({ logouts: { [PA]: { ran: false, after: null, refused: 'computer-sign-in' } } })
    const auth = createClaudeAuthOperations(t.p, proven)
    expect(await auth.logout({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'external-ack-required', message: CLAUDE_COMPUTER_SIGN_IN_ACK })
    const yes = ports()
    expect(await createClaudeAuthOperations(yes.p, proven).logout({ authRealmId: 'realm-a' }, { acknowledgeExternalRealm: true })).toEqual({ ok: true, state: 'signed-out' })
    expect(yes.calls.logout).toEqual([[PA, { executable: EXE, acknowledged: true }]])
  })

  it('a profile still signed in afterwards, or an unreadable state, is not a sign-out (and says it ran)', async () => {
    const still = createClaudeAuthOperations(ports({ logouts: { [PA]: { ran: true, after: cliStatus(true) } } }).p, proven)
    expect(await still.logout({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'still-signed-in', state: 'signed-in', ran: true })
    for (const after of [null, { authenticated: false, error: 'x' }]) {
      const unread = createClaudeAuthOperations(ports({ logouts: { [PA]: { ran: true, after } } }).p, proven)
      expect(await unread.logout({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'status-unrecognised', ran: true })
    }
    const slow = createClaudeAuthOperations(ports({ logouts: { [PA]: { ran: true, after: null, timedOut: true } } }).p, proven)
    expect(await slow.logout({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'timed-out', ran: true })
  })

  it('a profile in use is refused as busy; the other refusals start nothing and say so (a refused gate with a message)', async () => {
    const busy = createClaudeAuthOperations(ports({ logouts: { [PA]: { ran: false, after: null, refused: 'in-use' } } }).p, proven)
    expect(await busy.logout({ authRealmId: 'realm-a' })).toMatchObject({ ok: false, code: 'busy' })
    for (const [refused, code] of [['no-home', 'realm-unavailable'], ['invalid-profile', 'realm-unavailable']] as const) {
      const r = createClaudeAuthOperations(ports({ logouts: { [PA]: { ran: false, after: null, refused } } }).p, proven)
      const out = await r.logout({ authRealmId: 'realm-a' })
      expect(out, refused).toEqual({ ok: false, code })
      expect(out.ran, refused).toBeUndefined()
    }
    const gate = await createClaudeAuthOperations(ports({ logouts: { [PA]: { ran: false, after: null, refused: 'host-control' } } }).p, proven).logout({ authRealmId: 'realm-a' })
    expect(gate).toMatchObject({ ok: false, code: 'not-started' })
    expect(gate.message).toMatch(/settings/)
    expect(gate.ran).toBeUndefined()
    const thrown = createClaudeAuthOperations(ports({ logout: async () => { throw new Error('x') } }).p, proven)
    expect(await thrown.logout({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'not-started' })
    const notRun = createClaudeAuthOperations(ports({ logouts: { [PA]: { ran: false, after: cliStatus(false) } } }).p, proven)
    expect(await notRun.logout({ authRealmId: 'realm-a' })).toEqual({ ok: false, code: 'not-started' })
  })

  it('sign-in is not offered through the package (the CLI login in a Conductor terminal is)', async () => {
    const t = ports()
    expect(await createClaudeAuthOperations(t.p, proven).login({ authRealmId: 'realm-a' }, 'browser')).toEqual({ ok: false, code: 'method-unsupported' })
    expect(t.calls).toEqual({ status: [], logout: [] })
  })
})

describe('the Claude declaration claims what the ports back, and says what runs [host]', () => {
  const reviewPorts = (resolve: string | null = null): ClaudeReviewPorts => ({
    lookupRealm: async () => ({ ok: false }), profileRealmLaunch: () => ({ refused: 'x' }), holdProfile: async () => null,
    recordPreflight: () => {}, resolveExecutable: async () => resolve, commandLine: () => ({ refused: 'x' }), shellEnv: (e: unknown) => e as Record<string, string>,
    run: async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false }),
  } as unknown as ClaudeReviewPorts)

  it('as the composition root composes it (CLI and sign-in ports): every WP1-required key supported, the notes name the operation', () => {
    const pkg = createClaudePackage({ review: reviewPorts(), auth: ports().p })
    expect(packageRegistrationProblem(pkg)).toBeNull()
    expect(pkg.capabilities).toBe(claudeWiredCapabilities)
    expect(typeof pkg.auth?.status).toBe('function')
    expect(typeof pkg.auth?.logout).toBe('function')
    expect(Object.keys(pkg)).not.toContain('executable')
    for (const k of ['cli.discovery', 'auth.status', 'auth.logout'] as const) expect(pkg.capabilities[k].state, k).toBe('supported')
    expect(pkg.capabilities['cli.discovery'].note).toMatch(/claude --version/)
    expect(pkg.capabilities['auth.status'].note).toMatch(/claude auth status in the account's own profile home, run from the executable discovery proved with no shell/)
    expect(pkg.capabilities['auth.logout'].note).toMatch(/claude auth logout in the account's own profile home, run from the executable discovery proved with no shell/)
    expect(pkg.capabilities['auth.logout'].note).toMatch(/acknowledgement/)
    // Sign-in itself stays undeclared (not unsupported): it is unfinished, not impossible.
    expect(pkg.capabilities['auth.browser'].state).toBe('unknown')
  })

  it('the composed package\'s sign-out and status run only what its discovery proved', async () => {
    const t = ports()
    const missing = createClaudePackage({ review: reviewPorts(null), auth: t.p })
    expect(await missing.auth!.logout({ authRealmId: 'realm-a' })).toMatchObject({ ok: false, code: 'cli-unavailable' })
    expect(await missing.auth!.status({ authRealmId: 'realm-a' })).toMatchObject({ ok: false, code: 'cli-unavailable' })
    expect(t.calls).toEqual({ status: [], logout: [] })
    // Auth ports without the CLI ports: nothing to run from.
    const authOnly = createClaudePackage({ auth: t.p })
    expect(await authOnly.auth!.logout({ authRealmId: 'realm-a' })).toMatchObject({ ok: false, code: 'cli-unavailable' })
    expect(t.calls).toEqual({ status: [], logout: [] })
  })

  it('the sign-out is offered on every platform; macOS asks for the acknowledgement instead (no platform carve-out)', () => {
    expect(claudeWiredCapabilities['auth.logout'].platformOverrides).toBeUndefined()
    const on = (platform: 'win32' | 'darwin' | 'linux') => resolveCapability(claudeWiredCapabilities, 'auth.logout', { providerId: 'claude', platform }).enabled
    expect([on('win32'), on('linux'), on('darwin')]).toEqual([true, true, true])
    expect(resolveCapability(claudeWiredCapabilities, 'auth.status', { providerId: 'claude', platform: 'darwin' }).enabled).toBe(true)
  })

  it('a package with fewer ports claims fewer keys, and registers', () => {
    const bare = createClaudePackage()
    expect(bare.capabilities).toBe(claudeCapabilities)
    expect(bare.auth).toBeUndefined()
    for (const k of ['cli.discovery', 'auth.status', 'auth.logout'] as const) expect(bare.capabilities[k].state, k).toBe('unknown')
    // Status and sign-out run the executable discovery proved: without the
    // CLI ports they cannot run, so they are not claimed.
    const authOnly = createClaudePackage({ auth: ports().p })
    expect(packageRegistrationProblem(authOnly)).toBeNull()
    expect([authOnly.capabilities['cli.discovery'].state, authOnly.capabilities['auth.status'].state, authOnly.capabilities['auth.logout'].state]).toEqual(['unknown', 'unknown', 'unknown'])
    const setupOnly = createClaudePackage({ review: reviewPorts() })
    expect(packageRegistrationProblem(setupOnly)).toBeNull()
    expect([setupOnly.capabilities['cli.discovery'].state, setupOnly.capabilities['auth.status'].state, setupOnly.capabilities['auth.logout'].state]).toEqual(['supported', 'unknown', 'unknown'])
    void vi
  })
})
