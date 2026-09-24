// WP1.38 / WP1.42 / WP1.45 / WP1.46 -- WP2 commit 4 (plan A10; design 5.5,
// 5.7, 11): a launch is prepared in its account's realm, one path for
// sessions and reviewer invocations. The account is the one named, else the
// provider default; an unverified sign-in needs this launch's
// acknowledgement before anything runs; an external home is checked before
// the lease; the lease is taken on exactly the chosen account and released
// by any refusal after it; the environment comes from the provider's own
// preparation with the ambient authority variables removed and the realm
// selector set last. Codex runs on this computer only in this release.
//
// PURE: the real Codex package on a fake CLI, in-memory everything.
import { describe, it, expect } from 'vitest'
import { harness, addCodexAccount, claudeSnapshot, managedHome, memoryFs, MemoryPort, EXE, EXT_HOME } from './accounts-harness'
import type { ClaudeReviewPorts } from '../../src/main/providers/claude'
import type { Harness } from './accounts-harness'

const realmOf = (h: Harness, accountId: string) => h.doc().accounts.find((a) => a.id === accountId)!.authRealmId
const session = (ownerId: string, over: Record<string, unknown> = {}) => ({ kind: 'session' as const, providerId: 'codex' as const, ownerId, ...over })

describe('preparing a launch in its account\'s realm (WP1.38, WP1.42)', () => {
  it('a session naming no account runs on the provider default, a named one on that one, each in its own realm', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    const cliRuns = h.runs.length
    const def = await h.service.prepareLaunch(session('s1'))
    if (!def.ok) throw new Error(def.code)
    expect(def.binding.providerAccountId).toBe(a)
    expect(def.home).toBe(managedHome(realmOf(h, a)))
    expect(def.executable).toBe(EXE)
    expect(def.sessionsDir).toBe(`${def.home}\\sessions`)
    const named = await h.service.prepareLaunch(session('s2', { providerAccountId: b }))
    if (!named.ok) throw new Error(named.code)
    expect(named.binding.providerAccountId).toBe(b)
    expect(named.home).toBe(managedHome(realmOf(h, b)))
    expect([h.leases.runningSessions(a), h.leases.runningSessions(b)]).toEqual([1, 1])
    // A managed realm launches without running the CLI first.
    expect(h.runs.length).toBe(cliRuns)
    expect(h.service.releaseLaunch('session', 's1')).toBe(true)
    expect(h.leases.count(a)).toBe(0)
  })

  it('the environment drops the ambient credentials and sets the realm selector last', async () => {
    const h = await harness()
    await addCodexAccount(h)
    const r = await h.service.prepareLaunch(session('s'))
    if (!r.ok) throw new Error(r.code)
    expect(r.env).toEqual({ PATH: 'C:\\Tools', SystemRoot: 'C:\\Windows', CODEX_HOME: r.home })
    expect(Object.keys(r.env).at(-1)).toBe('CODEX_HOME')
  })

  it('a review naming no account reports how it was chosen', async () => {
    const h = await harness()
    const a = await addCodexAccount(h)
    expect(await h.service.prepareLaunch({ kind: 'review', providerId: 'codex', ownerId: 'r' })).toMatchObject({ ok: true, reviewer: 'provider-default', binding: { providerAccountId: a } })
    expect(h.leases.describe(a)).toMatchObject({ review: 1, session: 0 })
  })

  it('refused before any lease or CLI run: no account, another provider\'s account, a kind that is not a launch, a provider without realm launches', async () => {
    const h = await harness()
    expect(await h.service.prepareLaunch(session('s0'))).toMatchObject({ ok: false, code: 'not-found' })
    const id = await addCodexAccount(h)
    const cliRuns = h.runs.length
    expect(await h.service.prepareLaunch({ kind: 'session', providerId: 'claude', providerAccountId: id, ownerId: 's1' })).toMatchObject({ ok: false, code: 'unsupported' })
    for (const kind of ['sign-in', 'operation', 'bogus']) {
      expect(await h.service.prepareLaunch({ kind: kind as never, providerId: 'codex', ownerId: 'x' }), kind).toMatchObject({ ok: false, code: 'invalid-request' })
    }
    expect(await h.service.prepareLaunch(session('s2', { providerAccountId: 'acct-' + 'f'.repeat(32) }))).toMatchObject({ ok: false, code: 'not-found' })
    expect(h.leases.count(id)).toBe(0)
    expect(h.runs.length).toBe(cliRuns)
  })

  it('a switched-off provider, or one whose sessions are not supported, launches nothing', async () => {
    const h = await harness()
    const id = await addCodexAccount(h)
    expect((await h.service.setProviderEnabled('codex', false)).ok).toBe(true)
    expect(await h.service.prepareLaunch(session('s1'))).toMatchObject({ ok: false, code: 'provider-disabled' })
    expect((await h.service.setProviderEnabled('codex', true)).ok).toBe(true)
    h.setCapabilities({ 'session.launch': { state: 'unsupported', note: 'test' } })
    expect(await h.service.prepareLaunch(session('s2'))).toMatchObject({ ok: false, code: 'capability-disabled' })
    expect(h.leases.count(id)).toBe(0)
  })
})

