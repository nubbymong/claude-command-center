// WP1.16 / WP1.46 / WP1.61 -- WP2 commit 3 (design 11; plan A11): consumer
// leases, for sessions and reviewer invocations alike (one launch-lease API). Account-scoped and reference-counted; one lease per owner, so a
// running-session count is exact; release is idempotent; an exclusive hold
// (sign-out, archive) and a new consumer can never both win; acquisition and
// every lifecycle change that reads the count run under the registry lock, so
// a launch cannot slip between the check and the change; a failure, a
// cancellation and a destroyed renderer all release. Leases are in memory
// only: nothing survives a restart, so no stale lease exists to reclaim.
//
// PURE: the real Codex package on a fake CLI, in-memory everything.
import { describe, it, expect } from 'vitest'
import { ConsumerLeaseRegistry } from '../../src/main/providers/core'
import { harness, addCodexAccount, MemoryPort, KEY, managedHome } from './accounts-harness'
import type { ProviderPreference } from '../../src/shared/providers'

describe('the lease registry (WP1.46, WP1.61)', () => {
  it('counts one lease per owner, per account; sessions are counted apart', () => {
    const r = new ConsumerLeaseRegistry()
    const a = r.add('acct-a', 'codex', { kind: 'session', ownerId: 's1' })
    const b = r.add('acct-a', 'codex', { kind: 'session', ownerId: 's2' })
    r.add('acct-a', 'codex', { kind: 'sign-in', ownerId: 'x' })
    r.add('acct-b', 'codex', { kind: 'session', ownerId: 's3' })
    expect([a.ok, b.ok]).toEqual([true, true])
    expect([r.count('acct-a'), r.runningSessions('acct-a'), r.count('acct-b'), r.countForProvider('codex'), r.countForProvider('claude')]).toEqual([3, 2, 1, 4, 0])
    expect(r.describe('acct-a')).toEqual({ session: 2, review: 0, 'sign-in': 1, operation: 0 })
    // The same owner again is the same lease, counted once.
    const again = r.add('acct-a', 'codex', { kind: 'session', ownerId: 's1' })
    expect(again).toMatchObject({ ok: true, existing: true })
    expect(r.runningSessions('acct-a')).toBe(2)
    // One owner cannot hold two accounts.
    expect(r.add('acct-b', 'codex', { kind: 'session', ownerId: 's1' })).toEqual({ ok: false, code: 'owner-conflict' })
  })

  it('release is idempotent and never drops another consumer, even a later lease of the same owner', () => {
    const r = new ConsumerLeaseRegistry()
    const first = r.add('acct-a', 'codex', { kind: 'session', ownerId: 's1' })
    if (!first.ok) throw new Error('add')
    r.add('acct-a', 'codex', { kind: 'session', ownerId: 's2' })
    first.lease.release()
    first.lease.release()
    expect(r.count('acct-a')).toBe(1)
    const reborn = r.add('acct-a', 'codex', { kind: 'session', ownerId: 's1' })
    if (!reborn.ok) throw new Error('add')
    first.lease.release()
    expect(r.count('acct-a')).toBe(2)
    expect(r.releaseOwner('session', 's1')).toBe(true)
    expect(r.releaseOwner('session', 's1')).toBe(false)
    expect(r.count('acct-a')).toBe(1)
  })

  it('an exclusive hold is granted only with no consumers, refuses new ones while held, and lets go once', () => {
    const r = new ConsumerLeaseRegistry()
    const l = r.add('acct-a', 'codex', { kind: 'session', ownerId: 's1' })
    expect(r.hold('acct-a', 'codex')).toBeNull()
    if (l.ok) l.lease.release()
    const release = r.hold('acct-a', 'codex')
    expect(release).not.toBeNull()
    expect(r.hold('acct-a', 'codex')).toBeNull()
    expect(r.add('acct-a', 'codex', { kind: 'session', ownerId: 's2' })).toEqual({ ok: false, code: 'held' })
    // Another account is not affected.
    expect(r.add('acct-b', 'codex', { kind: 'session', ownerId: 's3' }).ok).toBe(true)
    release!()
    const second = r.hold('acct-b', 'codex')
    expect(second).toBeNull()
    release!()
    expect(r.add('acct-a', 'codex', { kind: 'session', ownerId: 's2' }).ok).toBe(true)
  })

  it('a destroyed renderer releases what it held, and only that', () => {
    const r = new ConsumerLeaseRegistry()
    r.add('acct-a', 'codex', { kind: 'sign-in', ownerId: 'x', webContentsId: 7 })
    r.add('acct-a', 'codex', { kind: 'sign-in', ownerId: 'y', webContentsId: 8 })
    r.add('acct-a', 'codex', { kind: 'session', ownerId: 's1' })
    expect(r.releaseForRenderer(7)).toBe(1)
    expect(r.describe('acct-a')).toEqual({ session: 1, review: 0, 'sign-in': 1, operation: 0 })
  })
})

