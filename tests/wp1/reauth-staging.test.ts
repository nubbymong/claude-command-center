// WP1.52 (design 9.2, 5.3, 5.4, 11, 13): managed re-authentication is staged.
// Signing in again while signed in runs into a NEW, journalled replacement
// realm and is verified there while the old realm stays in use. Only then is
// the account switched to it, atomically: a reliable subject must match, a
// reliable mismatch becomes a separate account, and with no reliable subject
// the user's own answer decides. The old realm is retired, or kept visible in
// recovery; a failure or cancel before the switch leaves the old realm active.
//
// The registry's transition table first (documents in, documents out), then
// the accounts service on the fake CLI harness. PURE: no process, no file.
import { describe, it, expect } from 'vitest'
import {
  emptyRegistry, createIdentity, beginAccountSetup, commitAccountSetup, checkRegistryInvariants, parseRegistryDoc,
  beginAccountReauth, rebindAccountRealm, releaseReauthAsSetup, settleSupersededRealm, decideReauth, realmOperable,
  unsettledSupersededRealms, recordAuthCheck, setAccountLifecycle, findAccount, findRealm, REGISTRY_SCHEMA_VERSION,
  reconcileLegacyAccounts, ID_PREFIX, reconcileAccountSignIn,
} from '../../src/shared/providers'
import type { ProviderRegistryDoc } from '../../src/shared/providers'
import type { ProviderPackage } from '../../src/main/providers/core'
import { harness, addCodexAccount, managedHome, EXT_HOME, KEY } from './accounts-harness'

const hex = (n: number) => n.toString(16).padStart(24, '0')
const idn = (n: number) => `idn-${hex(n)}`
const acct = (n: number) => `acct-${hex(n)}`
const realm = (n: number) => `realm-${hex(n)}`

function ok(r: { ok: true; doc: ProviderRegistryDoc } | { ok: false; code: string; message: string }): ProviderRegistryDoc {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`)
  return r.doc
}

/** One committed managed Codex account (acct 1, realm 1), signed in. */
function oneAccount(over: { subject?: string; authority?: string; method?: 'browser' | 'apiKey' } = {}): ProviderRegistryDoc {
  let doc = ok(createIdentity(emptyRegistry(), { id: idn(1), friendlyName: 'Work', colourKey: 'indigo' }, 10))
  doc = ok(beginAccountSetup(doc, { accountId: acct(1), realmId: realm(1), providerId: 'codex', method: over.method ?? 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${realm(1)}` }, 11))
  return ok(commitAccountSetup(doc, acct(1), {
    identityId: idn(1), authMethod: over.method ?? 'browser', lastKnownAuthState: 'signed-in',
    identityAssurance: over.subject ? 'verified-subject' : 'user-asserted',
    ...(over.subject ? { providerSubject: over.subject, providerAuthorityId: over.authority ?? 'auth.example' } : {}),
  }, 12))
}

/** The account with a staged sign in again (acct 9 reserved, realm 2). */
function staged(doc = oneAccount()): ProviderRegistryDoc {
  return ok(beginAccountReauth(doc, { accountId: acct(9), realmId: realm(2), replacesAccountId: acct(1), method: 'browser' }, 20))
}

