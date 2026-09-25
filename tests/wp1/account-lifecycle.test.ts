// WP1.15 / WP1.16 / WP1.24 / WP1.50 -- WP2 commit 3 (design 5.3, 5.5, 10,
// 11): account lifecycle through the accounts service. Inactive and archived
// accounts stay resolvable for history but are never offered for new work;
// running consumers block inactivation, archive and sign-out, and the refusal
// says how many; re-activation checks the sign-in first; a managed archive
// signs out first and leaves a credential-free tombstone, and a failed
// sign-out fails the archive; an external home's sign-out and archive need
// the user's acknowledgement of their wider effect, and a check first that
// the home still holds the sign-in on record (design 5.5); a sign-in that
// changed blocks the account until the user reconciles it. Claude's own
// accounts keep their rules (removed where they were created).
//
// PURE: the real Codex package on a fake CLI, in-memory everything.
import { describe, it, expect, vi } from 'vitest'
import { harness, addCodexAccount, claudeSnapshot, managedHome, EXT_HOME, MemoryPort } from './accounts-harness'
import { selectableAccounts, findRealm } from '../../src/shared/providers'

async function withExternal(h: Awaited<ReturnType<typeof harness>>) {
  h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
  const r = await h.service.adoptExternalDefault({ providerId: 'codex' })
  if (!r.ok) throw new Error(r.code)
  return r.accountId
}

describe('account lifecycle (WP1.15, WP1.16, WP1.50)', () => {
  it('an inactive account leaves the pickers but stays in the list, with its history; it comes back after a status check', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    expect((await h.service.setLifecycle({ accountId: b, lifecycle: 'inactive' })).ok).toBe(true)
    expect(selectableAccounts(h.doc(), 'codex').map((x) => x.id)).toEqual([a])
    expect(h.service.snapshot().accounts.find((x) => x.id === b)).toMatchObject({ lifecycle: 'inactive' })
    // Signed out meanwhile: it comes back needing attention, never as ready.
    const realm = findRealm(h.doc(), h.doc().accounts.find((x) => x.id === b)!.authRealmId)!
    h.signedIn.delete(managedHome(realm.id).toLowerCase())
    const before = h.runs.length
    expect((await h.service.setLifecycle({ accountId: b, lifecycle: 'active' })).ok).toBe(true)
    expect(h.args().slice(before)).toEqual(['login status'])
    expect(h.doc().accounts.find((x) => x.id === b)).toMatchObject({ lifecycle: 'active', lastKnownAuthState: 'signed-out', operationalState: 'attention' })
  })

  it('running consumers block inactivation, archive and sign-out, and the refusal names how many', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    await addCodexAccount(h, 'B')
    await h.service.setDefault({ accountId: (h.doc().accounts[1]).id })
    for (const s of ['s1', 's2']) expect((await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: s })).ok).toBe(true)
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })).toMatchObject({ ok: false, code: 'consumers', consumers: 2 })
    expect(await h.service.logout({ accountId: a })).toMatchObject({ ok: false, code: 'consumers', consumers: 2 })
    expect(h.service.consumersOf(a)).toEqual({ session: 2, review: 0, 'sign-in': 0, operation: 0 })
    h.service.releaseLaunch('session', 's1')
    h.service.releaseLaunch('session', 's2')
    expect((await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })).ok).toBe(true)
  })

  it('the default account cannot be switched off while another is active; choosing another default first works', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })).toMatchObject({ ok: false, code: 'default-required' })
    expect(await h.service.setDefault({ accountId: b })).toEqual({ ok: true })
    expect((await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })).ok).toBe(true)
  })

  it('a managed archive signs out first and leaves a credential-free tombstone; the folder and history stay', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const realmId = h.doc().accounts[0].authRealmId
    expect((await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })).ok).toBe(true)
    const before = h.runs.length
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })).toEqual({ ok: true })
    expect(h.args().slice(before)).toEqual(['login status', 'logout', 'login status'])
    expect(h.signedIn.has(managedHome(realmId).toLowerCase())).toBe(false)
    expect(h.doc().accounts[0]).toMatchObject({ lifecycle: 'archived', lastKnownAuthState: 'signed-out' })
    expect(findRealm(h.doc(), realmId)).toMatchObject({ lifecycle: 'retired' })
    expect(h.folders.exists(managedHome(realmId))).toBe(true)
  })

  it('a failed sign-out fails the archive: the account stays inactive and signed in', async () => {
    const h = await harness({ script: { 'logout': () => ({ exitCode: 1, stderr: 'network down\n' }) } })
    const a = await addCodexAccount(h, 'A')
    await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })
    const r = await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })
    expect(r.ok).toBe(false)
    expect(h.doc().accounts[0]).toMatchObject({ lifecycle: 'inactive' })
  })

  it('archiving an active account is refused by the rules, not by a sign-out', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const before = h.runs.length
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(h.runs.length).toBe(before)
  })
})