describe('leases through the accounts service (WP1.16, WP1.46)', () => {
  it('N concurrent sessions on one account show N running, and 0 once they have all ended in any order', async () => {
    const h = await harness()
    const id = await addCodexAccount(h)
    const N = 7
    const results = await Promise.all(Array.from({ length: N }, (_, i) => h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: id, ownerId: `s${i}` })))
    expect(results.every((r) => r.ok)).toBe(true)
    const view = () => h.service.snapshot().accounts.find((a) => a.id === id)!
    expect([view().runningSessions, view().consumers]).toEqual([N, N])
    // A session asking twice is still one session.
    expect((await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: id, ownerId: 's3' })).ok).toBe(true)
    expect(view().runningSessions).toBe(N)
    for (const i of [4, 0, 6, 2, 1, 5, 3]) {
      expect(h.service.releaseLaunch('session', `s${i}`)).toBe(true)
    }
    expect([view().runningSessions, view().consumers]).toEqual([0, 0])
    expect(h.service.releaseLaunch('session', 's0')).toBe(false)
  })

  it('a launch and a deactivation never both win, whichever starts first', async () => {
    for (let round = 0; round < 12; round++) {
      const h = await harness()
      const id = await addCodexAccount(h)
      const launch = () => h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: id, ownerId: 's' })
      const deactivate = () => h.service.setLifecycle({ accountId: id, lifecycle: 'inactive' })
      const [first, second] = round % 2 === 0 ? [launch(), deactivate()] : [deactivate(), launch()]
      const [a, b] = await Promise.all([first, second])
      const launched = (round % 2 === 0 ? a : b).ok
      const deactivated = (round % 2 === 0 ? b : a).ok
      expect(launched !== deactivated, `round ${round}`).toBe(true)
      const account = h.doc().accounts.find((x) => x.id === id)!
      expect(account.lifecycle, `round ${round}`).toBe(launched ? 'active' : 'inactive')
      if (!deactivated) expect(round % 2 === 0 ? b : a).toMatchObject({ code: 'consumers', consumers: 1 })
    }
  })

  it('a launch and a provider switch-off never both win', async () => {
    for (let round = 0; round < 8; round++) {
      const h = await harness()
      const id = await addCodexAccount(h)
      const launch = () => h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: id, ownerId: 's' })
      const off = () => h.service.setProviderEnabled('codex', false)
      const pair = round % 2 === 0 ? [launch(), off()] : [off(), launch()]
      const [x, y] = await Promise.all(pair)
      const launched = (round % 2 === 0 ? x : y).ok
      const switched = (round % 2 === 0 ? y : x).ok
      expect(launched !== switched, `round ${round}`).toBe(true)
      expect(h.service.isEnabled('codex')).toBe(!switched)
    }
  })

  it('a sign-out holds the account for its whole run: no session starts meanwhile, and none is running when it starts', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const h = await harness({ script: { 'logout': async (r) => { await gate; h.signedIn.delete(r.home.toLowerCase()); return { exitCode: 0 } } } })
    const id = await addCodexAccount(h)
    const out = h.service.logout({ accountId: id })
    await new Promise((r) => setTimeout(r, 0))
    expect(await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: id, ownerId: 's' })).toMatchObject({ ok: false, code: 'busy' })
    expect(await h.service.setLifecycle({ accountId: id, lifecycle: 'inactive' })).toMatchObject({ ok: false, code: 'busy' })
    release()
    expect(await out).toEqual({ ok: true, state: 'signed-out' })
    expect((await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: id, ownerId: 's' })).ok).toBe(true)
    // And now a sign-out is refused, naming the count.
    expect(await h.service.logout({ accountId: id })).toMatchObject({ ok: false, code: 'consumers', consumers: 1 })
  })

  it('a session binds only through its own account: a mismatched provider, an unknown or inactive account, or an unacknowledged unverified one is refused before any lease', async () => {
    const h = await harness()
    const id = await addCodexAccount(h)
    expect(await h.service.acquireLaunchLease({ kind: 'session', providerId: 'claude', providerAccountId: id, ownerId: 's1' })).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: 'acct-' + 'f'.repeat(32), ownerId: 's2' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: 'idn-' + 'f'.repeat(32), ownerId: 's3' })).toMatchObject({ ok: false, code: 'invalid-id' })
    expect((await h.service.setLifecycle({ accountId: id, lifecycle: 'inactive' })).ok).toBe(true)
    expect(await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: id, ownerId: 's4' })).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(h.leases.count(id)).toBe(0)
    // The unverified external sign-in needs an acknowledgement per launch.
    h.signedIn.set('c:\\users\\u\\.codex', 'chatgpt')
    const ext = await h.service.adoptExternalDefault({ providerId: 'codex' })
    if (!ext.ok) throw new Error(ext.code)
    expect(await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: ext.accountId, ownerId: 's5' })).toMatchObject({ ok: false, code: 'acknowledgement-required' })
    const acked = await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: ext.accountId, ownerId: 's5', acknowledgeRealmOnly: true })
    expect(acked).toMatchObject({ ok: true, realmOnly: true })
  })

  it('a sign-in lease is released after a failure, a cancellation and a destroyed renderer', async () => {
    // Failure.
    const failing = await harness({ script: { 'login': () => { throw new Error('spawn exploded') } } })
    const b1 = await failing.service.beginSetup({ providerId: 'codex', method: 'browser' })
    const a1 = (b1 as { accountId: string }).accountId
    expect((await failing.service.signIn({ accountId: a1, method: 'browser' }, 3)).ok).toBe(false)
    expect(failing.leases.count(a1)).toBe(0)

    // Cancellation, and a destroyed renderer: the run is aborted either way.
    for (const how of ['cancel', 'destroyed'] as const) {
      let started: () => void = () => {}
      const running = new Promise<void>((r) => { started = r })
      const h = await harness({
        script: {
          'login': (r) => new Promise((resolve) => {
            started()
            r.opts.signal?.addEventListener('abort', () => resolve({ spawnError: 'cancelled', stopped: 'cancel' }))
          }),
        },
      })
      const b = await h.service.beginSetup({ providerId: 'codex', method: 'browser' })
      const accountId = (b as { accountId: string }).accountId
      const run = h.service.signIn({ accountId, method: 'browser' }, 9)
      await running
      expect(h.leases.describe(accountId)['sign-in'], how).toBe(1)
      if (how === 'cancel') {
        // Only the renderer that started it may cancel it.
        expect(h.service.cancelSignIn({ accountId }, 10)).toMatchObject({ ok: false, code: 'not-found' })
        expect(h.service.cancelSignIn({ accountId }, 9)).toEqual({ ok: true })
      } else {
        h.service.releaseRenderer(9)
      }
      expect(await run, how).toMatchObject({ ok: false, code: 'cancelled' })
      expect(h.leases.count(accountId), how).toBe(0)
      expect(h.service.snapshot().pendingSetups[0].signingIn, how).toBe(false)
    }
  })

  it('nothing survives a restart: leases are the running process\'s, so a new start holds none and blocks nothing', async () => {
    const port = new MemoryPort()
    const h = await harness({ port })
    const id = await addCodexAccount(h)
    expect((await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: id, ownerId: 's' })).ok).toBe(true)
    expect(port.file).not.toContain('"session"')
    const again = await harness({ port })
    expect(again.leases.count(id)).toBe(0)
    expect((await again.service.setLifecycle({ accountId: id, lifecycle: 'inactive' })).ok).toBe(true)
  })
})