describe('beginning a staged sign in again (WP1.52)', () => {
  it('reserves a replacement realm beside the old one, which stays the account\'s and in use', () => {
    const doc = staged()
    expect(doc.journals).toEqual([expect.objectContaining({ accountId: acct(9), realmId: realm(2), providerId: 'codex', replacesAccountId: acct(1), state: 'pending' })])
    expect(findRealm(doc, realm(2))).toMatchObject({ lifecycle: 'pending', ownership: 'conductor-managed', pathRef: `managed:${realm(2)}`, ownerProviderAccountId: acct(9) })
    expect(findAccount(doc, acct(1))).toMatchObject({ authRealmId: realm(1), lifecycle: 'active', operationalState: 'ready' })
    expect(findRealm(doc, realm(1))!.lifecycle).toBe('active')
    expect(checkRegistryInvariants(doc)).toEqual([])
  })

  it('round-trips through the document parser at the current schema', () => {
    const doc = staged()
    // Schema 4 added the staged sign in again: an older build must read a
    // document holding one as newer, never drop it on its next write.
    expect(REGISTRY_SCHEMA_VERSION).toBe(4)
    expect(doc.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION)
    expect(parseRegistryDoc(JSON.parse(JSON.stringify(doc)))).toEqual({ ok: true, doc })
  })

  it('refuses a second one for the same account, an archived, missing or blocked account, and a Claude profile', () => {
    const doc = staged()
    expect(beginAccountReauth(doc, { accountId: acct(8), realmId: realm(3), replacesAccountId: acct(1), method: 'browser' }, 21)).toMatchObject({ ok: false, code: 'duplicate' })
    expect(beginAccountReauth(oneAccount(), { accountId: acct(8), realmId: realm(3), replacesAccountId: acct(5), method: 'browser' }, 21)).toMatchObject({ ok: false, code: 'not-found' })
    let archived = ok(setAccountLifecycle(oneAccount(), acct(1), 'inactive', { consumers: 0 }, 13))
    archived = ok(setAccountLifecycle(archived, acct(1), 'archived', { consumers: 0 }, 14))
    expect(beginAccountReauth(archived, { accountId: acct(8), realmId: realm(3), replacesAccountId: acct(1), method: 'browser' }, 21)).toMatchObject({ ok: false, code: 'lifecycle' })
    const blocked = ok(recordAuthCheck(oneAccount(), acct(1), { state: 'signed-in', observedCredential: 'api-key' }, 13))
    expect(findAccount(blocked, acct(1))!.operationalState).toBe('blocked')
    expect(beginAccountReauth(blocked, { accountId: acct(8), realmId: realm(3), replacesAccountId: acct(1), method: 'browser' }, 21)).toMatchObject({ ok: false, code: 'lifecycle' })
    const rec = reconcileLegacyAccounts(emptyRegistry(), 'claude', [{
      legacyId: 'profile-work', friendlyName: 'Work', colourKey: 'rose', lifecycle: 'active', isDefault: true, providerLabel: 'nick@example.com',
      realm: { kind: 'claude-config-home', ownership: 'conductor-managed', pathRef: 'claude-profile:profile-work' }, authMethod: 'browser', identityAssurance: 'user-asserted',
    }], { now: 5, deterministicId: (kind, seed) => `${ID_PREFIX[kind]}-${seed === 'profile-work' ? hex(40) : hex(41)}` })
    if (!rec.ok) throw new Error(rec.problems.join('; '))
    const claude = rec.doc.accounts[0]
    expect(beginAccountReauth(rec.doc, { accountId: acct(8), realmId: realm(3), replacesAccountId: claude.id, method: 'browser' }, 21)).toMatchObject({ ok: false, code: 'legacy-owned' })
  })

  it('is never committed as a new account: it ends in the switch, or is released as a plain setup first', () => {
    const doc = ok(createIdentity(staged(), { id: idn(2), colourKey: 'rose' }, 21))
    expect(commitAccountSetup(doc, acct(9), { identityId: idn(2), authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: 'user-asserted' }, 22)).toMatchObject({ ok: false, code: 'lifecycle' })
  })

  it('a schema 3 document (no staged sign-in again) still reads, as the current schema', () => {
    const v3 = { ...JSON.parse(JSON.stringify(oneAccount())), schemaVersion: 3 }
    expect(parseRegistryDoc(v3)).toEqual({ ok: true, doc: oneAccount() })
  })

  it('an account with a staged sign in again is not archived while it is listed', () => {
    let doc = staged()
    doc = ok(setAccountLifecycle(doc, acct(1), 'inactive', { consumers: 0 }, 21))
    expect(setAccountLifecycle(doc, acct(1), 'archived', { consumers: 0 }, 22)).toMatchObject({ ok: false, code: 'lifecycle' })
  })
})