describe('Codex runs on this computer only in this release', () => {
  it('a remote launch is refused before anything runs, saying why; the gate is the capability, not the provider name', async () => {
    const h = await harness()
    const id = await addCodexAccount(h)
    const cliRuns = h.runs.length
    const remote = await h.service.prepareLaunch(session('s1', { remote: true }))
    expect(remote).toMatchObject({ ok: false, code: 'unsupported' })
    expect(remote.ok ? '' : remote.message).toMatch(/this computer only/)
    expect([h.leases.count(id), h.runs.length]).toEqual([0, cliRuns])
    h.setCapabilities({ 'session.ssh': { state: 'supported' } })
    expect((await h.service.prepareLaunch(session('s2', { remote: true }))).ok).toBe(true)
  })
})

describe('an unverified or external sign-in (WP1.45; design 5.5)', () => {
  async function adopted(h: Harness): Promise<string> {
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    const ext = await h.service.adoptExternalDefault({ providerId: 'codex' })
    if (!ext.ok) throw new Error(ext.code)
    return ext.accountId
  }

  it('needs this launch\'s acknowledgement before any CLI runs; with it, the home is checked and the launch runs there', async () => {
    const h = await harness()
    const id = await adopted(h)
    const cliRuns = h.runs.length
    expect(await h.service.prepareLaunch(session('s1', { providerAccountId: id }))).toMatchObject({ ok: false, code: 'acknowledgement-required' })
    expect([h.leases.count(id), h.runs.length]).toEqual([0, cliRuns])
    const r = await h.service.prepareLaunch(session('s2', { providerAccountId: id, acknowledgeRealmOnly: true }))
    if (!r.ok) throw new Error(r.code)
    expect([r.realmOnly, r.home, r.env.CODEX_HOME]).toEqual([true, EXT_HOME, EXT_HOME])
    expect(h.runs.slice(cliRuns).map((x) => `${x.args} @ ${x.home}`)).toEqual([`login status @ ${EXT_HOME}`])
  })

  it('the acknowledgement is for the account the request names: without one it acknowledges nothing, even when the default is that account', async () => {
    const h = await harness()
    const id = await adopted(h)
    const cliRuns = h.runs.length
    // The external sign-in is the provider default here, so naming no account chooses it.
    expect(await h.service.prepareLaunch(session('s1', { acknowledgeRealmOnly: true }))).toMatchObject({ ok: false, code: 'acknowledgement-required' })
    expect([h.leases.count(id), h.runs.length]).toEqual([0, cliRuns])
  })

  it('a sign-in that changed since it was adopted blocks the launch; nothing is leased', async () => {
    const h = await harness()
    const id = await adopted(h)
    h.signedIn.set(EXT_HOME.toLowerCase(), 'api-key')
    expect(await h.service.prepareLaunch(session('s', { providerAccountId: id, acknowledgeRealmOnly: true }))).toMatchObject({ ok: false, code: 'sign-in-changed' })
    expect(h.leases.count(id)).toBe(0)
    expect(h.doc().accounts.find((a) => a.id === id)).toMatchObject({ operationalState: 'blocked' })
    // Blocked is sticky: signing back in does not unblock a launch by itself.
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    expect((await h.service.prepareLaunch(session('s', { providerAccountId: id, acknowledgeRealmOnly: true }))).ok).toBe(false)
  })

  it('a home that cannot be checked blocks the launch rather than running it unchecked', async () => {
    let broken = false
    const h = await harness({
      script: {
        'login status': (r) => (broken ? { timedOut: true }
          : r.home.toLowerCase() === EXT_HOME.toLowerCase() ? { exitCode: 0, stderr: 'Logged in using ChatGPT\n' } : { exitCode: 1, stderr: 'Not logged in\n' }),
      },
    })
    const id = await adopted(h)
    broken = true
    expect(await h.service.prepareLaunch(session('s', { providerAccountId: id, acknowledgeRealmOnly: true }))).toMatchObject({ ok: false, code: 'timed-out' })
    expect(h.leases.count(id)).toBe(0)
  })
})