describe('reviewer invocations: one lease API with sessions (plan: provider review through MCP)', () => {
  it('the registry counts review leases apart from sessions, and releases them by owner', () => {
    const r = new ConsumerLeaseRegistry()
    r.add('acct-a', 'codex', { kind: 'session', ownerId: 'x' })
    r.add('acct-a', 'codex', { kind: 'review', ownerId: 'x' })
    expect(r.describe('acct-a')).toEqual({ session: 1, review: 1, 'sign-in': 0, operation: 0 })
    expect([r.count('acct-a'), r.runningSessions('acct-a'), r.countKind('acct-a', 'review')]).toEqual([2, 1, 1])
    expect(r.releaseOwner('review', 'x')).toBe(true)
    expect(r.describe('acct-a')).toEqual({ session: 1, review: 0, 'sign-in': 0, operation: 0 })
  })

  it('a review naming no account runs on the reviewer default, else the provider default; a named one runs on that one', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    expect(await h.service.acquireLaunchLease({ kind: 'review', providerId: 'codex', ownerId: 'r1' })).toMatchObject({ ok: true, reviewer: 'provider-default', binding: { providerAccountId: a } })
    expect(await h.service.setReviewerDefault({ providerId: 'codex', accountId: b })).toEqual({ ok: true })
    expect(h.service.snapshot().accounts.find((x) => x.id === b)).toMatchObject({ isReviewerDefault: true })
    expect(await h.service.acquireLaunchLease({ kind: 'review', providerId: 'codex', ownerId: 'r2' })).toMatchObject({ ok: true, reviewer: 'reviewer-default', binding: { providerAccountId: b } })
    expect(await h.service.acquireLaunchLease({ kind: 'review', providerId: 'codex', providerAccountId: a, ownerId: 'r3' })).toMatchObject({ ok: true, reviewer: 'explicit', binding: { providerAccountId: a } })
    const view = (id: string) => h.service.snapshot().accounts.find((x) => x.id === id)!
    expect([view(a).runningReviews, view(a).runningSessions, view(a).consumers, view(b).runningReviews]).toEqual([2, 0, 2, 1])
    expect(await h.service.setReviewerDefault({ providerId: 'codex', accountId: null })).toEqual({ ok: true })
    expect(view(b).isReviewerDefault).toBe(false)
  })

  it('a running review holds its account exactly as a session does', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    await addCodexAccount(h, 'B')
    expect((await h.service.acquireLaunchLease({ kind: 'review', providerId: 'codex', providerAccountId: a, ownerId: 'r' })).ok).toBe(true)
    expect(await h.service.logout({ accountId: a })).toMatchObject({ ok: false, code: 'consumers', consumers: 1 })
    expect(await h.service.setProviderEnabled('codex', false)).toMatchObject({ ok: false, code: 'consumers' })
    expect(h.service.releaseLaunch('review', 'r')).toBe(true)
    expect(h.service.releaseLaunch('review', 'r')).toBe(false)
    expect((await h.service.logout({ accountId: a })).ok).toBe(true)
  })

  it('a review and a deactivation never both win, whichever starts first', async () => {
    for (let round = 0; round < 12; round++) {
      const h = await harness()
      const id = await addCodexAccount(h)
      const review = () => h.service.acquireLaunchLease({ kind: 'review', providerId: 'codex', ownerId: 'r' })
      const deactivate = () => h.service.setLifecycle({ accountId: id, lifecycle: 'inactive' })
      const [first, second] = round % 2 === 0 ? [review(), deactivate()] : [deactivate(), review()]
      const [x, y] = await Promise.all([first, second])
      const reviewed = (round % 2 === 0 ? x : y).ok
      const deactivated = (round % 2 === 0 ? y : x).ok
      expect(reviewed !== deactivated, `round ${round}`).toBe(true)
    }
  })

  it('a chosen reviewer account that cannot run is refused, never swapped for another; nothing is leased', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    expect(await h.service.setReviewerDefault({ providerId: 'codex', accountId: b })).toEqual({ ok: true })
    expect((await h.service.setLifecycle({ accountId: b, lifecycle: 'inactive' })).ok).toBe(true)
    expect(await h.service.acquireLaunchLease({ kind: 'review', providerId: 'codex', ownerId: 'r' })).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(h.leases.count(a) + h.leases.count(b)).toBe(0)
    // Another provider's account, named explicitly, is refused.
    expect(await h.service.acquireLaunchLease({ kind: 'review', providerId: 'claude', providerAccountId: a, ownerId: 'r' })).toMatchObject({ ok: false, code: 'invalid-request' })
  })

  it('refused before any lease: no account of that provider, a session without its account, a kind that is not a launch, an unacknowledged unverified default', async () => {
    const h = await harness()
    expect(await h.service.acquireLaunchLease({ kind: 'review', providerId: 'codex', ownerId: 'r' })).toMatchObject({ ok: false, code: 'not-found' })
    expect(await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', ownerId: 's' })).toMatchObject({ ok: false, code: 'invalid-request' })
    for (const kind of ['sign-in', 'operation', 'bogus'] as const) {
      expect(await h.service.acquireLaunchLease({ kind: kind as never, providerId: 'codex', ownerId: 'x' }), kind).toMatchObject({ ok: false, code: 'invalid-request' })
      expect(h.service.releaseLaunch(kind as never, 'x'), kind).toBe(false)
    }
    // Only the unverified external sign-in: it is the provider default, and
    // cannot become the reviewer default.
    h.signedIn.set('c:\\users\\u\\.codex', 'chatgpt')
    const ext = await h.service.adoptExternalDefault({ providerId: 'codex' })
    if (!ext.ok) throw new Error(ext.code)
    expect(await h.service.acquireLaunchLease({ kind: 'review', providerId: 'codex', ownerId: 'r' })).toMatchObject({ ok: false, code: 'acknowledgement-required' })
    expect(await h.service.setReviewerDefault({ providerId: 'codex', accountId: ext.accountId })).toMatchObject({ ok: false, code: 'realm-only' })
    expect(h.leases.count(ext.accountId)).toBe(0)
  })
})