describe('the external home (WP1.24, WP1.50)', () => {
  it('is shown unverified and external, and its sign-out needs the acknowledgement; with it, the CLI signs that home out', async () => {
    const h = await harness()
    const ext = await withExternal(h)
    expect(h.service.snapshot().accounts.find((a) => a.id === ext)).toMatchObject({ external: true, unverified: true, identityAssurance: 'realm-only' })
    const before = h.runs.length
    expect(await h.service.logout({ accountId: ext })).toMatchObject({ ok: false, code: 'acknowledgement-required' })
    expect(h.runs.length).toBe(before)
    expect(await h.service.logout({ accountId: ext, acknowledgeExternal: true })).toEqual({ ok: true, state: 'signed-out' })
    expect(h.runs.slice(before).map((r) => [r.args, r.home])).toEqual([['login status', EXT_HOME], ['logout', EXT_HOME], ['login status', EXT_HOME]])
  })

  it('archiving it needs the credentials-remain acknowledgement and never signs it out', async () => {
    const h = await harness()
    const ext = await withExternal(h)
    await h.service.setLifecycle({ accountId: ext, lifecycle: 'inactive' })
    expect(await h.service.setLifecycle({ accountId: ext, lifecycle: 'archived' })).toMatchObject({ ok: false, code: 'acknowledgement-required' })
    const before = h.runs.length
    expect(await h.service.setLifecycle({ accountId: ext, lifecycle: 'archived', acknowledgeExternal: true })).toEqual({ ok: true })
    expect(h.runs.slice(before).map((r) => [r.args, r.home])).toEqual([['login status', EXT_HOME]])
    expect(h.signedIn.get(EXT_HOME.toLowerCase())).toBe('chatgpt')
    // Retired: the home may be adopted again later.
    expect((await h.service.adoptExternalDefault({ providerId: 'codex' })).ok).toBe(true)
  })

  it('can never be linked to another identity', async () => {
    const h = await harness()
    const ext = await withExternal(h)
    const managed = await addCodexAccount(h, 'M')
    const target = h.doc().accounts.find((a) => a.id === managed)!.identityId
    expect(await h.service.linkIdentity({ accountId: ext, identityId: target })).toMatchObject({ ok: false, code: 'not-linkable' })
    expect(await h.service.unlinkIdentity({ accountId: ext })).toMatchObject({ ok: false, code: 'not-linkable' })
  })
})

describe('Claude accounts keep their own rules', () => {
  it('a Claude account is removed where it was created, and its sign-in is its own', async () => {
    const h = await harness({ claude: [claudeSnapshot('profile-a1', { isDefault: true }), claudeSnapshot('profile-b2')] })
    const b = h.doc().accounts.find((a) => a.providerId === 'claude' && !a.isProviderDefault)!
    expect((await h.service.setLifecycle({ accountId: b.id, lifecycle: 'inactive' })).ok).toBe(true)
    expect(await h.service.setLifecycle({ accountId: b.id, lifecycle: 'archived' })).toMatchObject({ ok: false, code: 'legacy-owned' })
    expect(await h.service.logout({ accountId: b.id })).toMatchObject({ ok: false, code: 'unsupported' })
    expect(await h.service.refreshStatus({ accountId: b.id })).toMatchObject({ ok: false, code: 'unsupported' })
    expect(h.runs).toEqual([])
  })
})