describe('a refusal after the lease releases it (WP1.46)', () => {
  it('a managed realm holding a .env launches nothing and holds nothing', async () => {
    const h = await harness()
    const id = await addCodexAccount(h)
    h.state.envFile.add(managedHome(realmOf(h, id)).toLowerCase())
    expect(await h.service.prepareLaunch(session('s'))).toMatchObject({ ok: false, code: 'realm-env-file' })
    expect(h.leases.count(id)).toBe(0)
  })

  it('an executable replaced after setup proved it launches nothing and holds nothing', async () => {
    const h = await harness()
    const id = await addCodexAccount(h)
    h.state.exeStat = { ...h.state.exeStat, ino: '99' }
    expect(await h.service.prepareLaunch(session('s'))).toMatchObject({ ok: false, code: 'cli-unavailable' })
    expect(h.leases.count(id)).toBe(0)
  })

  it('a preparation that throws, or that comes back without its parts, launches nothing and holds nothing', async () => {
    const h = await harness()
    const id = await addCodexAccount(h)
    const launchOps = h.codex.launch!
    const real = launchOps.prepare
    const bad: Array<[string, () => Promise<unknown>]> = [
      ['throws', async () => { throw new Error('boom') }],
      ['null', async () => null],
      ['no parts', async () => ({ ok: true })],
      ['empty executable', async () => ({ ...(await real({ authRealmId: realmOf(h, id) }) as object), executable: '' })],
      ['no home', async () => ({ ...(await real({ authRealmId: realmOf(h, id) }) as object), home: undefined })],
      ['no sessions folder', async () => ({ ...(await real({ authRealmId: realmOf(h, id) }) as object), sessionsDir: '' })],
    ]
    for (const [what, prepare] of bad) {
      ;(launchOps as { prepare: unknown }).prepare = prepare
      const r = await h.service.prepareLaunch(session(`s-${what}`))
      expect(r.ok, what).toBe(false)
      expect(h.leases.count(id), what).toBe(0)
    }
    ;(launchOps as { prepare: unknown }).prepare = real
    expect((await h.service.prepareLaunch(session('s-ok'))).ok).toBe(true)
  })

  it('an environment that cannot be applied (the package not registered) launches nothing and holds nothing', async () => {
    const h = await harness()
    const id = await addCodexAccount(h)
    const { _resetProviderRegistryForTest } = await import('../../src/main/providers/core')
    _resetProviderRegistryForTest()
    expect(await h.service.prepareLaunch(session('s'))).toMatchObject({ ok: false, code: 'internal' })
    expect(h.leases.count(id)).toBe(0)
  })

  it('a launch holding its lease makes a deactivation refuse; once released the deactivation runs, and a launch after it refuses', async () => {
    const h = await harness()
    await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    expect((await h.service.prepareLaunch(session('s', { providerAccountId: b }))).ok).toBe(true)
    expect(await h.service.setLifecycle({ accountId: b, lifecycle: 'inactive' })).toMatchObject({ ok: false, code: 'consumers' })
    expect(h.service.releaseLaunch('session', 's')).toBe(true)
    expect((await h.service.setLifecycle({ accountId: b, lifecycle: 'inactive' })).ok).toBe(true)
    expect(await h.service.prepareLaunch(session('s2', { providerAccountId: b }))).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(h.leases.count(b)).toBe(0)
  })
})