describe('ADR-009 round 1 regressions: sign-in runs, holds and the provider switch', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('a second sign-in on the same setup is refused without releasing the running one\'s lease', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const h = await harness({ script: { 'login': async (r) => { await gate; h.signedIn.set(r.home.toLowerCase(), 'chatgpt'); return { exitCode: 0 } } } })
    const b = await h.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
    const first = h.service.signIn({ accountId: b.accountId, method: 'browser' }, 1)
    expect(await h.service.signIn({ accountId: b.accountId, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'busy' })
    await tick()
    expect(h.leases.describe(b.accountId)['sign-in']).toBe(1)
    expect(await h.service.setProviderEnabled('codex', false)).toMatchObject({ ok: false, code: 'consumers' })
    release()
    expect(await first).toEqual({ ok: true, state: 'signed-in' })
    expect(h.leases.count(b.accountId)).toBe(0)
  })

  it('a double-click with the same key handle keeps the key the first click is using', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const h = await harness({
      script: {
        'login --with-api-key': async (r) => {
          await gate
          if (typeof r.opts.stdin !== 'string' || !r.opts.stdin.trim()) return { exitCode: 3 }
          h.signedIn.set(r.home.toLowerCase(), 'api-key')
          return { exitCode: 0 }
        },
      },
    })
    const b = await h.service.beginSetup({ providerId: 'codex', method: 'apiKey' }) as { accountId: string }
    const issued = h.service.issueSecretHandle({ accountId: b.accountId }, 1) as { handle: string }
    h.service.depositSecret(issued.handle, 1, KEY)
    const first = h.service.signIn({ accountId: b.accountId, method: 'apiKey', secretHandle: issued.handle }, 1)
    expect(await h.service.signIn({ accountId: b.accountId, method: 'apiKey', secretHandle: issued.handle }, 1)).toMatchObject({ ok: false, code: 'busy' })
    release()
    expect(await first).toEqual({ ok: true, state: 'signed-in' })
    expect(h.secrets.size()).toBe(0)
  })

  it('a renderer that goes away aborts its sign-in, and the lease stays until the process has actually stopped', async () => {
    let started: () => void = () => {}
    const running = new Promise<void>((r) => { started = r })
    let stop: () => void = () => {}
    const stopped = new Promise<void>((r) => { stop = r })
    const h = await harness({
      script: { 'login': (r) => new Promise((resolve) => { started(); r.opts.signal?.addEventListener('abort', () => { void stopped.then(() => resolve({ spawnError: 'cancelled', stopped: 'cancel' })) }) }) },
    })
    const b = await h.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
    const run = h.service.signIn({ accountId: b.accountId, method: 'browser' }, 9)
    await running
    h.service.releaseRenderer(9)
    expect(h.leases.count(b.accountId)).toBe(1)
    expect(await h.service.setProviderEnabled('codex', false)).toMatchObject({ ok: false, code: 'consumers' })
    stop()
    expect(await run).toMatchObject({ ok: false, code: 'cancelled' })
    expect(h.leases.count(b.accountId)).toBe(0)
  })

  it('a provider switch-off waits for a sign-out in progress; a switched-off provider runs no account operation', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    let pref: ProviderPreference = 'on'
    const h = await harness({ preference: { codex: () => pref }, script: { 'logout': async (r) => { await gate; h.signedIn.delete(r.home.toLowerCase()); return { exitCode: 0 } } } })
    const a = await addCodexAccount(h, 'A')
    const out = h.service.logout({ accountId: a })
    await tick()
    expect(await h.service.setProviderEnabled('codex', false)).toMatchObject({ ok: false, code: 'consumers', consumers: 1 })
    release()
    expect((await out).ok).toBe(true)
    pref = 'off'
    const before = h.runs.length
    expect(await h.service.refreshStatus({ accountId: a })).toMatchObject({ ok: false, code: 'provider-disabled' })
    expect(await h.service.logout({ accountId: a })).toMatchObject({ ok: false, code: 'provider-disabled' })
    expect(await h.service.reconcileSignIn({ accountId: a })).toMatchObject({ ok: false, code: 'provider-disabled' })
    expect(h.runs.length).toBe(before)
  })

  it('a switch made here gives way to the saved setting once it is read back, or once another writer changes it', async () => {
    let saved: ProviderPreference = 'undecided'
    const h = await harness({ preference: { codex: () => saved } })
    expect((await h.service.setProviderEnabled('codex', true)).ok).toBe(true)
    expect(h.service.preferenceOf('codex')).toBe('on')
    // Another writer (the old Codex settings) saves "off": that wins.
    saved = 'off'
    expect(h.service.preferenceOf('codex')).toBe('off')
    expect(await h.service.beginSetup({ providerId: 'codex', method: 'browser' })).toMatchObject({ ok: false, code: 'provider-disabled' })
    expect(await h.service.migrateExternalDefault('codex')).toMatchObject({ ok: true, outcome: 'skipped' })
    // Switched on here again; the saved setting catches up, and later says off.
    expect((await h.service.setProviderEnabled('codex', true)).ok).toBe(true)
    saved = 'on'
    expect(h.service.preferenceOf('codex')).toBe('on')
    saved = 'off'
    expect(h.service.preferenceOf('codex')).toBe('off')
  })
})

