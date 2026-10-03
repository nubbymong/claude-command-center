// [host] WP2 PR 4, P4.5 (row 57): a Cloud Agent's run is a launch of its own
// kind, `background`, prepared by the accounts service on the one path
// sessions and reviews take: the Codex package lists it; the account named,
// else the provider default; the same acknowledgement rule as a session (for
// the account the request names only); a lease of the background kind on
// exactly that account, counted by `describe` and holding the account until
// it is released; local only; a package that does not list the kind refuses
// it, in words that name it. PURE: the real Codex package on a fake CLI
// (the WP1 accounts harness), in-memory everything.
import { describe, it, expect } from 'vitest'
import { harness, addCodexAccount, managedHome, EXE, EXT_HOME } from '../../wp1/accounts-harness'
import type { Harness } from '../../wp1/accounts-harness'

const bg = (ownerId: string, over: Record<string, unknown> = {}) => ({ kind: 'background' as const, providerId: 'codex' as const, ownerId, remote: false, ...over })
const realmOf = (h: Harness, accountId: string) => h.doc().accounts.find((a) => a.id === accountId)!.authRealmId

describe('a background launch (P4.5)', () => {
  it('the Codex package prepares the background kind, with its own run port', async () => {
    const h = await harness()
    expect(h.codex.launch?.kinds).toContain('background')
    expect(typeof (h.codex as { background?: { run?: unknown } }).background?.run).toBe('function')
    const a = await addCodexAccount(h)
    const r = await h.service.prepareLaunch(bg('cloud-agent:ca-1'))
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
    expect(r.binding.providerAccountId).toBe(a)
    expect(r.home).toBe(managedHome(realmOf(h, a)))
    expect(r.executable).toBe(EXE)
    expect(r.env.CODEX_HOME).toBe(r.home)
    expect(r.lease.kind).toBe('background')
    expect(h.leases.describe(a)).toMatchObject({ background: 1, session: 0, review: 0 })
    // The account is held: no sign-out or archive while it runs.
    expect(h.leases.hold(a, 'codex')).toBeNull()
    expect(h.service.releaseLaunch('background', 'cloud-agent:ca-1')).toBe(true)
    expect(h.leases.count(a)).toBe(0)
  })

  it('a named account is used; another provider\'s or an unknown one is refused before any lease', async () => {
    const h = await harness()
    await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    const r = await h.service.prepareLaunch(bg('o1', { providerAccountId: b }))
    if (!r.ok) throw new Error(r.code)
    expect(r.binding.providerAccountId).toBe(b)
    expect(await h.service.prepareLaunch(bg('o2', { providerAccountId: 'acct-' + 'f'.repeat(32) }))).toMatchObject({ ok: false, code: 'not-found' })
    expect(await h.service.prepareLaunch({ ...bg('o3', { providerAccountId: b }), providerId: 'claude' as const })).toMatchObject({ ok: false, code: 'unsupported' })
    expect(h.leases.count(b)).toBe(1)
  })

  it('the sign-in already on this computer needs this launch\'s acknowledgement, for the account the request names only', async () => {
    const h = await harness()
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    const ext = await h.service.adoptExternalDefault({ providerId: 'codex' })
    if (!ext.ok) throw new Error(ext.code)
    const id = ext.accountId
    expect(await h.service.prepareLaunch(bg('o1', { providerAccountId: id }))).toMatchObject({ ok: false, code: 'acknowledgement-required' })
    expect(await h.service.prepareLaunch(bg('o2', { acknowledgeRealmOnly: true }))).toMatchObject({ ok: false, code: 'acknowledgement-required' })
    expect(h.leases.count(id)).toBe(0)
    const r = await h.service.prepareLaunch(bg('o3', { providerAccountId: id, acknowledgeRealmOnly: true }))
    if (!r.ok) throw new Error(r.code)
    expect([r.realmOnly, r.home]).toEqual([true, EXT_HOME])
    expect(h.leases.describe(id)).toMatchObject({ background: 1 })
  })

  it('runs on this computer only', async () => {
    const h = await harness()
    const a = await addCodexAccount(h)
    expect(await h.service.prepareLaunch(bg('o1', { remote: true }))).toMatchObject({ ok: false, code: 'unsupported', message: 'A background run runs on this computer only.' })
    expect(h.leases.count(a)).toBe(0)
  })

  it('switched off: nothing is prepared', async () => {
    const h = await harness()
    const a = await addCodexAccount(h)
    expect((await h.service.setProviderEnabled('codex', false)).ok).toBe(true)
    expect(await h.service.prepareLaunch(bg('o1'))).toMatchObject({ ok: false })
    expect(h.leases.count(a)).toBe(0)
  })

  it('a running background run refuses a switch-off, as a session does', async () => {
    const h = await harness()
    await addCodexAccount(h)
    const r = await h.service.prepareLaunch(bg('o1'))
    if (!r.ok) throw new Error(r.code)
    expect(await h.service.setProviderEnabled('codex', false)).toMatchObject({ ok: false, code: 'consumers' })
    r.lease.release()
    expect((await h.service.setProviderEnabled('codex', false)).ok).toBe(true)
  })

  it('a package that does not list the kind refuses it, naming a background run', async () => {
    const h = await harness()
    await addCodexAccount(h)
    const launch = h.codex.launch as unknown as { kinds: unknown }
    launch.kinds = ['session', 'review']
    expect(await h.service.prepareLaunch(bg('o1'))).toMatchObject({ ok: false, code: 'unsupported', message: 'Codex does not start a background run this way.' })
    launch.kinds = ['background']
    expect(await h.service.prepareLaunch({ kind: 'session', providerId: 'codex', ownerId: 's1' })).toMatchObject({ ok: false, code: 'unsupported', message: 'Codex does not start a session this way.' })
    expect(await h.service.prepareLaunch({ kind: 'review', providerId: 'codex', ownerId: 'r1' })).toMatchObject({ ok: false, code: 'unsupported', message: 'Codex does not start a review this way.' })
  })
})