describe('turning a provider off sees its running sessions', () => {
  it('Claude, whose sessions take no lease yet, is not turned off while one runs; a count that cannot be read refuses too', async () => {
    let running = 1
    const h = await harness({ unleasedSessions: (id) => { if (running < 0) throw new Error('unreadable'); return id === 'claude' ? running : 0 } })
    await addCodexAccount(h)
    expect(await h.service.setProviderEnabled('claude', false)).toMatchObject({ ok: false, code: 'consumers', consumers: 1 })
    running = -1
    expect(await h.service.setProviderEnabled('claude', false)).toMatchObject({ ok: false, code: 'consumers' })
    running = 0
    expect((await h.service.setProviderEnabled('claude', false)).ok).toBe(true)
  })
})

describe('the spawn request (pty:spawn schema; WP1.42)', () => {
  const codex = { provider: 'codex' as const, codexOptions: { permissionsPreset: 'read-only' as const } }
  it('names a Codex account by an opaque id, and only for a Codex session', async () => {
    const { spawnOptionsSchema } = await import('../../src/main/ipc/pty-handlers')
    const ok = (o: Record<string, unknown>) => spawnOptionsSchema.safeParse(o).success
    expect(ok({ ...codex, providerAccountId: 'acct-' + 'a'.repeat(32), acknowledgeRealmOnly: true })).toBe(true)
    expect(ok(codex)).toBe(true)
    for (const bad of ['', 'a b', 'acct/..', 'x'.repeat(65), 7]) expect(ok({ ...codex, providerAccountId: bad }), String(bad)).toBe(false)
    expect(ok({ ...codex, acknowledgeRealmOnly: 'yes' })).toBe(false)
    // A Claude session has its own accounts path: these fields are refused there.
    expect(ok({ provider: 'claude', providerAccountId: 'acct-' + 'a'.repeat(32) })).toBe(false)
    expect(ok({ acknowledgeRealmOnly: true })).toBe(false)
  })

  it('bounds the Codex model like the Claude model: it becomes a launch argument', async () => {
    const { spawnOptionsSchema } = await import('../../src/main/ipc/pty-handlers')
    const withModel = (model: unknown) => spawnOptionsSchema.safeParse({ ...codex, codexOptions: { ...codex.codexOptions, model } }).success
    for (const good of ['gpt-5.5', 'gpt-oss:20b', 'openai/gpt-5-codex', '']) expect(withModel(good), good).toBe(true)
    for (const bad of ['a&b', '-c', 'gpt 5', 'x'.repeat(65), 'a"b', 'a%b', '(x)']) expect(withModel(bad), bad).toBe(false)
  })
})

describe('after a restart', () => {
  it('the first launch proves the executable itself rather than refusing; with no CLI it refuses and holds nothing', async () => {
    const port = new MemoryPort()
    const folders = memoryFs()
    const first = await harness({ port, folders })
    const id = await addCodexAccount(first)
    const again = await harness({ port, folders })
    expect(again.discoveries()).toBe(0)
    expect((await again.service.prepareLaunch(session('s'))).ok).toBe(true)
    expect(again.discoveries()).toBe(1)
    const noCli = await harness({ port, folders, cli: false })
    expect(await noCli.service.prepareLaunch(session('s'))).toMatchObject({ ok: false, code: 'cli-unavailable' })
    expect(noCli.leases.count(id)).toBe(0)
  })
})