describe('ADR-009 confirmation regressions: the switch fails closed, and exclusions hold under the lock', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('a switch-on made here gives way to a saved "off" even after an unseen on-and-off', async () => {
    let saved: ProviderPreference = 'off'
    const h = await harness({ preference: { codex: () => saved } })
    expect((await h.service.setProviderEnabled('codex', true)).ok).toBe(true)
    // Saved "on", then "off" again, with nothing reading in between.
    saved = 'on'
    saved = 'off'
    expect(h.service.preferenceOf('codex')).toBe('off')
    expect(await h.service.migrateExternalDefault('codex')).toMatchObject({ ok: true, outcome: 'skipped' })
  })

  it('an unreadable settings read turns nothing on: the last value read stands, and a switch-off made here stands', async () => {
    let saved: ProviderPreference = 'off'
    let broken = false
    const h = await harness({ preference: { codex: () => { if (broken) throw new Error('locked'); return saved } } })
    const a = await addCodexAccountWhileOn(h, () => { saved = 'on' }, () => { saved = 'off' })
    expect(h.service.isEnabled('codex')).toBe(false)
    broken = true
    expect(h.service.isEnabled('codex')).toBe(false)
    expect(await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: 's' })).toMatchObject({ ok: false, code: 'provider-disabled' })
    // A switch-off made here survives a failed read and a stale "on".
    broken = false
    saved = 'on'
    expect(h.service.isEnabled('codex')).toBe(true)
    expect((await h.service.setProviderEnabled('codex', false)).ok).toBe(true)
    broken = true
    expect(h.service.isEnabled('codex')).toBe(false)
    broken = false
    expect(h.service.isEnabled('codex')).toBe(false)
    saved = 'off'
    expect(h.service.preferenceOf('codex')).toBe('off')
  })

  it('a failed read keeps a switch-on made here; another writer saving on does not undo a switch-off made here', async () => {
    let saved: ProviderPreference = 'off'
    let broken = false
    const h = await harness({ preference: { codex: () => { if (broken) throw new Error('locked'); return saved } } })
    expect((await h.service.setProviderEnabled('codex', true)).ok).toBe(true)
    broken = true
    expect(h.service.isEnabled('codex')).toBe(true)
    broken = false
    saved = 'on'
    expect(h.service.preferenceOf('codex')).toBe('on')
    // Undecided on disk, switched off here, then another writer saves on.
    saved = 'undecided'
    expect((await h.service.setProviderEnabled('codex', false)).ok).toBe(true)
    saved = 'on'
    expect(h.service.isEnabled('codex')).toBe(false)
    saved = 'off'
    expect(h.service.preferenceOf('codex')).toBe('off')
  })

  it('a refused API-key retry on a signed-in setup does not erase the kind of sign-in: a later change is still caught', async () => {
    const h = await harness()
    const b = await h.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
    expect((await h.service.signIn({ accountId: b.accountId, method: 'browser' }, 1)).ok).toBe(true)
    const issued = h.service.issueSecretHandle({ accountId: b.accountId }, 1) as { handle: string }
    h.service.depositSecret(issued.handle, 1, KEY)
    expect(await h.service.signIn({ accountId: b.accountId, method: 'apiKey', secretHandle: issued.handle }, 1)).toMatchObject({ ok: false, code: 'already-signed-in' })
    expect((await h.service.completeSetup({ accountId: b.accountId, identity: { mode: 'new', colourKey: 'violet' } })).ok).toBe(true)
    expect(h.doc().accounts[0].authMethod).toBe('browser')
    h.signedIn.set(managedHome(h.doc().accounts[0].authRealmId).toLowerCase(), 'api-key')
    await h.service.refreshStatus({ accountId: b.accountId })
    expect(h.doc().accounts[0].operationalState).toBe('blocked')
  })

  it('a switch-off queued with an operation never lets both win: the operation re-checks under the lock and runs no CLI', async () => {
    for (const op of ['logout', 'refresh', 'complete', 'abandon', 'signin', 'adopt'] as const) {
      const h = await harness()
      const a = await addCodexAccount(h, 'A')
      const pending = await h.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
      await h.service.signIn({ accountId: pending.accountId, method: 'browser' }, 1)
      const fresh = await h.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
      h.signedIn.set('c:\\users\\u\\.codex', 'chatgpt')
      const before = h.runs.length
      // Queued first: the switch-off takes the lock before the operation's hold or lease.
      const offing = h.service.setProviderEnabled('codex', false)
      const run = op === 'logout' ? h.service.logout({ accountId: a })
        : op === 'refresh' ? h.service.refreshStatus({ accountId: a })
          : op === 'complete' ? h.service.completeSetup({ accountId: pending.accountId, identity: { mode: 'new', colourKey: 'violet' } })
            : op === 'abandon' ? h.service.abandonSetup({ accountId: pending.accountId })
              : op === 'signin' ? h.service.signIn({ accountId: fresh.accountId, method: 'browser' }, 1)
                : h.service.adoptExternalDefault({ providerId: 'codex' })
      const [off, done] = await Promise.all([offing, run])
      expect(off.ok, op).toBe(true)
      expect(done, op).toMatchObject({ ok: false, code: 'provider-disabled' })
      expect(h.runs.length, op).toBe(before)
    }
  })

  it('a sign-in cannot start while its setup is being completed', async () => {
    let open: () => void = () => {}
    const gate = new Promise<void>((r) => { open = r })
    let gated = false
    const h = await harness({ script: { 'login status': async (r) => { if (gated) await gate; return h.signedIn.has(r.home.toLowerCase()) ? { exitCode: 0, stderr: 'Logged in using ChatGPT\n' } : { exitCode: 1, stderr: 'Not logged in\n' } } } })
    const b = await h.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
    await h.service.signIn({ accountId: b.accountId, method: 'browser' }, 1)
    gated = true
    const complete = h.service.completeSetup({ accountId: b.accountId, identity: { mode: 'new', colourKey: 'violet' } })
    await tick()
    const logins = h.args().filter((x) => x === 'login').length
    expect(await h.service.signIn({ accountId: b.accountId, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'busy' })
    expect(h.args().filter((x) => x === 'login').length).toBe(logins)
    open()
    expect((await complete).ok).toBe(true)
  })
})

/** Add an account while the provider is on, then leave it off. */
async function addCodexAccountWhileOn(h: Awaited<ReturnType<typeof harness>>, on: () => void, off: () => void): Promise<string> {
  on()
  const id = await addCodexAccount(h, 'A')
  off()
  return id
}