describe('a sign-in that changed, and reconciling it (WP1.24, WP1.25; design 5.3, 5.5)', () => {
  const account = (h: Awaited<ReturnType<typeof harness>>, id: string) => h.doc().accounts.find((x) => x.id === id)!
  const STATUS = {
    'api-key': { exitCode: 0, stderr: 'Logged in using an API key - sk-proj-***7788\n' },
    chatgpt: { exitCode: 0, stderr: 'Logged in using ChatGPT\n' },
    out: { exitCode: 1, stderr: 'Not logged in\n' },
    garbage: { exitCode: 2, stderr: 'garbage\n' },
  }

  it('an external home now signed in with an API key: the sign-out checks first, is refused, and runs nothing else', async () => {
    const h = await harness()
    const ext = await withExternal(h)
    h.signedIn.set(EXT_HOME.toLowerCase(), 'api-key')
    const before = h.runs.length
    expect(await h.service.logout({ accountId: ext, acknowledgeExternal: true })).toMatchObject({ ok: false, code: 'sign-in-changed' })
    expect(h.args().slice(before)).toEqual(['login status'])
    expect(h.signedIn.get(EXT_HOME.toLowerCase())).toBe('api-key')
    expect(account(h, ext)).toMatchObject({ operationalState: 'blocked', authMethod: 'external' })
    // Blocked: no launch, and the refusal stays until the user reconciles.
    expect(await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: ext, ownerId: 's', acknowledgeRealmOnly: true })).toMatchObject({ ok: false, code: 'lifecycle' })
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    expect(await h.service.logout({ accountId: ext, acknowledgeExternal: true })).toMatchObject({ ok: false, code: 'sign-in-changed' })
    h.signedIn.set(EXT_HOME.toLowerCase(), 'api-key')
    expect(await h.service.reconcileSignIn({ accountId: ext })).toEqual({ ok: true, state: 'signed-in' })
    expect(account(h, ext)).toMatchObject({ operationalState: 'ready', authMethod: 'apiKey', identityAssurance: 'realm-only' })
    expect(await h.service.logout({ accountId: ext, acknowledgeExternal: true })).toEqual({ ok: true, state: 'signed-out' })
  })

  it('an external archive checks first: a changed sign-in is refused; a check that cannot run does not keep the record, unless it is already blocked', async () => {
    let mode: keyof typeof STATUS = 'chatgpt'
    const h = await harness({ script: { 'login status': (r) => (r.home.toLowerCase() === EXT_HOME.toLowerCase() ? STATUS[mode] : STATUS.out) } })
    const a = await withExternal(h)
    await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })
    mode = 'api-key'
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived', acknowledgeExternal: true })).toMatchObject({ ok: false, code: 'sign-in-changed' })
    expect(account(h, a).lifecycle).toBe('inactive')
    // The CLI no longer answers: an already-blocked record still stays.
    mode = 'garbage'
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived', acknowledgeExternal: true })).toMatchObject({ ok: false, code: 'sign-in-changed' })
    expect(account(h, a).lifecycle).toBe('inactive')

    let quietMode: keyof typeof STATUS = 'chatgpt'
    const q = await harness({ script: { 'login status': (r) => (r.home.toLowerCase() === EXT_HOME.toLowerCase() ? STATUS[quietMode] : STATUS.out) } })
    const b = await withExternal(q)
    await q.service.setLifecycle({ accountId: b, lifecycle: 'inactive' })
    quietMode = 'garbage'
    expect(await q.service.setLifecycle({ accountId: b, lifecycle: 'archived', acknowledgeExternal: true })).toEqual({ ok: true })
    expect(account(q, b).lifecycle).toBe('archived')
  })

  it('a managed realm that now reports another kind of sign-in is blocked by a status check; it cannot be the default or review until reconciled', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    const home = managedHome(account(h, b).authRealmId).toLowerCase()
    h.signedIn.set(home, 'api-key')
    expect(await h.service.refreshStatus({ accountId: b })).toEqual({ ok: true, state: 'signed-in' })
    expect(account(h, b)).toMatchObject({ operationalState: 'blocked', authMethod: 'browser' })
    expect(h.service.snapshot().accounts.find((x) => x.id === b)).toMatchObject({ operationalState: 'blocked' })
    expect(await h.service.setDefault({ accountId: b })).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(await h.service.setReviewerDefault({ providerId: 'codex', accountId: b })).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(await h.service.acquireLaunchLease({ kind: 'review', providerId: 'codex', providerAccountId: b, ownerId: 'r' })).toMatchObject({ ok: false, code: 'lifecycle' })
    // The original kind again does not clear it: blocked is sticky.
    h.signedIn.set(home, 'chatgpt')
    await h.service.refreshStatus({ accountId: b })
    expect(account(h, b).operationalState).toBe('blocked')
    expect(await h.service.reconcileSignIn({ accountId: b })).toEqual({ ok: true, state: 'signed-in' })
    expect(account(h, b)).toMatchObject({ operationalState: 'ready', authMethod: 'browser' })
    expect(await h.service.setDefault({ accountId: b })).toEqual({ ok: true })
    expect(account(h, a).isProviderDefault).toBe(false)
  })

  it('a reconcile whose check does not answer leaves the account blocked; an archived or a Claude account is not reconciled here', async () => {
    const homes = new Map<string, 'chatgpt' | 'api-key'>()
    let garbage = false
    const h = await harness({
      claude: [claudeSnapshot('profile-a1', { isDefault: true })],
      script: {
        'login status': (r) => (garbage ? STATUS.garbage : STATUS[homes.get(r.home.toLowerCase()) ?? 'out']),
        'login': (r) => { homes.set(r.home.toLowerCase(), 'chatgpt'); return { exitCode: 0, stdout: 'Successfully logged in\n' } },
        'logout': (r) => { homes.delete(r.home.toLowerCase()); return { exitCode: 0, stdout: 'Successfully logged out\n' } },
      },
    })
    const a = await addCodexAccount(h, 'A')
    homes.set(managedHome(account(h, a).authRealmId).toLowerCase(), 'api-key')
    await h.service.refreshStatus({ accountId: a })
    expect(account(h, a).operationalState).toBe('blocked')
    garbage = true
    expect((await h.service.reconcileSignIn({ accountId: a })).ok).toBe(false)
    expect(account(h, a).operationalState).toBe('blocked')
    garbage = false
    const claude = h.doc().accounts.find((x) => x.providerId === 'claude')!
    expect(await h.service.reconcileSignIn({ accountId: claude.id })).toMatchObject({ ok: false, code: 'unsupported' })
    expect(await h.service.reconcileSignIn({ accountId: 'acct-' + 'e'.repeat(32) })).toMatchObject({ ok: false, code: 'not-found' })
    const b = await addCodexAccount(h, 'B')
    await h.service.setDefault({ accountId: b })
    await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })
    await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })
    expect(account(h, a).lifecycle).toBe('archived')
    const runs = h.runs.length
    expect(await h.service.reconcileSignIn({ accountId: a })).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(h.runs.length).toBe(runs)
  })
})