describe('deciding who signed in (design 9.2, WP1.52, WP1.53)', () => {
  const pair = (s: string, a = 'auth.example') => ({ providerSubject: s, providerAuthorityId: a })

  it('a reliable subject equal to the recorded one rebinds, whatever the answer', () => {
    const doc = staged(oneAccount({ subject: 'user-1' }))
    expect(decideReauth(doc, acct(9), pair('user-1'), true)).toEqual({ ok: true, decision: 'rebind' })
    expect(decideReauth(doc, acct(9), pair('user-1'), false)).toEqual({ ok: true, decision: 'rebind' })
  })

  it('a reliable different subject, or the same subject under another authority, is a separate account', () => {
    const doc = staged(oneAccount({ subject: 'user-1' }))
    expect(decideReauth(doc, acct(9), pair('user-2'), true)).toEqual({ ok: true, decision: 'separate' })
    expect(decideReauth(doc, acct(9), pair('user-1', 'tenant.example'), true)).toEqual({ ok: true, decision: 'separate' })
  })

  it('a report that cannot be read against a recorded subject is never taken as the same person', () => {
    const doc = staged(oneAccount({ subject: 'user-1' }))
    expect(decideReauth(doc, acct(9), { providerSubject: 'user-1' }, true)).toEqual({ ok: true, decision: 'separate' })
    expect(decideReauth(doc, acct(9), pair('user-1\u0007'), true)).toEqual({ ok: true, decision: 'separate' })
  })

  it('with no reliable subject to compare, the user\'s answer decides (Codex today: none is exposed)', () => {
    for (const doc of [staged(), staged(oneAccount({ subject: 'user-1' }))]) {
      expect(decideReauth(doc, acct(9), {}, true)).toEqual({ ok: true, decision: 'rebind' })
      expect(decideReauth(doc, acct(9), {}, false)).toEqual({ ok: true, decision: 'separate' })
    }
    // A reliable subject where none is on record cannot be compared either.
    expect(decideReauth(staged(), acct(9), pair('user-7'), true)).toEqual({ ok: true, decision: 'rebind' })
    expect(decideReauth(staged(), acct(9), pair('user-7'), false)).toEqual({ ok: true, decision: 'separate' })
  })

  it('a subject another live account already holds is a conflict: neither rebound nor a second account', () => {
    let doc = oneAccount({ subject: 'user-1' })
    doc = ok(createIdentity(doc, { id: idn(2), colourKey: 'rose' }, 13))
    doc = ok(beginAccountSetup(doc, { accountId: acct(2), realmId: realm(5), providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${realm(5)}` }, 14))
    doc = ok(commitAccountSetup(doc, acct(2), { identityId: idn(2), authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: 'verified-subject', providerSubject: 'user-2', providerAuthorityId: 'auth.example' }, 15))
    doc = staged(doc)
    expect(decideReauth(doc, acct(9), pair('user-2'), true)).toEqual({ ok: true, decision: 'conflict' })
  })

  it('asks only about a staged sign in again', () => {
    let doc = oneAccount()
    doc = ok(beginAccountSetup(doc, { accountId: acct(7), realmId: realm(7), providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${realm(7)}` }, 20))
    expect(decideReauth(doc, acct(7), {}, true)).toMatchObject({ ok: false, code: 'not-found' })
  })
})