// WP2 commit 5b (owner decisions 1 and 3): a Claude review runs on a registry
// account through a launch the accounts service prepares -- the reviewer
// default, else the provider default, in that account's profile home -- and
// Claude sessions never launch this way (A12). A review tool is offered only
// while a review could be prepared now.
describe('a Claude review launch (WP2 5b)', () => {
  const PROFILES = ['profile-a1', 'profile-b2']
  async function claudeHarness(opts: { review?: boolean; seeds?: ReturnType<typeof claudeSnapshot>[] } = {}) {
    const box: { h?: Harness } = {}
    const composed: string[] = []
    const versionRuns: string[] = []
    const ports: ClaudeReviewPorts = {
      lookupRealm: async (ref) => {
        const r = box.h!.doc().realms.find((x) => x.id === ref.authRealmId)
        return r && r.lifecycle === 'active' ? { ok: true, realm: r } : { ok: false }
      },
      profileRealmLaunch: (id) => {
        composed.push(id)
        const home = `C:\\res\\profiles\\${id}`
        return { home, baseEnv: { PATH: 'C:\\Windows', ANTHROPIC_API_KEY: 'sk-ant-ambient-000000000000000000', USERPROFILE: 'C:\\Users\\u' }, realmEnv: { set: { USERPROFILE: home } }, sessionsDir: `${home}\\.claude\\projects` }
      },
      holdProfile: async () => () => {},
      recordPreflight: () => {},
      resolveExecutable: async () => 'C:\\Users\\u\\.local\\bin\\claude.exe',
      fileStat: { realpath: (p) => p, stat: () => ({ size: 1, mtimeMs: 1, ctimeMs: 1, dev: '1', ino: '1', isFile: true }) },
      commandLine: (e, a) => ({ file: e, args: [...a], verbatim: false, cwd: 'C:\\' }),
      shellEnv: () => ({}),
      run: async (cmd) => { versionRuns.push(cmd.args.join(' ')); return { exitCode: 0, stdout: '2.1.278 (Claude Code)\n', stderr: '', timedOut: false, truncated: false } },
      platform: 'win32',
    }
    const h = await harness({
      claude: opts.seeds ?? [claudeSnapshot(PROFILES[0], { isDefault: true }), claudeSnapshot(PROFILES[1])],
      ...(opts.review === false ? {} : { claudeReview: ports }),
    })
    box.h = h
    const idOf = (legacyId: string) => h.doc().legacyLinks.find((l) => l.legacyId === legacyId)!.accountId
    return { h, idOf, composed, versionRuns }
  }
  const review = (ownerId: string, over: Record<string, unknown> = {}) => ({ kind: 'review' as const, providerId: 'claude' as const, ownerId, ...over })

  it('a Claude session is refused here before anything is chosen, leased, proved or composed: its sessions keep their own path (A12)', async () => {
    const t = await claudeHarness()
    const a = t.idOf(PROFILES[0])
    for (const named of [{}, { providerAccountId: a }]) {
      const r = await t.h.service.prepareLaunch({ kind: 'session', providerId: 'claude', ownerId: 's', ...named })
      expect(r).toMatchObject({ ok: false, code: 'unsupported' })
    }
    expect(t.h.leases.count(a)).toBe(0)
    expect([t.composed, t.versionRuns]).toEqual([[], []])
    // The same guard lets Codex prepare both kinds.
    await addCodexAccount(t.h)
    expect((await t.h.service.prepareLaunch(session('c1'))).ok).toBe(true)
  })

  it('runs on the provider default, or the reviewer default once one is set, in that account\'s profile home, hardened', async () => {
    const t = await claudeHarness()
    const [a, b] = PROFILES.map(t.idOf)
    const first = await t.h.service.prepareLaunch(review('r1'))
    expect(first).toMatchObject({ ok: true, reviewer: 'provider-default', binding: { providerAccountId: a }, home: `C:\\res\\profiles\\${PROFILES[0]}` })
    if (!first.ok) return
    expect(first.env.USERPROFILE).toBe(`C:\\res\\profiles\\${PROFILES[0]}`)
    expect(Object.keys(first.env)).not.toContain('ANTHROPIC_API_KEY')
    expect(first.executable).toBe('C:\\Users\\u\\.local\\bin\\claude.exe')
    expect(t.h.leases.count(a)).toBe(1)
    first.lease.release()
    expect(await t.h.service.setReviewerDefault({ providerId: 'claude', accountId: b })).toEqual({ ok: true })
    expect(await t.h.service.prepareLaunch(review('r2'))).toMatchObject({ ok: true, reviewer: 'reviewer-default', binding: { providerAccountId: b } })
    expect(t.composed).toEqual([PROFILES[0], PROFILES[1]])
  })

  it('a review runs on this computer only, whichever provider reviews', async () => {
    const t = await claudeHarness()
    expect(await t.h.service.prepareLaunch(review('r', { remote: true }))).toMatchObject({ ok: false, code: 'unsupported' })
    await addCodexAccount(t.h)
    expect(await t.h.service.prepareLaunch({ kind: 'review', providerId: 'codex', ownerId: 'rc', remote: true })).toMatchObject({ ok: false, code: 'unsupported' })
    expect(t.composed).toEqual([])
  })

  it('is ready to offer only while it could be prepared: the reviewer, Claude on, an account that needs no confirmation', async () => {
    const t = await claudeHarness()
    expect(t.h.service.reviewReady('claude')).toBe(true)
    expect((await t.h.service.setProviderEnabled('claude', false)).ok).toBe(true)
    expect(t.h.service.reviewReady('claude')).toBe(false)
    expect((await t.h.service.setProviderEnabled('claude', true)).ok).toBe(true)
    expect(t.h.service.reviewReady('claude')).toBe(true)
    expect((await claudeHarness({ seeds: [] })).h.service.reviewReady('claude')).toBe(false)
    expect((await claudeHarness({ review: false })).h.service.reviewReady('claude')).toBe(false)
    // No default and no active account: nothing a review could use.
    const inactive = await claudeHarness({ seeds: [claudeSnapshot(PROFILES[0], { lifecycle: 'inactive' })] })
    expect(inactive.h.doc().accounts.filter((x) => x.providerId === 'claude').map((x) => x.lifecycle)).toEqual(['inactive'])
    expect(inactive.h.service.reviewReady('claude')).toBe(false)
    // Codex asks the same question of its own accounts: an unverified
    // sign-in (the adopted ~/.codex) needs a person's confirmation per
    // launch, which an agent cannot give, so it is not offered.
    expect(t.h.service.reviewReady('codex')).toBe(false)
    t.h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    expect((await t.h.service.adoptExternalDefault({ providerId: 'codex' })).ok).toBe(true)
    expect(t.h.service.reviewReady('codex')).toBe(false)
    const managed = await addCodexAccount(t.h)
    expect(await t.h.service.setReviewerDefault({ providerId: 'codex', accountId: managed })).toEqual({ ok: true })
    expect(t.h.service.reviewReady('codex')).toBe(true)
    // Asking composes no profile home (turning Claude on re-checks its CLI, as for Codex).
    expect(t.composed).toEqual([])
  })

  it('a package that prepares no reviews is never ready, and its realms are never read for session transcripts', async () => {
    const t = await claudeHarness()
    expect(await t.h.service.sessionsDirs('claude')).toEqual([])
    expect(t.composed).toEqual([])
  })
})