describe('ADR-009 round 1 regressions: archived records, capabilities, setup races, attribution', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const OFF = { state: 'unknown' as const, note: 'off for this test' }

  it('an archived external record runs nothing: it cannot sign out the home a newer account is using', async () => {
    const h = await harness()
    const e1 = await withExternal(h)
    const m = await addCodexAccount(h, 'M')
    await h.service.setDefault({ accountId: m })
    await h.service.setLifecycle({ accountId: e1, lifecycle: 'inactive' })
    expect(await h.service.setLifecycle({ accountId: e1, lifecycle: 'archived', acknowledgeExternal: true })).toEqual({ ok: true })
    const again = await h.service.adoptExternalDefault({ providerId: 'codex' })
    if (!again.ok) throw new Error(again.code)
    expect((await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: again.accountId, ownerId: 's', acknowledgeRealmOnly: true })).ok).toBe(true)
    const before = h.runs.length
    expect(await h.service.logout({ accountId: e1, acknowledgeExternal: true })).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(await h.service.refreshStatus({ accountId: e1 })).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(await h.service.reconcileSignIn({ accountId: e1 })).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(h.runs.length).toBe(before)
    expect(h.signedIn.get(EXT_HOME.toLowerCase())).toBe('chatgpt')
  })

  it('the production realm source hands out only a realm being set up or in use', async () => {
    vi.resetModules()
    const realms: Record<string, 'pending' | 'active' | 'retiring' | 'retired' | 'recovery'> = {}
    vi.doMock('../../src/main/provider-account-registry', () => ({
      getAccountRegistry: () => ({ current: () => ({ realms: Object.entries(realms).map(([id, lifecycle]) => ({ id, lifecycle })) }) }),
      getAccountRegistryResourcesDir: () => 'C:\\res',
    }))
    try {
      const { codexRealmSource } = await import('../../src/main/providers/compose')
      for (const lifecycle of ['pending', 'active', 'retiring', 'retired', 'recovery'] as const) {
        realms['realm-x'] = lifecycle
        const r = await codexRealmSource.lookup({ authRealmId: 'realm-x' })
        expect(r.ok, lifecycle).toBe(lifecycle === 'pending' || lifecycle === 'active')
      }
    } finally {
      vi.doUnmock('../../src/main/provider-account-registry')
      vi.resetModules()
    }
  })

  it('with status or sign-out not enabled, no path runs them: completion, abandon, archive, reactivation and the start-up adoption refuse', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    await addCodexAccount(h, 'B').then((b) => h.service.setDefault({ accountId: b }))
    await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })
    const pending = await h.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
    await h.service.signIn({ accountId: pending.accountId, method: 'browser' }, 1)
    for (const off of [{ 'auth.status': OFF }, { 'auth.logout': OFF }]) {
      h.setCapabilities(off)
      const key = Object.keys(off)[0]
      const before = h.runs.length
      expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' }), key).toMatchObject({ ok: false, code: 'capability-disabled' })
      expect(await h.service.abandonSetup({ accountId: pending.accountId }), key).toMatchObject({ ok: false, code: 'capability-disabled' })
      if (key === 'auth.status') {
        expect(await h.service.completeSetup({ accountId: pending.accountId, identity: { mode: 'new', colourKey: 'violet' } })).toMatchObject({ ok: false, code: 'capability-disabled' })
        expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'active' })).toMatchObject({ ok: false, code: 'capability-disabled' })
        expect(await h.service.migrateExternalDefault('codex')).toMatchObject({ ok: false, code: 'capability-disabled' })
      }
      expect(h.runs.length, key).toBe(before)
      expect(h.doc().accounts.find((x) => x.id === a)?.lifecycle, key).toBe('inactive')
      expect(h.doc().journals.map((j) => j.accountId), key).toEqual([pending.accountId])
    }
    expect(h.doc().migrations).toEqual([])
  })

  it('completing and abandoning one setup exclude each other: whichever holds it first wins, the other is told busy', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const h = await harness({ script: { 'logout': async (r) => { await gate; h.signedIn.delete(r.home.toLowerCase()); return { exitCode: 0 } } } })
    const b = await h.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
    await h.service.signIn({ accountId: b.accountId, method: 'browser' }, 1)
    const abandon = h.service.abandonSetup({ accountId: b.accountId })
    await tick()
    expect(await h.service.completeSetup({ accountId: b.accountId, identity: { mode: 'new', colourKey: 'violet' } })).toMatchObject({ ok: false, code: 'busy' })
    release()
    expect(await abandon).toEqual({ ok: true })
    expect(h.doc().accounts).toEqual([])
    expect(h.doc().journals).toEqual([])

    let hold: () => void = () => {}
    const statusGate = new Promise<void>((r) => { hold = r })
    let gated = false
    const k = await harness({ script: { 'login status': async (r) => { if (gated) await statusGate; return k.signedIn.has(r.home.toLowerCase()) ? { exitCode: 0, stderr: 'Logged in using ChatGPT\n' } : { exitCode: 1, stderr: 'Not logged in\n' } } } })
    const c = await k.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
    await k.service.signIn({ accountId: c.accountId, method: 'browser' }, 1)
    gated = true
    const complete = k.service.completeSetup({ accountId: c.accountId, identity: { mode: 'new', colourKey: 'violet' } })
    await tick()
    expect(await k.service.abandonSetup({ accountId: c.accountId })).toMatchObject({ ok: false, code: 'busy' })
    hold()
    expect((await complete).ok).toBe(true)
  })

  it('nothing joins the identity of an unverified sign-in: not by linking, not by completing a setup into it', async () => {
    const h = await harness({ claude: [claudeSnapshot('profile-a1', { isDefault: true })] })
    const ext = await withExternal(h)
    const extIdentity = h.doc().accounts.find((x) => x.id === ext)!.identityId
    const claude = h.doc().accounts.find((x) => x.providerId === 'claude')!
    const managed = await addCodexAccount(h, 'M')
    expect(await h.service.linkIdentity({ accountId: claude.id, identityId: extIdentity })).toMatchObject({ ok: false, code: 'not-linkable' })
    expect(await h.service.linkIdentity({ accountId: managed, identityId: extIdentity })).toMatchObject({ ok: false, code: 'not-linkable' })
    const b = await h.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
    await h.service.signIn({ accountId: b.accountId, method: 'browser' }, 1)
    expect(await h.service.completeSetup({ accountId: b.accountId, identity: { mode: 'link', identityId: extIdentity } })).toMatchObject({ ok: false, code: 'not-linkable' })
    expect(h.doc().accounts.filter((x) => x.identityId === extIdentity).map((x) => x.id)).toEqual([ext])
  })

  it('a setup finished after a restart keeps the kind of sign-in it began with, so a later change is still caught', async () => {
    const port = new MemoryPort()
    const h = await harness({ port })
    const b = await h.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
    await h.service.signIn({ accountId: b.accountId, method: 'browser' }, 1)
    const realmId = h.doc().journals[0].realmId
    const after = await harness({ port })
    // The same machine after a restart: the folder is still there, signed in.
    after.folders.fs.mkdirSecure(managedHome(realmId))
    after.signedIn.set(managedHome(realmId).toLowerCase(), 'chatgpt')
    expect((await after.service.completeSetup({ accountId: b.accountId, identity: { mode: 'new', colourKey: 'violet' } })).ok).toBe(true)
    expect(after.doc().accounts[0].authMethod).toBe('browser')
    after.signedIn.set(managedHome(realmId).toLowerCase(), 'api-key')
    await after.service.refreshStatus({ accountId: b.accountId })
    expect(after.doc().accounts[0].operationalState).toBe('blocked')
  })

  it('a Claude account turned inactive here is written to Claude\'s own list at once', async () => {
    const h = await harness({ claude: [claudeSnapshot('profile-a1', { isDefault: true }), claudeSnapshot('profile-b2')] })
    const b = h.doc().accounts.find((a) => a.providerId === 'claude' && !a.isProviderDefault)!
    const before = h.legacyWrites.length
    expect((await h.service.setLifecycle({ accountId: b.id, lifecycle: 'inactive' })).ok).toBe(true)
    expect(h.legacyWrites.slice(before)).toContainEqual({ providerId: 'claude', legacyId: 'profile-b2', field: 'lifecycle', value: 'inactive' })
  })
})