describe('the switch (design 9.2: after the decision, atomically)', () => {
  it('moves the account to the replacement realm and retires nothing yet: the old realm is retiring and the account needs attention', () => {
    const doc = ok(rebindAccountRealm(staged(), acct(9), { state: 'signed-in', observedCredential: 'account' }, 30))
    const a = findAccount(doc, acct(1))!
    expect(a).toMatchObject({ authRealmId: realm(2), lifecycle: 'active', lastKnownAuthState: 'signed-in', lastAuthenticatedAt: 30, operationalState: 'attention', identityAssurance: 'user-asserted', identityId: idn(1), isProviderDefault: true })
    expect(findRealm(doc, realm(2))).toMatchObject({ lifecycle: 'active', ownerProviderAccountId: acct(1), lastValidatedAt: 30 })
    expect(findRealm(doc, realm(1))).toMatchObject({ lifecycle: 'retiring', ownerProviderAccountId: acct(1) })
    expect(doc.journals).toEqual([])
    expect(doc.accounts.map((x) => x.id)).toEqual([acct(1)])
    expect(unsettledSupersededRealms(doc, acct(1)).map((r) => r.id)).toEqual([realm(1)])
    expect(checkRegistryInvariants(doc)).toEqual([])
    expect(parseRegistryDoc(JSON.parse(JSON.stringify(doc)))).toEqual({ ok: true, doc })
  })

  it('keeps a matched verified subject, and adopts a reliable one where none was recorded', () => {
    const kept = ok(rebindAccountRealm(staged(oneAccount({ subject: 'user-1' })), acct(9), { state: 'signed-in', providerSubject: 'user-1', providerAuthorityId: 'auth.example' }, 30))
    expect(findAccount(kept, acct(1))).toMatchObject({ providerSubject: 'user-1', identityAssurance: 'verified-subject' })
    const adopted = ok(rebindAccountRealm(staged(), acct(9), { state: 'signed-in', providerSubject: 'user-7', providerAuthorityId: 'auth.example' }, 30))
    expect(findAccount(adopted, acct(1))).toMatchObject({ providerSubject: 'user-7', providerAuthorityId: 'auth.example', identityAssurance: 'user-asserted' })
  })

  it('refuses a mismatch, a conflict and anything but a verified sign-in, changing nothing', () => {
    const doc = staged(oneAccount({ subject: 'user-1' }))
    expect(rebindAccountRealm(doc, acct(9), { state: 'signed-in', providerSubject: 'user-2', providerAuthorityId: 'auth.example' }, 30)).toMatchObject({ ok: false, code: 'subject-conflict' })
    expect(rebindAccountRealm(doc, acct(9), { state: 'signed-in', providerSubject: 'user-1' }, 30)).toMatchObject({ ok: false, code: 'subject-conflict' })
    expect(rebindAccountRealm(doc, acct(9), { state: 'signed-out' }, 30)).toMatchObject({ ok: false, code: 'invalid-value' })
    expect(rebindAccountRealm(doc, acct(1), { state: 'signed-in' }, 30)).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('a replacement signed in with another kind of credential blocks the account, as a check would', () => {
    const doc = ok(rebindAccountRealm(staged(), acct(9), { state: 'signed-in', observedCredential: 'api-key' }, 30))
    expect(findAccount(doc, acct(1))).toMatchObject({ operationalState: 'blocked', authMethod: 'browser', authRealmId: realm(2) })
  })
})

describe('a separate account, and the old realm afterwards', () => {
  it('a mismatch releases the staged setup as a plain one: a new account, the old one untouched', () => {
    const before = staged(oneAccount({ subject: 'user-1' }))
    const doc = ok(releaseReauthAsSetup(before, acct(9), 31))
    expect(doc.journals).toEqual([expect.objectContaining({ accountId: acct(9), realmId: realm(2), state: 'pending' })])
    expect(doc.journals[0].replacesAccountId).toBeUndefined()
    expect(doc.accounts).toEqual(before.accounts)
    const committed = ok(commitAccountSetup(ok(createIdentity(doc, { id: idn(2), colourKey: 'rose' }, 32)), acct(9), { identityId: idn(2), authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: 'verified-subject', providerSubject: 'user-2', providerAuthorityId: 'auth.example' }, 33))
    expect(findAccount(committed, acct(9))).toMatchObject({ authRealmId: realm(2), isProviderDefault: false })
    expect(findAccount(committed, acct(1))).toMatchObject({ authRealmId: realm(1), providerSubject: 'user-1', operationalState: 'ready' })
    expect(checkRegistryInvariants(committed)).toEqual([])
  })

  it('retired: the account is ready again; recovery: it keeps needing attention, and a check does not hide it', () => {
    const switched = ok(rebindAccountRealm(staged(), acct(9), { state: 'signed-in' }, 30))
    const retired = ok(settleSupersededRealm(switched, realm(1), 'retired', 40))
    expect(findRealm(retired, realm(1))!.lifecycle).toBe('retired')
    expect(findAccount(retired, acct(1))!.operationalState).toBe('ready')
    expect(unsettledSupersededRealms(retired, acct(1))).toEqual([])
    expect(checkRegistryInvariants(retired)).toEqual([])
    const kept = ok(settleSupersededRealm(switched, realm(1), 'recovery', 40))
    expect(findRealm(kept, realm(1))!.lifecycle).toBe('recovery')
    expect(findAccount(kept, acct(1))!.operationalState).toBe('attention')
    const checked = ok(recordAuthCheck(kept, acct(1), { state: 'signed-in' }, 41))
    expect(findAccount(checked, acct(1))!.operationalState).toBe('attention')
    expect(findAccount(ok(reconcileAccountSignIn(kept, acct(1), { state: 'signed-in' }, 41)), acct(1))!.operationalState).toBe('attention')
    // Recovery can still be retired later.
    expect(findRealm(ok(settleSupersededRealm(kept, realm(1), 'retired', 42)), realm(1))!.lifecycle).toBe('retired')
    // Not archived while its old sign-in is still there.
    const inactive = ok(setAccountLifecycle(kept, acct(1), 'inactive', { consumers: 0 }, 43))
    expect(setAccountLifecycle(inactive, acct(1), 'archived', { consumers: 0 }, 44)).toMatchObject({ ok: false, code: 'lifecycle' })
  })

  it('only a superseded realm is settled, never an account\'s own', () => {
    expect(settleSupersededRealm(oneAccount(), realm(1), 'retired', 40)).toMatchObject({ ok: false, code: 'lifecycle' })
    // Even in a document that (wrongly) says its own realm is being retired.
    const odd = JSON.parse(JSON.stringify(oneAccount())) as ProviderRegistryDoc
    odd.realms[0].lifecycle = 'retiring'
    expect(settleSupersededRealm(odd, realm(1), 'retired', 40)).toMatchObject({ ok: false, code: 'lifecycle' })
  })

  it('an operable realm: pending or active, or a managed one being retired; never a retired one', () => {
    const switched = ok(rebindAccountRealm(staged(), acct(9), { state: 'signed-in' }, 30))
    expect(realmOperable(findRealm(switched, realm(1)))).toBe(true)
    expect(realmOperable(findRealm(switched, realm(2)))).toBe(true)
    expect(realmOperable(findRealm(ok(settleSupersededRealm(switched, realm(1), 'recovery', 40)), realm(1)))).toBe(true)
    expect(realmOperable(findRealm(ok(settleSupersededRealm(switched, realm(1), 'retired', 40)), realm(1)))).toBe(false)
    expect(realmOperable(undefined)).toBe(false)
  })

  it('the invariants refuse a current realm being retired and a staged setup of an account that is gone', () => {
    const d1 = JSON.parse(JSON.stringify(oneAccount())) as ProviderRegistryDoc
    d1.realms[0].lifecycle = 'retiring'
    expect(checkRegistryInvariants(d1).join('\n')).toMatch(/being retired/)
    const d2 = JSON.parse(JSON.stringify(staged())) as ProviderRegistryDoc
    d2.journals[0].replacesAccountId = acct(5)
    expect(checkRegistryInvariants(d2).join('\n')).toMatch(/replaces/)
    const d3 = JSON.parse(JSON.stringify(ok(rebindAccountRealm(staged(), acct(9), { state: 'signed-in' }, 30)))) as ProviderRegistryDoc
    d3.realms.find((r) => r.id === realm(1))!.lifecycle = 'active'
    expect(checkRegistryInvariants(d3).join('\n')).toMatch(/is not its realm/)
  })
})

// ---------------------------------------------------------------------------
// Through the accounts service: the real Codex package on the fake CLI, an
// in-memory folder tree and an in-memory registry (./accounts-harness).
// ---------------------------------------------------------------------------

type Auth = NonNullable<ProviderPackage['auth']>

/** A provider that reports a subject (Codex and Claude report none today):
 *  whoever signs in to a realm is `next.subject`, and its status says so. */
function subjectProvider() {
  const held = new Map<string, string>()
  const next = { subject: 'user-1', authority: 'auth.example' }
  const report = (realmId: string) => {
    const v = held.get(realmId)
    if (!v) return {}
    const [authority, subject] = v.split('|')
    return { providerSubject: subject, providerAuthorityId: authority }
  }
  const wrap = (auth: Auth): Auth => ({
    login: async (realm, method, input) => {
      const r = await auth.login(realm, method, input)
      if (r.state === 'signed-in') held.set(realm.authRealmId, `${next.authority}|${next.subject}`)
      return r.state === 'signed-in' ? { ...r, ...report(realm.authRealmId) } : r
    },
    status: async (realm, opts) => {
      const r = await auth.status(realm, opts)
      if (r.state !== 'signed-in') held.delete(realm.authRealmId)
      return r.state === 'signed-in' ? { ...r, ...report(realm.authRealmId) } : r
    },
    logout: async (realm, opts) => {
      const r = await auth.logout(realm, opts)
      if (r.ok) held.delete(realm.authRealmId)
      return r
    },
  })
  return { wrap, next }
}

type H = Awaited<ReturnType<typeof harness>>
const realmIdOf = (h: H, a: string) => h.doc().accounts.find((x) => x.id === a)!.authRealmId
const homeOf = (realmId: string) => managedHome(realmId).toLowerCase()
const NL = String.fromCharCode(10)

async function withExternalHome(h: H) {
  h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
  const r = await h.service.adoptExternalDefault({ providerId: 'codex' })
  if (!r.ok) throw new Error(r.code)
  return r.accountId
}

describe('signing in again while signed in, through the service (WP1.52)', () => {
  it('runs in a new realm, switches the same account to it, signs the old one out and checks the new one again', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const before = h.doc()
    const oldRealm = realmIdOf(h, a)
    const runsBefore = h.runs.length
    const lines: string[] = []
    expect(await h.service.signInAgain({ accountId: a, method: 'browser' }, 1, (t) => lines.push(t))).toEqual({ ok: true, state: 'signed-in' })
    expect(lines.join('')).toContain('Starting local login server')
    const newRealm = realmIdOf(h, a)
    expect(newRealm).not.toBe(oldRealm)
    const where = (home: string) => (home.toLowerCase() === homeOf(oldRealm) ? 'old' : home.toLowerCase() === homeOf(newRealm) ? 'new' : home)
    const runs = h.runs.slice(runsBefore).map((r) => `${r.args} @ ${where(r.home)}`)
    // Logged in to the new realm only; the old one signed out only after the
    // switch; the new one checked again after that.
    expect(runs.filter((r) => r.startsWith('login @') || r.startsWith('logout'))).toEqual(['login @ new', 'logout @ old'])
    expect(runs.lastIndexOf('login status @ new')).toBeGreaterThan(runs.indexOf('logout @ old'))
    expect(h.signedIn.has(homeOf(oldRealm))).toBe(false)
    expect(h.signedIn.get(homeOf(newRealm))).toBe('chatgpt')
    const d = h.doc()
    // The same account: its id, identity, default -- only its realm moved.
    expect(d.accounts).toHaveLength(1)
    expect(findAccount(d, a)).toMatchObject({ identityId: findAccount(before, a)!.identityId, isProviderDefault: true, lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted' })
    expect(findRealm(d, oldRealm)).toMatchObject({ lifecycle: 'retired', ownerProviderAccountId: a })
    expect(findRealm(d, newRealm)).toMatchObject({ lifecycle: 'active', ownerProviderAccountId: a })
    expect(d.journals).toEqual([])
    // The old folder is kept, signed out, as an archived account's is.
    expect(h.folders.exists(managedHome(oldRealm))).toBe(true)
    expect(h.service.snapshot().accounts[0].oldSignInLeft).toBeUndefined()
    expect(h.service.consumersOf(a)).toEqual({ session: 0, review: 0, 'sign-in': 0, operation: 0 })
    expect((await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: 's1' })).ok).toBe(true)
  })

  it('while it runs nothing launches on the account, and its own realm is untouched until the switch', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let armed = false
    const h = await harness({ script: { login: async (r) => {
      if (armed) await held
      h.signedIn.set(r.home.toLowerCase(), 'chatgpt')
      return { exitCode: 0, stdout: 'Successfully logged in' + NL }
    } } })
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    armed = true
    const running = h.service.signInAgain({ accountId: a, method: 'browser' }, 1)
    await new Promise((r) => setTimeout(r, 0))
    expect(await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: 's-during' })).toMatchObject({ ok: false, code: 'busy' })
    expect(realmIdOf(h, a)).toBe(oldRealm)
    expect(h.signedIn.get(homeOf(oldRealm))).toBe('chatgpt')
    // The replacement is journalled and listed as this account's, and is not
    // discarded or finished under the run.
    const pending = h.service.snapshot().pendingSetups
    expect(pending).toEqual([expect.objectContaining({ replacesAccountId: a, signingIn: true })])
    expect(await h.service.abandonSetup({ accountId: pending[0].accountId })).toMatchObject({ ok: false, code: 'busy' })
    release()
    expect(await running).toEqual({ ok: true, state: 'signed-in' })
  })

  it('a sign-in that fails or is cancelled removes the replacement and leaves the account exactly as it was', async () => {
    for (const how of ['fails', 'cancelled'] as const) {
      let started!: () => void
      const running = new Promise<void>((r) => { started = r })
      let armed = false
      const h = await harness({ script: { login: (r) => {
        if (!armed) { h.signedIn.set(r.home.toLowerCase(), 'chatgpt'); return { exitCode: 0, stdout: 'Successfully logged in' + NL } }
        if (how === 'fails') return { exitCode: 1, stderr: 'Login failed' + NL }
        return new Promise((resolve) => {
          started()
          r.opts.signal?.addEventListener('abort', () => resolve({ spawnError: 'cancelled', stopped: 'cancel' }))
        })
      } } })
      const a = await addCodexAccount(h, 'A')
      const before = JSON.stringify(h.doc().accounts)
      const oldRealm = realmIdOf(h, a)
      const realmsBefore = h.doc().realms.length
      armed = true
      const run = h.service.signInAgain({ accountId: a, method: 'browser' }, 1)
      if (how === 'cancelled') { await running; expect(h.service.cancelSignIn({ accountId: a }, 1)).toEqual({ ok: true }) }
      expect((await run).ok, how).toBe(false)
      const d = h.doc()
      expect(JSON.stringify(d.accounts), how).toBe(before)
      expect(d.journals, how).toEqual([])
      expect(d.realms, how).toHaveLength(realmsBefore)
      expect(h.signedIn.get(homeOf(oldRealm)), how).toBe('chatgpt')
      expect(h.args().filter((x) => x === 'logout'), how).toEqual([])
      // The replacement's folder is gone; only the account's own remains.
      expect([...h.folders.dirs].filter((x) => x.startsWith('c:\\res\\codex-realms\\')), how).toEqual([homeOf(oldRealm)])
    }
  })

  it('an old sign-in that cannot be removed stays in recovery, visible, until a check removes it', async () => {
    let refuse = true
    const h = await harness({ script: { logout: (r) => {
      if (refuse) return { exitCode: 1, stderr: 'could not log out' + NL }
      h.signedIn.delete(r.home.toLowerCase())
      return { exitCode: 0, stdout: 'Successfully logged out' + NL }
    } } })
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    expect(await h.service.signInAgain({ accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('recovery')
    expect(findAccount(h.doc(), a)).toMatchObject({ operationalState: 'attention', lastKnownAuthState: 'signed-in' })
    expect(h.service.snapshot().accounts[0]).toMatchObject({ oldSignInLeft: true, operationalState: 'attention' })
    // Still usable: its own sign-in is the new one.
    expect((await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: 's1' })).ok).toBe(true)
    h.service.releaseLaunch('session', 's1')
    // Not archived while it is there.
    expect((await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })).ok).toBe(true)
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(findAccount(h.doc(), a)!.lifecycle).toBe('inactive')
    // Check sign-in retries it.
    refuse = false
    expect(await h.service.refreshStatus({ accountId: a })).toEqual({ ok: true, state: 'signed-in' })
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('retired')
    expect(h.signedIn.has(homeOf(oldRealm))).toBe(false)
    expect(findAccount(h.doc(), a)!.operationalState).toBe('ready')
    expect(h.service.snapshot().accounts[0].oldSignInLeft).toBeUndefined()
  })

  it('archiving removes an old sign-in first, and archives once it is gone', async () => {
    let refuse = true
    const h = await harness({ script: { logout: (r) => {
      if (refuse && !r.home.toLowerCase().endsWith(realmIdOf(h, a).toLowerCase())) return { exitCode: 1, stderr: 'could not log out' + NL }
      h.signedIn.delete(r.home.toLowerCase())
      return { exitCode: 0, stdout: 'Successfully logged out' + NL }
    } } })
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    expect(await h.service.signInAgain({ accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('recovery')
    expect((await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })).ok).toBe(true)
    refuse = false
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })).toEqual({ ok: true })
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('retired')
    expect(h.signedIn.size).toBe(0)
  })

  it('a replacement the old sign-out took with it is checked again and said so: signed out, needing attention', async () => {
    const h = await harness({ script: { logout: () => { h.signedIn.clear(); return { exitCode: 0, stdout: 'Successfully logged out' + NL } } } })
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    expect(await h.service.signInAgain({ accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-out' })
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('retired')
    expect(findAccount(h.doc(), a)).toMatchObject({ lastKnownAuthState: 'signed-out', operationalState: 'attention' })
  })

  it('an interrupted run recovers: before the switch it is listed and discarded, never named; after it, a check finishes the old realm', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    // The app closed after the replacement signed in, before the switch.
    const stagedId = `acct-${'e'.repeat(32)}`
    const replacement = `realm-${'e'.repeat(32)}`
    expect((await h.store.mutate((d, t) => beginAccountReauth(d, { accountId: stagedId, realmId: replacement, replacesAccountId: a, method: 'browser' }, t))).ok).toBe(true)
    expect((await h.codex.realmFolders!.prepare({ authRealmId: replacement })).ok).toBe(true)
    h.signedIn.set(homeOf(replacement), 'chatgpt')
    const again = await harness({ port: h.port, folders: h.folders })
    for (const [home, v] of h.signedIn) again.signedIn.set(home, v)
    // Listed as this account's, not a new one; the account is as it was.
    expect(again.service.snapshot().pendingSetups).toEqual([expect.objectContaining({ accountId: stagedId, replacesAccountId: a, signingIn: false })])
    expect(realmIdOf(again, a)).toBe(oldRealm)
    expect((await again.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: 's1' })).ok).toBe(true)
    again.service.releaseLaunch('session', 's1')
    expect(await again.service.completeSetup({ accountId: stagedId, identity: { mode: 'new', colourKey: 'rose' } })).toMatchObject({ ok: false, code: 'unsupported' })
    // Discard signs the replacement out and removes it.
    expect(await again.service.abandonSetup({ accountId: stagedId })).toEqual({ ok: true })
    expect(again.signedIn.has(homeOf(replacement))).toBe(false)
    expect(again.folders.exists(managedHome(replacement))).toBe(false)
    expect(again.doc().journals).toEqual([])
    expect(again.signedIn.get(homeOf(oldRealm))).toBe('chatgpt')

    // The app closed after the switch, before the old sign-in was removed.
    const b = await addCodexAccount(again, 'B')
    const bOld = realmIdOf(again, b)
    const bNew = `realm-${'f'.repeat(32)}`
    const bStaged = `acct-${'f'.repeat(32)}`
    expect((await again.store.mutate((d, t) => beginAccountReauth(d, { accountId: bStaged, realmId: bNew, replacesAccountId: b, method: 'browser' }, t))).ok).toBe(true)
    expect((await again.codex.realmFolders!.prepare({ authRealmId: bNew })).ok).toBe(true)
    again.signedIn.set(homeOf(bNew), 'chatgpt')
    expect((await again.store.mutate((d, t) => rebindAccountRealm(d, bStaged, { state: 'signed-in' }, t))).ok).toBe(true)
    const third = await harness({ port: again.port, folders: again.folders })
    for (const [home, v] of again.signedIn) third.signedIn.set(home, v)
    expect(third.service.snapshot().accounts.find((x) => x.id === b)).toMatchObject({ oldSignInLeft: true, operationalState: 'attention' })
    expect(await third.service.refreshStatus({ accountId: b })).toEqual({ ok: true, state: 'signed-in' })
    expect(findRealm(third.doc(), bOld)!.lifecycle).toBe('retired')
    expect(third.signedIn.has(homeOf(bOld))).toBe(false)
    expect(findAccount(third.doc(), b)!.operationalState).toBe('ready')
  })

  it('a staged sign-in the app left behind is discarded first when the account signs in again', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const stale = `realm-${'d'.repeat(32)}`
    expect((await h.store.mutate((d, t) => beginAccountReauth(d, { accountId: `acct-${'d'.repeat(32)}`, realmId: stale, replacesAccountId: a, method: 'browser' }, t))).ok).toBe(true)
    expect((await h.codex.realmFolders!.prepare({ authRealmId: stale })).ok).toBe(true)
    expect(await h.service.signInAgain({ accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    expect(h.folders.exists(managedHome(stale))).toBe(false)
    expect(h.doc().journals).toEqual([])
  })

  it('an API key signs in again the same way: the key reaches only the new realm\'s login', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A', 'apiKey')
    const oldRealm = realmIdOf(h, a)
    const issued = h.service.issueSecretHandle({ accountId: a }, 1)
    if (!issued.ok) throw new Error(issued.code)
    h.service.depositSecret(issued.handle, 1, KEY)
    expect(await h.service.signInAgain({ accountId: a, method: 'apiKey', secretHandle: issued.handle }, 1)).toEqual({ ok: true, state: 'signed-in' })
    const keyed = h.runs.filter((r) => r.args === 'login --with-api-key').map((r) => r.home.toLowerCase())
    expect(keyed).toEqual([homeOf(oldRealm), homeOf(realmIdOf(h, a))])
    expect(findAccount(h.doc(), a)).toMatchObject({ authMethod: 'apiKey', operationalState: 'ready' })
  })

  it('this computer\'s own Codex sign-in is never signed in again here (WP2: add a managed account instead)', async () => {
    const h = await harness()
    const ext = await withExternalHome(h)
    expect(await h.service.signInAgain({ accountId: ext, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'unsupported' })
    expect(h.doc().journals).toEqual([])
  })
})

