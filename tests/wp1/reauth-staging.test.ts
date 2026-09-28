// WP1.52 (design 9.2, 5.3, 5.4, 11, 13): managed re-authentication is staged.
// Signing in again while signed in runs into a NEW, journalled replacement
// realm and is verified there while the old realm stays in use. Only then is
// the account switched to it, atomically: a reliable subject must match, a
// reliable mismatch becomes a separate account, and with no reliable subject
// the user's own answer decides. The old realm is retired, or kept visible in
// recovery; a failure or cancel before the switch leaves the old realm active.
//
// This part is the registry's transition table. PURE: documents in, documents
// out; no process, no file.
import { describe, it, expect } from 'vitest'
import {
  emptyRegistry, createIdentity, beginAccountSetup, commitAccountSetup, checkRegistryInvariants, parseRegistryDoc,
  beginAccountReauth, rebindAccountRealm, releaseReauthAsSetup, settleSupersededRealm, decideReauth, realmOperable,
  unsettledSupersededRealms, recordAuthCheck, setAccountLifecycle, findAccount, findRealm, REGISTRY_SCHEMA_VERSION,
  reconcileLegacyAccounts, ID_PREFIX, reconcileAccountSignIn,
} from '../../src/shared/providers'
import type { ProviderRegistryDoc } from '../../src/shared/providers'

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