describe('ADR-009 coverage: guards the first tests did not reach', () => {
  const OFF = { state: 'unknown' as const, note: 'off for this test' }

  it('sign-out and reconcile are gated by their own capabilities too', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const before = h.runs.length
    h.setCapabilities({ 'auth.logout': OFF })
    expect(await h.service.logout({ accountId: a })).toMatchObject({ ok: false, code: 'capability-disabled' })
    h.setCapabilities({ 'auth.status': OFF })
    expect(await h.service.reconcileSignIn({ accountId: a })).toMatchObject({ ok: false, code: 'capability-disabled' })
    expect(await h.service.refreshStatus({ accountId: a })).toMatchObject({ ok: false, code: 'capability-disabled' })
    expect(h.runs.length).toBe(before)
  })

  it('an external home already blocked is not archived while its check cannot run (status capability off)', async () => {
    const h = await harness()
    const ext = await withExternal(h)
    await h.service.setLifecycle({ accountId: ext, lifecycle: 'inactive' })
    h.signedIn.set(EXT_HOME.toLowerCase(), 'api-key')
    await h.service.refreshStatus({ accountId: ext })
    expect(h.doc().accounts.find((x) => x.id === ext)?.operationalState).toBe('blocked')
    h.setCapabilities({ 'auth.status': OFF })
    expect(await h.service.setLifecycle({ accountId: ext, lifecycle: 'archived', acknowledgeExternal: true })).toMatchObject({ ok: false, code: 'sign-in-changed' })
    expect(h.doc().accounts.find((x) => x.id === ext)?.lifecycle).toBe('inactive')
  })

  it('a managed archive holds the account through its sign-out: re-activation meanwhile is refused', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const h = await harness({ script: { 'logout': async (r) => { await gate; h.signedIn.delete(r.home.toLowerCase()); return { exitCode: 0 } } } })
    const a = await addCodexAccount(h, 'A')
    await addCodexAccount(h, 'B').then((b) => h.service.setDefault({ accountId: b }))
    await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })
    const archiving = h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })
    await new Promise((r) => setTimeout(r, 0))
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'active' })).toMatchObject({ ok: false, code: 'busy' })
    release()
    expect(await archiving).toEqual({ ok: true })
    expect(h.doc().accounts.find((x) => x.id === a)?.lifecycle).toBe('archived')
  })

  it('a Claude account removed from its own list while it is the reviewer default is archived cleanly, and the choice goes with it', async () => {
    const h = await harness({ claude: [claudeSnapshot('profile-a1', { isDefault: true }), claudeSnapshot('profile-b2')] })
    const [a, b] = ['profile-a1', 'profile-b2'].map((id) => h.doc().legacyLinks.find((l) => l.legacyId === id)!.accountId)
    expect(await h.service.setReviewerDefault({ providerId: 'claude', accountId: b })).toEqual({ ok: true })
    h.setClaude([claudeSnapshot('profile-a1', { isDefault: true })])
    const identityId = h.doc().accounts.find((x) => x.id === a)!.identityId
    expect((await h.service.updateIdentity({ identityId, colourKey: 'plum' })).ok).toBe(true)
    const gone = h.doc().accounts.find((x) => x.id === b)!
    expect(gone.lifecycle).toBe('archived')
    expect('isReviewerDefault' in gone).toBe(false)
  })

  it('the saved settings that cannot be read are no answer: a provider last read as off stays off', async () => {
    vi.resetModules()
    let read: { value: Record<string, unknown> | null; outcome: string } = { value: { codexEnabled: false }, outcome: 'ok' }
    vi.doMock('../../src/main/config-manager', () => ({ readConfigChecked: () => read }))
    try {
      const core = await import('../../src/main/providers/core')
      const { createCodexPackage } = await import('../../src/main/providers/codex')
      core._resetProviderRegistryForTest()
      core.registerProviderPackage(createCodexPackage())
      const { initProviderAccounts } = await import('../../src/main/provider-accounts')
      const svc = initProviderAccounts()
      expect(svc.preferenceOf('codex')).toBe('off')
      read = { value: null, outcome: 'failed' }
      expect(svc.preferenceOf('codex')).toBe('off')
      expect(svc.isEnabled('codex')).toBe(false)
    } finally {
      vi.doUnmock('../../src/main/config-manager')
      vi.resetModules()
    }
  })
})