// ADR-009 round 1 (5b): each guard of the Claude review launch with a test
// that fails without it.
describe('a Claude review launch: round-1 regressions (WP2 5b)', () => {
  const P = ['profile-a1', 'profile-b2']
  async function setup(over: Partial<ClaudeReviewPorts> = {}) {
    const box: { h?: Harness } = {}
    const ports: ClaudeReviewPorts = {
      lookupRealm: async (ref) => {
        const r = box.h!.doc().realms.find((x) => x.id === ref.authRealmId)
        return r && r.lifecycle === 'active' ? { ok: true, realm: r } : { ok: false }
      },
      profileRealmLaunch: (id) => ({ home: `H:\\${id}`, baseEnv: { PATH: 'C:\\Windows' }, realmEnv: { set: { USERPROFILE: `H:\\${id}` } }, sessionsDir: `H:\\${id}\\p` }),
      holdProfile: async () => () => {},
      recordPreflight: () => {},
      resolveExecutable: async () => 'C:\\claude.exe',
      fileStat: { realpath: (p) => p, stat: () => ({ size: 1, mtimeMs: 1, ctimeMs: 1, dev: '1', ino: '1', isFile: true }) },
      commandLine: (e, a) => ({ file: e, args: [...a], verbatim: false, cwd: 'C:\\' }),
      shellEnv: () => ({}),
      run: async () => ({ exitCode: 0, stdout: '2.1.278 (Claude Code)\n', stderr: '', timedOut: false, truncated: false }),
      platform: 'win32',
      ...over,
    }
    const h = await harness({ claude: [claudeSnapshot(P[0], { isDefault: true }), claudeSnapshot(P[1])], claudeReview: ports })
    box.h = h
    return h
  }
  const review = (ownerId: string) => ({ kind: 'review' as const, providerId: 'claude' as const, ownerId })
  /** Whether a review is offered must be whether one can be prepared. */
  async function agrees(h: Harness, label: string): Promise<boolean> {
    const ready = h.service.reviewReady('claude')
    const r = await h.service.prepareLaunch(review(`agree-${label}`))
    if (r.ok) r.lease.release()
    expect(ready, `${label}: reviewReady ${ready} but prepareLaunch ${r.ok ? 'ok' : r.code}`).toBe(r.ok)
    return ready
  }

  it('a malformed kinds declaration prepares nothing; unknown entries are ignored', async () => {
    const h = await setup()
    const launch = h.claude.launch as unknown as { kinds: unknown }
    for (const bad of ['review', undefined, null, { 0: 'review' }, ['Review'], []]) {
      launch.kinds = bad
      expect(await h.service.prepareLaunch(review('m')), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'unsupported' })
      expect(h.service.reviewReady('claude')).toBe(false)
    }
    launch.kinds = ['bogus', 'review']
    expect(await agrees(h, 'mixed')).toBe(true)
  })

  it('offered exactly when it can be prepared, condition by condition', async () => {
    const h = await setup()
    expect(await agrees(h, 'fresh')).toBe(true)
    const launch = h.claude.launch as unknown as { kinds: unknown }
    launch.kinds = ['session']
    expect(await agrees(h, 'no review kind')).toBe(false)
    launch.kinds = ['review']
    const caps = h.claude.capabilities
    ;(h.claude as unknown as { capabilities: unknown }).capabilities = { ...caps, 'session.launch': { state: 'unsupported', note: 'test' } }
    expect(await agrees(h, 'capability off')).toBe(false)
    ;(h.claude as unknown as { capabilities: unknown }).capabilities = caps
    expect((await h.service.setProviderEnabled('claude', false)).ok).toBe(true)
    expect(await agrees(h, 'claude off')).toBe(false)
    expect((await h.service.setProviderEnabled('claude', true)).ok).toBe(true)
    h.useStore(null)
    expect(await agrees(h, 'no registry')).toBe(false)
    h.useStore(h.store)
    expect(await agrees(h, 'back')).toBe(true)
  })

  it('a reviewer default that became inactive is not offered, and not prepared', async () => {
    const h = await setup()
    const b = h.doc().legacyLinks.find((l) => l.legacyId === P[1])!.accountId
    expect(await h.service.setReviewerDefault({ providerId: 'claude', accountId: b })).toEqual({ ok: true })
    h.setClaude([claudeSnapshot(P[0], { isDefault: true }), claudeSnapshot(P[1], { lifecycle: 'inactive' })])
    const identityId = h.doc().accounts.find((x) => x.id === b)!.identityId
    expect((await h.service.updateIdentity({ identityId, colourKey: 'plum' })).ok).toBe(true)
    await agrees(h, 'reviewer inactive')
  })

  it('a package whose sessions do not launch here is never read for session transcripts', async () => {
    const h = await setup()
    const launch = h.claude.launch as unknown as { sessionsDir: () => Promise<string | null> }
    launch.sessionsDir = async () => 'H:\\would-be-read'
    expect(await h.service.sessionsDirs('claude')).toEqual([])
  })

  it('a profile that cannot review here says why, and holds nothing', async () => {
    const h = await setup({ profileRealmLaunch: () => ({ refused: 'on macOS a review runs on your normal Claude sign-in, which is your primary account' }) })
    const a = h.doc().legacyLinks.find((l) => l.legacyId === P[0])!.accountId
    expect(await h.service.prepareLaunch(review('mac'))).toMatchObject({ ok: false, code: 'realm-unavailable', message: expect.stringContaining('primary account') })
    expect(h.leases.count(a)).toBe(0)
  })
})