describe('a provider that reports a subject (WP1.52, WP1.53)', () => {
  it('records it at setup, and keeps it when the same account signs in again', async () => {
    const sp = subjectProvider()
    const h = await harness({ authWrap: sp.wrap })
    const a = await addCodexAccount(h, 'A')
    expect(findAccount(h.doc(), a)).toMatchObject({ providerSubject: 'user-1', providerAuthorityId: 'auth.example' })
    const oldRealm = realmIdOf(h, a)
    expect(await h.service.signInAgain({ accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    expect(realmIdOf(h, a)).not.toBe(oldRealm)
    expect(findAccount(h.doc(), a)).toMatchObject({ providerSubject: 'user-1', operationalState: 'ready' })
  })

  it('someone else becomes a separate account for the user to name; this one keeps its own sign-in, untouched', async () => {
    const sp = subjectProvider()
    const h = await harness({ authWrap: sp.wrap })
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    const before = JSON.stringify(findAccount(h.doc(), a))
    sp.next.subject = 'user-2'
    const r = await h.service.signInAgain({ accountId: a, method: 'browser' }, 1)
    expect(r).toMatchObject({ ok: true, state: 'signed-in', separateAccountId: expect.stringMatching(/^acct-/) })
    const sep = (r as { separateAccountId: string }).separateAccountId
    expect(JSON.stringify(findAccount(h.doc(), a))).toBe(before)
    expect(h.signedIn.get(homeOf(oldRealm))).toBe('chatgpt')
    expect(h.args().filter((x) => x === 'logout')).toEqual([])
    // A plain unfinished setup now, named like any new account.
    const pending = h.service.snapshot().pendingSetups
    expect(pending).toEqual([expect.objectContaining({ accountId: sep, state: 'credentials-written', signingIn: false })])
    expect(pending[0].replacesAccountId).toBeUndefined()
    expect(await h.service.completeSetup({ accountId: sep, identity: { mode: 'new', friendlyName: 'Someone else', colourKey: 'rose' } })).toEqual({ ok: true, accountId: sep })
    expect(findAccount(h.doc(), sep)).toMatchObject({ providerSubject: 'user-2', lifecycle: 'active', isProviderDefault: false })
    expect(findAccount(h.doc(), a)).toMatchObject({ providerSubject: 'user-1', authRealmId: oldRealm })
  })

  it('a sign-in that another account here already is: refused, removed, nothing changed', async () => {
    const sp = subjectProvider()
    const h = await harness({ authWrap: sp.wrap })
    const a = await addCodexAccount(h, 'A')
    sp.next.subject = 'user-2'
    const b = await addCodexAccount(h, 'B')
    expect(findAccount(h.doc(), b)!.providerSubject).toBe('user-2')
    const before = JSON.stringify(h.doc().accounts)
    const realms = h.doc().realms.length
    const r = await h.service.signInAgain({ accountId: a, method: 'browser' }, 1)
    expect(r).toMatchObject({ ok: false, code: 'subject-conflict' })
    // Said as it is: that sign-in is another account here already.
    expect((r as { message: string }).message).toMatch(/already another account/)
    expect(JSON.stringify(h.doc().accounts)).toBe(before)
    expect(h.doc().realms).toHaveLength(realms)
    expect(h.doc().journals).toEqual([])
  })
})