// WP2 commit 6b: "Sign in again" on an existing managed account (the Accounts
// menu). The provider's own login runs in the account's OWN realm, then the
// realm is recorded as a status check records it (design 5.5): a different
// kind of sign-in blocks the account.
describe('signing an existing account in again (WP2 6b)', () => {
  const realmHome = (h: Awaited<ReturnType<typeof harness>>, accountId: string) =>
    managedHome(findRealm(h.doc(), h.doc().accounts.find((x) => x.id === accountId)!.authRealmId)!.id).toLowerCase()

  it('an expired sign-in comes back through its own realm, and the record says so', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    h.signedIn.delete(realmHome(h, a))
    expect(await h.service.refreshStatus({ accountId: a })).toEqual({ ok: true, state: 'signed-out' })
    const lines: string[] = []
    expect(await h.service.signInAgain({ accountId: a, method: 'browser' }, 1, (t) => lines.push(t))).toEqual({ ok: true, state: 'signed-in' })
    expect(h.signedIn.get(realmHome(h, a))).toBe('chatgpt')
    expect(h.doc().accounts.find((x) => x.id === a)).toMatchObject({ lastKnownAuthState: 'signed-in', operationalState: 'ready' })
    // It is still the same account, in the same realm: no new setup, no new account.
    expect(h.doc().accounts.filter((x) => x.providerId === 'codex')).toHaveLength(1)
    expect(h.doc().journals).toEqual([])
    expect(h.service.consumersOf(a)).toEqual({ session: 0, review: 0, 'sign-in': 0, operation: 0 })
  })

  it('a different kind of sign-in blocks the account until the user reconciles it', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    // Signed out first: the provider never logs in over a realm that is signed in.
    expect(await h.service.logout({ accountId: a })).toEqual({ ok: true, state: 'signed-out' })
    const issued = h.service.issueSecretHandle({ accountId: a }, 1)
    if (!issued.ok) throw new Error(issued.code)
    h.service.depositSecret(issued.handle, 1, 'sk-proj-' + 'x'.repeat(40))
    // Recorded from the login itself, and said so: not a success.
    expect(await h.service.signInAgain({ accountId: a, method: 'apiKey', secretHandle: issued.handle }, 1)).toMatchObject({ ok: false, code: 'sign-in-changed', state: 'signed-in' })
    expect(h.doc().accounts.find((x) => x.id === a)!.operationalState).toBe('blocked')
    // Blocked: reconcile first. Nothing runs on it at all -- a login here could
    // overwrite the very sign-in the user is asked to confirm.
    const runsBefore = h.runs.length
    expect(await h.service.signInAgain({ accountId: a, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'sign-in-changed' })
    expect(h.runs.length).toBe(runsBefore)
  })

  it('is refused while anything uses the account, and says how many', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    expect((await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: 's1' })).ok).toBe(true)
    const before = h.runs.length
    expect(await h.service.signInAgain({ accountId: a, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'consumers', consumers: 1 })
    expect(h.runs.length).toBe(before)
  })

  it('never on an external home, an archived account, or a key that was not deposited for this account by this window', async () => {
    const h = await harness()
    const ext = await withExternal(h)
    expect(await h.service.signInAgain({ accountId: ext, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'unsupported' })
    expect(h.service.issueSecretHandle({ accountId: ext }, 1)).toMatchObject({ ok: false, code: 'unsupported' })
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    // A handle issued for B, or to another window, is refused and burned.
    const forB = h.service.issueSecretHandle({ accountId: b }, 1)
    if (!forB.ok) throw new Error(forB.code)
    h.service.depositSecret(forB.handle, 1, 'sk-proj-' + 'y'.repeat(40))
    expect(await h.service.signInAgain({ accountId: a, method: 'apiKey', secretHandle: forB.handle }, 1)).toMatchObject({ ok: false, code: 'secret-unavailable' })
    expect(await h.service.signInAgain({ accountId: b, method: 'apiKey', secretHandle: forB.handle }, 1)).toMatchObject({ ok: false, code: 'secret-unavailable' })
    const forA = h.service.issueSecretHandle({ accountId: a }, 1)
    if (!forA.ok) throw new Error(forA.code)
    h.service.depositSecret(forA.handle, 1, 'sk-proj-' + 'z'.repeat(40))
    expect(await h.service.signInAgain({ accountId: a, method: 'apiKey', secretHandle: forA.handle }, 2)).toMatchObject({ ok: false, code: 'secret-unavailable' })
    // A browser sign-in carries no handle.
    expect(await h.service.signInAgain({ accountId: a, method: 'browser', secretHandle: forA.handle }, 1)).toMatchObject({ ok: false })
    // Archived: nothing runs on it.
    expect((await h.service.setLifecycle({ accountId: b, lifecycle: 'inactive' })).ok).toBe(true)
    expect((await h.service.setLifecycle({ accountId: b, lifecycle: 'archived' })).ok).toBe(true)
    expect(await h.service.signInAgain({ accountId: b, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(h.service.issueSecretHandle({ accountId: b }, 1)).toMatchObject({ ok: false, code: 'unsupported' })
  })

  it('on a realm that is still signed in it runs no login and just records the check', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const before = h.runs.length
    expect(await h.service.signInAgain({ accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    expect(h.args().slice(before).filter((x) => x !== 'login status')).toEqual([])
  })

  it('nothing launches on the account while its sign-in is replaced, and the record is written before the hold ends (ADR-009 6b)', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let armed = false
    // The first login (the account's setup) is the ordinary one; once armed, the
    // login is held open and leaves an API key behind.
    const h = await harness({ script: { login: async (r) => {
      if (armed) await held
      h.signedIn.set(r.home.toLowerCase(), armed ? 'api-key' : 'chatgpt')
      return { exitCode: 0, stdout: 'Successfully logged in' + String.fromCharCode(10) }
    } } })
    const a = await addCodexAccount(h, 'A', 'browser')
    armed = true
    expect(await h.service.logout({ accountId: a })).toEqual({ ok: true, state: 'signed-out' })
    const running = h.service.signInAgain({ accountId: a, method: 'browser' }, 1)
    await new Promise((r) => setTimeout(r, 0))
    expect(await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: 's-during' })).toMatchObject({ ok: false, code: 'busy' })
    expect(await h.service.prepareLaunch({ kind: 'review', providerId: 'codex', ownerId: 'r-during' })).toMatchObject({ ok: false })
    release()
    await running
    // The login left an API key where a ChatGPT sign-in was recorded: blocked
    // before anything could launch, and still refused afterwards.
    expect(h.doc().accounts.find((x) => x.id === a)!.operationalState).toBe('blocked')
    expect(await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: 's-after' })).toMatchObject({ ok: false })
  })

  it('a sign-in whose kind cannot be read is compared by the kind of login that ran (ADR-009 6b)', async () => {
    let vague = false
    // Once vague, the CLI says only that it is signed in, never how.
    const h = await harness({ script: { 'login status': (r) => {
      const v = h.signedIn.get(r.home.toLowerCase())
      if (!v) return { exitCode: 1, stderr: 'Not logged in' + String.fromCharCode(10) }
      return vague ? { exitCode: 0, stderr: 'Logged in' + String.fromCharCode(10) } : { exitCode: 0, stderr: (v === 'chatgpt' ? 'Logged in using ChatGPT' : 'Logged in using an API key - sk-proj-***7788') + String.fromCharCode(10) }
    } } })
    const a = await addCodexAccount(h, 'A', 'browser')
    expect(await h.service.logout({ accountId: a })).toEqual({ ok: true, state: 'signed-out' })
    vague = true
    const issued = h.service.issueSecretHandle({ accountId: a }, 1)
    if (!issued.ok) throw new Error(issued.code)
    h.service.depositSecret(issued.handle, 1, 'sk-proj-' + 'v'.repeat(40))
    expect(await h.service.signInAgain({ accountId: a, method: 'apiKey', secretHandle: issued.handle }, 1)).toMatchObject({ ok: false, code: 'sign-in-changed' })
    expect(h.doc().accounts.find((x) => x.id === a)!.operationalState).toBe('blocked')
  })

  it('a new sign-in the record could not take refuses launches until a later check records (ADR-009 6b)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A', 'browser')
    expect(await h.service.logout({ accountId: a })).toEqual({ ok: true, state: 'signed-out' })
    h.port.failWrites = [h.port.writes + 1]
    expect(await h.service.signInAgain({ accountId: a, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'persist-failed' })
    expect(await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: 's1' })).toMatchObject({ ok: false, code: 'sign-in-changed' })
    // No review is offered on it meanwhile either.
    await h.service.setReviewerDefault({ providerId: 'codex', accountId: a })
    expect(h.service.reviewReady('codex')).toBe(false)
    // A check that records clears it.
    expect(await h.service.refreshStatus({ accountId: a })).toEqual({ ok: true, state: 'signed-in' })
    expect(h.service.reviewReady('codex')).toBe(true)
    expect((await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: 's2' })).ok).toBe(true)
  })

  it('a second click while one runs is refused as busy', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const first = h.service.signInAgain({ accountId: a, method: 'browser' }, 1)
    expect(await h.service.signInAgain({ accountId: a, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'busy' })
    expect((await first).ok).toBe(true)
  })
})

