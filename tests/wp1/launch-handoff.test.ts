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
import { harness, addCodexAccount, managedHome, memoryFs, MemoryPort, EXE, EXT_HOME } from './accounts-harness'
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