describe('Check sign-in is single-flight per account (WP1.10; WP2 commit 6g)', () => {
  /** A harness whose `login status` can be held open; otherwise it answers
   *  from the fake CLI's own sign-in record. */
  async function gated() {
    const ctl = { hold: false, release: () => {} }
    const gate = new Promise<void>((r) => { ctl.release = r })
    let signedIn: Map<string, unknown> | undefined
    const h = await harness({
      script: {
        'login status': async (r) => {
          if (ctl.hold) await gate
          return signedIn?.has(r.home.toLowerCase())
            ? { exitCode: 0, stderr: 'Logged in using ChatGPT\n' }
            : { exitCode: 1, stderr: 'Not logged in\n' }
        },
      },
    })
    signedIn = h.signedIn
    return { h, ctl, statusRuns: () => h.args().filter((x) => x === 'login status').length }
  }
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

  it('checks asked for while one runs join it: one CLI run, one lease, one answer; a later check runs again', async () => {
    const { h, ctl, statusRuns } = await gated()
    const a = await addCodexAccount(h)
    const before = statusRuns()
    ctl.hold = true
    const p1 = h.service.refreshStatus({ accountId: a })
    const p2 = h.service.refreshStatus({ accountId: a })
    const p3 = h.service.refreshStatus({ accountId: a })
    await settle()
    expect(statusRuns() - before).toBe(1)
    expect(h.leases.describe(a).operation).toBe(1)
    ctl.release()
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1).toEqual({ ok: true, state: 'signed-in' })
    expect(r2).toBe(r1)
    expect(r3).toBe(r1)
    expect(h.leases.describe(a).operation).toBe(0)
    ctl.hold = false
    expect(await h.service.refreshStatus({ accountId: a })).toEqual({ ok: true, state: 'signed-in' })
    expect(statusRuns() - before).toBe(2)
  })

  it('another account checks on its own, alongside', async () => {
    const { h, ctl, statusRuns } = await gated()
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    const before = statusRuns()
    ctl.hold = true
    const pa = h.service.refreshStatus({ accountId: a })
    const pb = h.service.refreshStatus({ accountId: b })
    await settle()
    expect(statusRuns() - before).toBe(2)
    ctl.release()
    expect(await pa).toEqual({ ok: true, state: 'signed-in' })
    expect(await pb).toEqual({ ok: true, state: 'signed-in' })
  })
})

describe('a status check that rejects frees its single-flight entry (WP1.10; WP2 commit 6g)', () => {
  it('the next check runs a fresh CLI call instead of joining the rejected one', async () => {
    const h = await harness()
    const a = await addCodexAccount(h)
    const statusRuns = () => h.args().filter((x) => x === 'login status').length
    const svc = h.service as unknown as { runStatusCheck: (i: { accountId: string }) => Promise<unknown> }
    svc.runStatusCheck = async () => { throw new Error('boom') }
    await expect(h.service.refreshStatus({ accountId: a })).rejects.toThrow('boom')
    delete (svc as { runStatusCheck?: unknown }).runStatusCheck // back to the class method
    const before = statusRuns()
    expect(await h.service.refreshStatus({ accountId: a })).toEqual({ ok: true, state: 'signed-in' })
    expect(statusRuns() - before).toBe(1)
  })
})
