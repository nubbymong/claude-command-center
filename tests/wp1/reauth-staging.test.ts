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
  reconcileLegacyAccounts, ID_PREFIX, reconcileAccountSignIn, markSetupDiscarding, markSetupCredentialsWritten,
} from '../../src/shared/providers'
import type { ProviderRegistryDoc } from '../../src/shared/providers'
import type { ProviderPackage } from '../../src/main/providers/core'
import { harness, addCodexAccount, managedHome, EXT_HOME, KEY, MemoryPort, USER } from './accounts-harness'
import { codexCapabilities, codexWiredCapabilities, CODEX_REMOVE_MAX_ENTRIES } from '../../src/main/providers/codex'
import { claudeCapabilities } from '../../src/main/providers/claude'

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

  it('an operable realm: pending or active for anything; a managed one being retired only to check or sign out its sign-in; never a retired one', () => {
    const switched = ok(rebindAccountRealm(staged(), acct(9), { state: 'signed-in' }, 30))
    const recovery = ok(settleSupersededRealm(switched, realm(1), 'recovery', 40))
    const retired = ok(settleSupersededRealm(switched, realm(1), 'retired', 40))
    const OTHER = ['login', 'launch', 'usage', 'sessions', 'folder'] as const
    for (const use of [...OTHER, 'status', 'logout'] as const) {
      expect(realmOperable(findRealm(switched, realm(2)), use), `active ${use}`).toBe(true)
      expect(realmOperable(findRealm(staged(), realm(2)), use), `pending ${use}`).toBe(true)
      expect(realmOperable(findRealm(retired, realm(1)), use), `retired ${use}`).toBe(false)
      expect(realmOperable(undefined, use)).toBe(false)
    }
    for (const doc of [switched, recovery]) {
      const old = findRealm(doc, realm(1))
      expect(realmOperable(old, 'status')).toBe(true)
      expect(realmOperable(old, 'logout')).toBe(true)
      for (const use of OTHER) expect(realmOperable(old, use), `${old!.lifecycle} ${use}`).toBe(false)
      // Never this computer's own home, whatever it is doing.
      expect(realmOperable({ ...old!, ownership: 'external-default' }, 'status')).toBe(false)
    }
    // A history copy only compares files with an account's earlier realms:
    // any app-managed one it moved off, retired too; never this computer's
    // own home (review round 3, C1).
    for (const doc of [switched, recovery, retired]) {
      const old = findRealm(doc, realm(1))!
      expect(realmOperable(old, 'history'), old.lifecycle).toBe(true)
      expect(realmOperable({ ...old, ownership: 'external-default' }, 'history'), old.lifecycle).toBe(false)
    }
    expect(realmOperable(undefined, 'history')).toBe(false)
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

describe('a setup being discarded (review round 2, L1-1: the Discard is written ahead)', () => {
  it('is marked first, and from then on is never marked signed in, completed, switched to or released', () => {
    const doc = ok(markSetupDiscarding(staged(), acct(9), 30))
    expect(doc.journals[0].state).toBe('discarding')
    expect(parseRegistryDoc(JSON.parse(JSON.stringify(doc)))).toEqual({ ok: true, doc })
    expect(markSetupCredentialsWritten(doc, acct(9), 31)).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(rebindAccountRealm(doc, acct(9), { state: 'signed-in' }, 31)).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(releaseReauthAsSetup(doc, acct(9), 31)).toMatchObject({ ok: false, code: 'lifecycle' })
    let plain = ok(createIdentity(oneAccount(), { id: idn(2), colourKey: 'rose' }, 20))
    plain = ok(beginAccountSetup(plain, { accountId: acct(7), realmId: realm(7), providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${realm(7)}` }, 21))
    plain = ok(markSetupDiscarding(plain, acct(7), 22))
    expect(commitAccountSetup(plain, acct(7), { identityId: idn(2), authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: 'user-asserted' }, 23)).toMatchObject({ ok: false, code: 'lifecycle' })
    // Marking it again changes nothing; dropping it finishes it.
    expect(ok(markSetupDiscarding(plain, acct(7), 24))).toBe(plain)
  })
})

describe('the document rules for a staged sign in again (review round 1, T4)', () => {
  it('a journal naming a malformed account to replace is not read', () => {
    for (const bad of ['not-an-account', idn(1), 42]) {
      const d = JSON.parse(JSON.stringify(staged()))
      d.journals[0].replacesAccountId = bad
      expect(parseRegistryDoc(d), String(bad)).toMatchObject({ ok: false, reason: 'invalid' })
    }
  })

  it('two staged sign-ins of one account break the invariants', () => {
    const d = JSON.parse(JSON.stringify(staged())) as ProviderRegistryDoc
    d.realms.push({ ...findRealm(d, realm(2))!, id: realm(3), pathRef: `managed:${realm(3)}`, ownerProviderAccountId: acct(8) })
    d.journals.push({ ...d.journals[0], accountId: acct(8), realmId: realm(3) })
    expect(checkRegistryInvariants(d).join('\n')).toMatch(/two sign-ins again replace/)
  })

  it('a staged sign-in replaces only a live, app-managed account of its own provider', () => {
    const wrongProvider = JSON.parse(JSON.stringify(staged())) as ProviderRegistryDoc
    wrongProvider.journals[0].providerId = 'claude'
    const archived = JSON.parse(JSON.stringify(staged())) as ProviderRegistryDoc
    archived.accounts[0] = { ...archived.accounts[0], lifecycle: 'archived', isProviderDefault: false }
    // This computer's own home as the target.
    let ext = ok(createIdentity(emptyRegistry(), { id: idn(1), friendlyName: 'External', colourKey: 'mauve' }, 10))
    ext = ok(beginAccountSetup(ext, { accountId: acct(1), realmId: realm(1), providerId: 'codex', method: 'external', realmKind: 'codex-home', ownership: 'external-default', pathRef: 'external-default' }, 11))
    ext = ok(commitAccountSetup(ext, acct(1), { identityId: idn(1), authMethod: 'external', lastKnownAuthState: 'signed-in', identityAssurance: 'realm-only' }, 12))
    ext = ok(beginAccountSetup(ext, { accountId: acct(9), realmId: realm(2), providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${realm(2)}` }, 13))
    ext = { ...ext, journals: ext.journals.map((j) => ({ ...j, replacesAccountId: acct(1) })) }
    // A Claude profile's account as the target.
    const rec = reconcileLegacyAccounts(oneAccount(), 'claude', [{
      legacyId: 'profile-work', friendlyName: 'Work', colourKey: 'rose', lifecycle: 'active', isDefault: true,
      realm: { kind: 'claude-config-home', ownership: 'conductor-managed', pathRef: 'claude-profile:profile-work' }, authMethod: 'browser', identityAssurance: 'user-asserted',
    }], { now: 5, deterministicId: (kind, seed) => `${ID_PREFIX[kind]}-${seed === 'profile-work' ? hex(40) : hex(41)}` })
    if (!rec.ok) throw new Error(rec.problems.join('; '))
    const claudeId = rec.doc.accounts.find((a) => a.providerId === 'claude')!.id
    let claude = ok(beginAccountSetup(rec.doc, { accountId: acct(9), realmId: realm(2), providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${realm(2)}` }, 13))
    claude = { ...claude, journals: claude.journals.map((j) => ({ ...j, replacesAccountId: claudeId })) }
    for (const [name, d] of [['another provider', wrongProvider], ['archived', archived], ['this computer\'s own home', ext], ['a Claude profile', claude]] as const) {
      expect(checkRegistryInvariants(d).join('\n'), name).toMatch(/replaces .* which cannot sign in again/)
    }
  })

  it('only an app-managed realm may stay owned by an account that moved off it', () => {
    const d = JSON.parse(JSON.stringify(ok(settleSupersededRealm(ok(rebindAccountRealm(staged(), acct(9), { state: 'signed-in' }, 30)), realm(1), 'retired', 40)))) as ProviderRegistryDoc
    expect(checkRegistryInvariants(d)).toEqual([])
    const old = d.realms.find((x) => x.id === realm(1))!
    old.ownership = 'external-default'
    old.pathRef = 'external-default'
    expect(checkRegistryInvariants(d).join('\n')).toMatch(/is not its realm/)
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

/** A registry file whose write can land and then report a failure (the
 *  read-back threw), or whose read can fail. */
class TornPort extends MemoryPort {
  torn: number[] = []
  blind = false
  override read() {
    // Not there to read back (the store takes nothing but a readable file).
    if (this.blind) return { kind: 'missing' as const }
    return super.read()
  }
  override write(text: string) {
    this.writes++
    if (this.failWrites.includes(this.writes)) throw new Error('disk full (nothing written)')
    this.file = text
    if (this.torn.includes(this.writes)) throw new Error('EBUSY on read-back (written)')
  }
}
const realmIdOf = (h: H, a: string) => h.doc().accounts.find((x) => x.id === a)!.authRealmId
const homeOf = (realmId: string) => managedHome(realmId).toLowerCase()
/** `n` conversations from before, a folder per day (at most 28), and the
 *  prompt history, in a realm's home. Paths as the memory tree keeps them
 *  (caseless); the rollouts' paths are returned. */
function plantHistory(h: H, home: string, n: number): string[] {
  const out: string[] = []
  for (const d of ['sessions', 'sessions\\2026', 'sessions\\2026\\09']) h.folders.dirs.add(`${home}\\${d}`)
  for (let i = 0; i < n; i++) {
    const day = `${home}\\sessions\\2026\\09\\${String(1 + (i % 28)).padStart(2, '0')}`
    h.folders.dirs.add(day)
    out.push(`${day}\\rollout-${i}.jsonl`)
    h.folders.files.add(out[i])
  }
  h.folders.files.add(`${home}\\history.jsonl`)
  return out
}
const NL = String.fromCharCode(10)

async function withExternalHome(h: H) {
  h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
  const r = await h.service.adoptExternalDefault({ providerId: 'codex' })
  if (!r.ok) throw new Error(r.code)
  return r.accountId
}

/** Removing an old sign-in proven safe, as evidence would record it: the
 *  provider's auth.retireReplaced on, and every realm's credentials known
 *  to be its own file (design 9.2; review round 1, S1 and thesis 5). */
async function proveRemoval(h: H) {
  h.setCapabilities({ 'auth.retireReplaced': { state: 'supported' } })
  expect((await h.store.mutate((d) => ({ ok: true, doc: { ...d, realms: d.realms.map((r) => ({ ...r, credentialStoreMode: 'file' as const })) } }))).ok).toBe(true)
}

describe('signing in again while signed in, through the service (WP1.52)', () => {
  it('needs the user\'s answer: without it nothing runs (review round 1, T1)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const runs = h.runs.length
    expect(await h.service.signInAgain({ accountId: a, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'not-confirmed' })
    expect(await h.service.signInAgain({ sameAccount: false, accountId: a, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'not-confirmed' })
    expect(h.runs.length).toBe(runs)
    expect(h.doc().journals).toEqual([])
  })

  it('runs in a new realm and switches the same account to it; the old sign-in is kept, visible, while removing it is not proven safe (S1)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const before = h.doc()
    const oldRealm = realmIdOf(h, a)
    const runsBefore = h.runs.length
    const lines: string[] = []
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1, (t) => lines.push(t))).toEqual({ ok: true, state: 'signed-in' })
    expect(lines.join('')).toContain('Starting local login server')
    const newRealm = realmIdOf(h, a)
    expect(newRealm).not.toBe(oldRealm)
    const where = (home: string) => (home.toLowerCase() === homeOf(oldRealm) ? 'old' : home.toLowerCase() === homeOf(newRealm) ? 'new' : home)
    const runs = h.runs.slice(runsBefore).map((r) => `${r.args} @ ${where(r.home)}`)
    // Logged in to the new realm only; nothing at all ran in the old one.
    expect(runs.filter((r) => r.startsWith('login @') || r.startsWith('logout'))).toEqual(['login @ new'])
    expect(runs.filter((r) => r.endsWith('@ old'))).toEqual([])
    expect(h.signedIn.get(homeOf(oldRealm))).toBe('chatgpt')
    expect(h.signedIn.get(homeOf(newRealm))).toBe('chatgpt')
    const d = h.doc()
    // The same account: its id, identity, default -- only its realm moved.
    expect(d.accounts).toHaveLength(1)
    expect(findAccount(d, a)).toMatchObject({ identityId: findAccount(before, a)!.identityId, isProviderDefault: true, lastKnownAuthState: 'signed-in', operationalState: 'attention', identityAssurance: 'user-asserted' })
    expect(findRealm(d, oldRealm)).toMatchObject({ lifecycle: 'recovery', ownerProviderAccountId: a })
    expect(findRealm(d, newRealm)).toMatchObject({ lifecycle: 'active', ownerProviderAccountId: a })
    expect(d.journals).toEqual([])
    expect(h.service.snapshot().accounts[0]).toMatchObject({ oldSignInLeft: 'kept', operationalState: 'attention' })
    expect(h.service.consumersOf(a)).toEqual({ session: 0, review: 0, 'sign-in': 0, operation: 0 })
    // Usable: attention is not a block.
    expect((await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: 's1' })).ok).toBe(true)
    h.service.releaseLaunch('session', 's1')
    // A check does not remove it either while it is not proven safe.
    const checks = h.runs.length
    expect(await h.service.refreshStatus({ accountId: a })).toEqual({ ok: true, state: 'signed-in' })
    expect(h.runs.slice(checks).map((r) => where(r.home))).toEqual(['new'])
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('recovery')
  })

  it('the removal is off by default: the provider declares it unknown, pending the evidence (S1)', async () => {
    expect(codexCapabilities['auth.retireReplaced'].state).toBe('unknown')
    expect(codexWiredCapabilities['auth.retireReplaced'].state).toBe('unknown')
    expect(codexWiredCapabilities['auth.retireReplaced'].note).toMatch(/evidence/)
    expect(claudeCapabilities['auth.retireReplaced'].state).toBe('unsupported')
  })

  it('once removing it is proven safe, the old sign-in is signed out in its own folder and the new one checked again', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    await proveRemoval(h)
    const oldRealm = realmIdOf(h, a)
    const runsBefore = h.runs.length
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    const newRealm = realmIdOf(h, a)
    const where = (home: string) => (home.toLowerCase() === homeOf(oldRealm) ? 'old' : home.toLowerCase() === homeOf(newRealm) ? 'new' : home)
    const runs = h.runs.slice(runsBefore).map((r) => `${r.args} @ ${where(r.home)}`)
    expect(runs.filter((r) => r.startsWith('login @') || r.startsWith('logout'))).toEqual(['login @ new', 'logout @ old'])
    expect(runs.lastIndexOf('login status @ new')).toBeGreaterThan(runs.indexOf('logout @ old'))
    expect(h.signedIn.has(homeOf(oldRealm))).toBe(false)
    expect(findRealm(h.doc(), oldRealm)).toMatchObject({ lifecycle: 'retired', ownerProviderAccountId: a })
    expect(findAccount(h.doc(), a)).toMatchObject({ operationalState: 'ready', lastKnownAuthState: 'signed-in' })
    // The old folder is kept, signed out, as an archived account's is.
    expect(h.folders.exists(managedHome(oldRealm))).toBe(true)
    expect(h.service.snapshot().accounts[0].oldSignInLeft).toBeUndefined()
  })

  it('its own file store alone is not enough: without the capability the old sign-in is kept (S1)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    expect((await h.store.mutate((d) => ({ ok: true, doc: { ...d, realms: d.realms.map((r) => ({ ...r, credentialStoreMode: 'file' as const })) } }))).ok).toBe(true)
    const oldRealm = realmIdOf(h, a)
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    expect(h.args().filter((x) => x === 'logout')).toEqual([])
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('recovery')
    expect(h.service.snapshot().accounts[0].oldSignInLeft).toBe('kept')
  })

  it('a folder whose credentials are not known to be its own file is never signed out, the capability on or not (thesis 5)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    h.setCapabilities({ 'auth.retireReplaced': { state: 'supported' } })
    for (const mode of [undefined, 'keyring', 'unknown'] as const) {
      if (mode) expect((await h.store.mutate((d) => ({ ok: true, doc: { ...d, realms: d.realms.map((r) => (r.id === realmIdOf(h, a) ? { ...r, credentialStoreMode: mode } : r)) } }))).ok).toBe(true)
      const oldRealm = realmIdOf(h, a)
      const logouts = h.args().filter((x) => x === 'logout').length
      expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1), String(mode)).toEqual({ ok: true, state: 'signed-in' })
      expect(h.args().filter((x) => x === 'logout').length, String(mode)).toBe(logouts)
      expect(findRealm(h.doc(), oldRealm)!.lifecycle, String(mode)).toBe('recovery')
      expect(h.service.snapshot().accounts[0].oldSignInLeft, String(mode)).toBe('kept')
    }
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
    const running = h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)
    await new Promise((r) => setTimeout(r, 0))
    expect(await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: 's-during' })).toMatchObject({ ok: false, code: 'busy' })
    expect(realmIdOf(h, a)).toBe(oldRealm)
    expect(h.signedIn.get(homeOf(oldRealm))).toBe('chatgpt')
    // The replacement is journalled and listed as this account's, and is not
    // discarded, finished, signed in as a plain setup or given a key under the run.
    const pending = h.service.snapshot().pendingSetups
    expect(pending).toEqual([expect.objectContaining({ replacesAccountId: a, signingIn: true })])
    expect(await h.service.abandonSetup({ accountId: pending[0].accountId })).toMatchObject({ ok: false, code: 'busy' })
    release()
    expect(await running).toEqual({ ok: true, state: 'signed-in' })
  })

  it('a staged journal is never signed in as a plain setup, nor given a key of its own (T3)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const stagedId = `acct-${'b'.repeat(32)}`
    const replacement = `realm-${'b'.repeat(32)}`
    expect((await h.store.mutate((d, t) => beginAccountReauth(d, { accountId: stagedId, realmId: replacement, replacesAccountId: a, method: 'browser' }, t))).ok).toBe(true)
    expect((await h.codex.realmFolders!.prepare({ authRealmId: replacement })).ok).toBe(true)
    const runs = h.runs.length
    expect(await h.service.signIn({ accountId: stagedId, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'unsupported' })
    expect(h.service.issueSecretHandle({ accountId: stagedId }, 1)).toMatchObject({ ok: false, code: 'unsupported' })
    expect(h.runs.length).toBe(runs)
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
      const run = h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)
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

  it('a replacement folder that cannot be made leaves nothing behind; a journal whose folder was never made is discarded (T3)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const before = JSON.stringify(h.doc())
    const mkdir = h.folders.fs.mkdir
    h.folders.fs.mkdir = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
    expect((await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).ok).toBe(false)
    h.folders.fs.mkdir = mkdir
    expect(JSON.stringify(h.doc())).toBe(before)
    // The app closed between the journal and its folder.
    const stagedId = `acct-${'a'.repeat(32)}`
    expect((await h.store.mutate((d, t) => beginAccountReauth(d, { accountId: stagedId, realmId: `realm-${'a'.repeat(32)}`, replacesAccountId: a, method: 'browser' }, t))).ok).toBe(true)
    const again = await harness({ port: h.port, folders: h.folders })
    for (const [home, v] of h.signedIn) again.signedIn.set(home, v)
    expect(again.service.snapshot().pendingSetups).toEqual([expect.objectContaining({ accountId: stagedId, replacesAccountId: a })])
    expect(await again.service.abandonSetup({ accountId: stagedId })).toEqual({ ok: true })
    expect(again.doc().journals).toEqual([])
    expect(again.signedIn.get(homeOf(realmIdOf(again, a)))).toBe('chatgpt')
  })

  it('the provider turned off during the sign-in: nothing is switched, and the replacement waits, listed (T3)', async () => {
    let pref: 'on' | 'off' = 'on'
    let armed = false
    const h = await harness({ preference: { codex: () => pref }, script: { login: (r) => {
      h.signedIn.set(r.home.toLowerCase(), 'chatgpt')
      if (armed) pref = 'off'
      return { exitCode: 0, stdout: 'Successfully logged in' + NL }
    } } })
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    armed = true
    const r = await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)
    expect(r.ok).toBe(false)
    expect(realmIdOf(h, a)).toBe(oldRealm)
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('active')
    expect(h.doc().journals).toEqual([expect.objectContaining({ replacesAccountId: a, state: 'credentials-written' })])
    // Back on: Discard signs the replacement out and removes it.
    pref = 'on'
    const staged = h.doc().journals[0]
    expect(await h.service.abandonSetup({ accountId: staged.accountId })).toEqual({ ok: true })
    expect(h.signedIn.has(homeOf(staged.realmId))).toBe(false)
  })

  it('a switch reported as not saved is decided by what the disk says (review round 2, L1-1)', async () => {
    // Written, then the write reported a failure: the disk has the switch.
    const torn = new TornPort()
    const h = await harness({ port: torn })
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    // The writes of a sign in again: the journal, the credentials mark, the switch.
    torn.torn = [torn.writes + 3]
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    const newRealm = realmIdOf(h, a)
    expect(newRealm).not.toBe(oldRealm)
    expect(h.folders.exists(managedHome(newRealm))).toBe(true)
    expect(h.signedIn.get(homeOf(newRealm))).toBe('chatgpt')
    expect(h.doc().journals).toEqual([])
    const disk = JSON.parse(torn.file!) as ProviderRegistryDoc
    expect(disk.accounts.find((x) => x.id === a)!.authRealmId).toBe(newRealm)
    // Nothing written: the disk says not switched, so the replacement goes.
    const k = await harness()
    const b = await addCodexAccount(k, 'B')
    const bOld = realmIdOf(k, b)
    k.port.failWrites = [k.port.writes + 3]
    expect(await k.service.signInAgain({ sameAccount: true, accountId: b, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'persist-failed' })
    expect(realmIdOf(k, b)).toBe(bOld)
    expect(k.doc().journals).toEqual([])
    expect([...k.folders.dirs].filter((x) => x.startsWith('c:\\res\\codex-realms\\'))).toEqual([homeOf(bOld)])
    // The disk cannot be read back: kept, listed, never signed out on a guess.
    const blind = new TornPort()
    const m = await harness({ port: blind })
    const c = await addCodexAccount(m, 'C')
    blind.failWrites = [blind.writes + 3]
    blind.blind = true
    expect(await m.service.signInAgain({ sameAccount: true, accountId: c, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'persist-failed' })
    const staged = m.doc().journals[0]
    expect(staged).toMatchObject({ replacesAccountId: c, state: 'credentials-written' })
    expect(m.signedIn.get(homeOf(staged.realmId))).toBe('chatgpt')
    expect(m.args().filter((x) => x === 'logout')).toEqual([])
  })

  it('a Discard is written ahead: one whose first write fails touches nothing; a completion reported as not saved is undone on disk before its folder goes (L1-1)', async () => {
    const h = await harness()
    const begun = await h.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
    await h.service.signIn({ accountId: begun.accountId, method: 'browser' }, 1)
    const realmId = h.doc().journals[0].realmId
    h.port.failWrites = [h.port.writes + 1]
    expect(await h.service.abandonSetup({ accountId: begun.accountId })).toMatchObject({ ok: false, code: 'persist-failed' })
    expect(h.signedIn.get(homeOf(realmId))).toBe('chatgpt')
    expect(h.folders.exists(managedHome(realmId))).toBe(true)
    expect(h.args().filter((x) => x === 'logout')).toEqual([])
    // A completion whose write landed but was reported as failed, then Discard.
    const torn = new TornPort()
    const k = await harness({ port: torn })
    const c = await k.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
    await k.service.signIn({ accountId: c.accountId, method: 'browser' }, 1)
    const cRealm = k.doc().journals[0].realmId
    torn.torn = [torn.writes + 1]
    expect((await k.service.completeSetup({ accountId: c.accountId, identity: { mode: 'new', colourKey: 'rose' } })).ok).toBe(false)
    expect((JSON.parse(torn.file!) as ProviderRegistryDoc).accounts.map((x) => x.id)).toEqual([c.accountId])
    expect(await k.service.abandonSetup({ accountId: c.accountId })).toEqual({ ok: true })
    // The disk and the folder agree: no account, no setup, no folder.
    const again = await harness({ port: torn, folders: k.folders })
    expect(again.doc().accounts).toEqual([])
    expect(again.doc().journals).toEqual([])
    expect(k.folders.exists(managedHome(cRealm))).toBe(false)
  })

  it('a Discard cut short is listed as such, never resumed or completed, and the next Discard finishes it (L1-1)', async () => {
    let refuse = true
    const h = await harness({ script: { logout: (r) => {
      if (refuse) return { exitCode: 1, stderr: 'could not log out' + NL }
      h.signedIn.delete(r.home.toLowerCase())
      return { exitCode: 0, stdout: 'Successfully logged out' + NL }
    } } })
    const begun = await h.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
    await h.service.signIn({ accountId: begun.accountId, method: 'browser' }, 1)
    expect((await h.service.abandonSetup({ accountId: begun.accountId })).ok).toBe(false)
    expect(h.doc().journals[0].state).toBe('discarding')
    expect(h.service.snapshot().pendingSetups[0]).toMatchObject({ state: 'discarding' })
    expect(await h.service.completeSetup({ accountId: begun.accountId, identity: { mode: 'new', colourKey: 'rose' } })).toMatchObject({ ok: false, code: 'unsupported' })
    expect(await h.service.signIn({ accountId: begun.accountId, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'unsupported' })
    refuse = false
    expect(await h.service.abandonSetup({ accountId: begun.accountId })).toEqual({ ok: true })
    expect(h.doc().journals).toEqual([])
  })

  it('carries the earlier conversations over before the switch: resume and usage keep them (review round 2, H1)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    const oldHome = homeOf(oldRealm)
    // A conversation from before, and the prompt history.
    // The memory folder tree keeps paths as the file system compares them: caseless.
    const rollout = 'sessions\\2026\\09\\27\\rollout-2026-09-27t12-08-23-00000000-0000-7000-8000-000000000001.jsonl'
    for (const d of ['sessions', 'sessions\\2026', 'sessions\\2026\\09', 'sessions\\2026\\09\\27']) h.folders.dirs.add(`${oldHome}\\${d}`)
    h.folders.files.add(`${oldHome}\\${rollout}`)
    h.folders.files.add(`${oldHome}\\history.jsonl`)
    // Neither the sign-in nor anything else is copied.
    h.folders.files.add(`${oldHome}\\config.toml`)
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    const newHome = homeOf(realmIdOf(h, a))
    expect(h.folders.files.has(`${newHome}\\${rollout}`)).toBe(true)
    expect(h.folders.files.has(`${newHome}\\history.jsonl`)).toBe(true)
    expect(h.folders.files.has(`${newHome}\\config.toml`)).toBe(false)
    // Carried over, not moved: the old folder keeps them. Each file is a
    // second name of the same file (a hard link, review round 3, C1).
    expect(h.folders.files.has(`${oldHome}\\${rollout}`)).toBe(true)
    expect(h.folders.fs.lstat(`${newHome}\\${rollout}`)).toMatchObject({ ino: h.folders.fs.lstat(`${oldHome}\\${rollout}`).ino, nlink: 2 })
    expect(h.folders.log.filter((l) => l.startsWith('link '))).toHaveLength(2)
    // Resume (codex resume <id> finds a rollout by id in any date folder of
    // its home, P3.1 evidence) and usage look in the account's own folder now.
    const roots = (await h.service.sessionsRoots('codex'))!
    expect(roots.map((x) => x.dir.toLowerCase())).toEqual([`${newHome}\\sessions`])
    expect(roots[0].accountId).toBe(a)
    // Tokenomics counts a carried-over rollout once, read from both folders:
    // tests/unit/tokenomics/tokenomics-carried-history-once.test.ts.
  })

  it('history is never carried over to someone else, and a link in it stops the sign in again with nothing changed (H1)', async () => {
    const sp = subjectProvider()
    const h = await harness({ authWrap: sp.wrap })
    const a = await addCodexAccount(h, 'A')
    const oldHome = homeOf(realmIdOf(h, a))
    h.folders.dirs.add(`${oldHome}\\sessions`)
    h.folders.files.add(`${oldHome}\\history.jsonl`)
    sp.next.subject = 'user-2'
    const r = await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)
    const sep = (r as { separateAccountId: string }).separateAccountId
    const sepRealm = h.doc().journals.find((j) => j.accountId === sep)!.realmId
    expect(h.folders.files.has(`${homeOf(sepRealm)}\\history.jsonl`)).toBe(false)
    // A link where the history is: refused, and the account keeps its sign-in.
    const k = await harness()
    const b = await addCodexAccount(k, 'B')
    const bOld = realmIdOf(k, b)
    const bHome = homeOf(bOld)
    k.folders.dirs.add(`${bHome}\\sessions`)
    const lstat = k.folders.fs.lstat
    k.folders.fs.lstat = (p) => (p.toLowerCase() === `${bHome}\\sessions` ? { kind: 'link', dev: '9', ino: '5', mode: 0o777 } : lstat(p))
    expect(await k.service.signInAgain({ sameAccount: true, accountId: b, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'unsafe-contents' })
    expect(realmIdOf(k, b)).toBe(bOld)
    expect(k.doc().journals).toEqual([])
    expect([...k.folders.dirs].filter((x) => x.startsWith('c:\\res\\codex-realms\\') && !x.startsWith(bHome))).toEqual([])
  })

  it('carries a large history over without holding the event loop: timers run between batches (review round 3, C1)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    plantHistory(h, homeOf(realmIdOf(h, a)), 640)
    let ticks = 0
    let running = true
    const tick = () => { ticks++; if (running) setTimeout(tick, 0) }
    setTimeout(tick, 0)
    // Each file takes as long as a small real one does; the tick count as
    // each is carried over.
    const seen: number[] = []
    const busy = () => { const until = performance.now() + 0.05; while (performance.now() < until) { /* a file operation takes time */ } }
    const { link, copyFile } = h.folders.ops
    h.folders.ops.link = (s, d) => { busy(); seen.push(ticks); link(s, d) }
    h.folders.ops.copyFile = (s, d) => { busy(); seen.push(ticks); copyFile(s, d) }
    try {
      expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    } finally {
      running = false
    }
    expect(seen).toHaveLength(641)
    // Timers ran while the files were carried over, not only after.
    expect(seen[seen.length - 1] - seen[0]).toBeGreaterThanOrEqual(3)
  })

  it('a file becomes a second name of the same file; where linking is refused, a copy; never over anything there (C1)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const oldHome = homeOf(realmIdOf(h, a))
    const [first] = plantHistory(h, oldHome, 3)
    // This file system gives no second names: each file is copied instead.
    h.folders.ops.link = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    const newHome = homeOf(realmIdOf(h, a))
    const moved = first.replace(oldHome, newHome)
    expect(h.folders.files.has(moved)).toBe(true)
    expect(h.folders.fs.lstat(moved).nlink).toBe(1)
    expect(h.folders.log.filter((l) => l.startsWith('copyFile '))).toHaveLength(4)
    // Something already in the replacement is never written over: the
    // sign in again stops, nothing changed.
    const k = await harness()
    const b = await addCodexAccount(k, 'B')
    const bOld = realmIdOf(k, b)
    plantHistory(k, homeOf(bOld), 1)
    const copy = k.codex.realmFolders!.copyHistory!
    k.codex.realmFolders!.copyHistory = async (from, to, opts) => { k.folders.files.add(`${homeOf(to.authRealmId)}\\history.jsonl`); return copy(from, to, opts) }
    expect(await k.service.signInAgain({ sameAccount: true, accountId: b, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'not-empty' })
    expect(realmIdOf(k, b)).toBe(bOld)
  })

  it('a file that has another name the app did not give it (a planted hard link) is left behind, and said so (C1)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const oldHome = homeOf(realmIdOf(h, a))
    const [kept] = plantHistory(h, oldHome, 2)
    // A second name, in the history, for this computer's own sign-in file.
    const auth = `${EXT_HOME.toLowerCase()}\\auth.json`
    h.folders.files.add(auth)
    const planted = `${oldHome}\\sessions\\2026\\09\\01\\rollout-planted.jsonl`
    h.folders.ops.link(auth, planted)
    expect(h.folders.fs.lstat(planted).nlink).toBe(2)
    // Said in the answer, for the dialog to tell the user (final review round, F2).
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in', notCarriedOver: 1 })
    const newHome = homeOf(realmIdOf(h, a))
    expect(h.folders.files.has(kept.replace(oldHome, newHome))).toBe(true)
    expect(h.folders.files.has(planted.replace(oldHome, newHome))).toBe(false)
    // It was given no third name, and was not copied either.
    expect(h.folders.fs.lstat(auth).nlink).toBe(2)
    expect(h.folders.log.filter((l) => l.includes('rollout-planted'))).toEqual([`link ${auth} -> ${planted}`])
    expect(h.logs.some((l) => /left 1 earlier conversation file\(s\) behind/.test(l))).toBe(true)
  })

  it('signing in again once more carries every file over again: the names an earlier sign in again gave are the app\'s own (C1)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const first = homeOf(realmIdOf(h, a))
    const files = plantHistory(h, first, 3)
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    const second = homeOf(realmIdOf(h, a))
    expect(h.folders.fs.lstat(files[0].replace(first, second)).nlink).toBe(2)
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    const third = homeOf(realmIdOf(h, a))
    for (const f of files) expect(h.folders.fs.lstat(f.replace(first, third)).nlink, f).toBe(3)
    expect(h.folders.files.has(`${third}\\history.jsonl`)).toBe(true)
    expect(h.logs.some((l) => /behind/.test(l))).toBe(false)
    // The same file under another name in an earlier realm is not the app's.
    const k = await harness()
    const b = await addCodexAccount(k, 'B')
    const bFirst = homeOf(realmIdOf(k, b))
    const [one] = plantHistory(k, bFirst, 1)
    expect(await k.service.signInAgain({ sameAccount: true, accountId: b, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    const bSecond = homeOf(realmIdOf(k, b))
    k.folders.ops.link(one, `${bFirst}\\sessions\\2026\\09\\01\\rollout-renamed.jsonl`)
    expect(await k.service.signInAgain({ sameAccount: true, accountId: b, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in', notCarriedOver: 1 })
    const bThird = homeOf(realmIdOf(k, b))
    expect(k.folders.files.has(one.replace(bFirst, bThird))).toBe(false)
    expect(k.folders.files.has(one.replace(bFirst, bSecond))).toBe(true)
    // Nor is a name reached through a link or junction in an earlier realm
    // (the place there resolves somewhere else).
    const m = await harness()
    const c = await addCodexAccount(m, 'C')
    const cFirst = homeOf(realmIdOf(m, c))
    const [two] = plantHistory(m, cFirst, 1)
    expect(await m.service.signInAgain({ sameAccount: true, accountId: c, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    const realpath = m.folders.fs.realpath
    m.folders.fs.realpath = (p) => (p.toLowerCase() === two ? 'C:\\elsewhere\\rollout-0.jsonl' : realpath(p))
    expect(await m.service.signInAgain({ sameAccount: true, accountId: c, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in', notCarriedOver: 1 })
    expect(m.folders.files.has(two.replace(cFirst, homeOf(realmIdOf(m, c))))).toBe(false)
  })

  it('a file swapped for another between its check and its link: what was made goes again, and nothing changes (C1)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    const oldHome = homeOf(oldRealm)
    const [one] = plantHistory(h, oldHome, 1)
    const other = `${EXT_HOME.toLowerCase()}\\auth.json`
    h.folders.files.add(other)
    const { link } = h.folders.ops
    let swapped = false
    h.folders.ops.link = (s, d) => {
      if (!swapped && s.toLowerCase() === one) {
        swapped = true
        h.folders.fs.unlink(one)
        link(other, one)
        h.folders.fs.unlink(other)
      }
      link(s, d)
    }
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'changed' })
    expect(realmIdOf(h, a)).toBe(oldRealm)
    expect(h.doc().journals).toEqual([])
    expect([...h.folders.dirs].filter((x) => x.startsWith('c:\\res\\codex-realms\\') && !x.startsWith(oldHome))).toEqual([])
  })

  it('a history larger than its bound is refused with the bound named, before anything is carried over (C1)', async () => {
    const h = await harness({ realmLimits: { historyEntries: 40 } })
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    plantHistory(h, homeOf(oldRealm), 60)
    const r = await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)
    expect(r).toMatchObject({ ok: false, code: 'too-large', message: expect.stringContaining('more than 40 earlier conversation files') })
    expect(realmIdOf(h, a)).toBe(oldRealm)
    expect(h.doc().journals).toEqual([])
    expect(h.folders.log.filter((l) => l.startsWith('link ') || l.startsWith('copyFile '))).toEqual([])
    expect([...h.folders.dirs].filter((x) => x.startsWith('c:\\res\\codex-realms\\') && !x.startsWith(homeOf(oldRealm)))).toEqual([])
    // The refusal says what keeps them (final review round, F4), and it is
    // so: signed out, a sign in again runs in the account's own folder.
    expect(r).toMatchObject({ message: expect.stringContaining('To keep them, sign out of this account first, then sign in again') })
    expect(await h.service.logout({ accountId: a })).toEqual({ ok: true, state: 'signed-out' })
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    expect(realmIdOf(h, a)).toBe(oldRealm)
    expect(h.signedIn.get(homeOf(oldRealm))).toBe('chatgpt')
    expect(h.folders.files.has(`${homeOf(oldRealm)}\\history.jsonl`)).toBe(true)
    expect(h.folders.files.has(`${homeOf(oldRealm)}\\sessions\\2026\\09\\01\\rollout-0.jsonl`)).toBe(true)
  })

  it('a history larger than the removal\'s own bound is carried over, and a replacement holding it is removed whole when the switch is not saved (C1)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    plantHistory(h, homeOf(oldRealm), CODEX_REMOVE_MAX_ENTRIES + 5)
    const copy = h.codex.realmFolders!.copyHistory!
    let carried: { copied?: number } = {}
    h.codex.realmFolders!.copyHistory = async (from, to, opts) => {
      const r = await copy(from, to, opts)
      carried = r
      // The journal, the credentials mark, then the switch: it fails.
      h.port.failWrites = [h.port.writes + 1]
      return r
    }
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'persist-failed' })
    expect(carried).toMatchObject({ ok: true, copied: CODEX_REMOVE_MAX_ENTRIES + 6 })
    expect(realmIdOf(h, a)).toBe(oldRealm)
    expect(h.doc().journals).toEqual([])
    expect([...h.folders.dirs].filter((x) => x.startsWith('c:\\res\\codex-realms\\') && !x.startsWith(homeOf(oldRealm)))).toEqual([])
  }, 120_000)

  it('the provider turned off while the history was carried over: nothing is switched; once it is back, Discard removes the replacement whole (review round 3, C2)', async () => {
    let pref: 'on' | 'off' = 'on'
    const h = await harness({ preference: { codex: () => pref }, realmLimits: { removeEntries: 20 } })
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    plantHistory(h, homeOf(oldRealm), 100)
    const copy = h.codex.realmFolders!.copyHistory!
    h.codex.realmFolders!.copyHistory = async (from, to, opts) => { const r = await copy(from, to, opts); pref = 'off'; return r }
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'provider-disabled' })
    expect(realmIdOf(h, a)).toBe(oldRealm)
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('active')
    const staged = h.doc().journals[0]
    expect(staged).toMatchObject({ replacesAccountId: a, state: 'credentials-written' })
    expect(h.folders.files.has(`${homeOf(staged.realmId)}\\history.jsonl`)).toBe(true)
    pref = 'on'
    expect(await h.service.abandonSetup({ accountId: staged.accountId })).toEqual({ ok: true })
    expect(h.doc().journals).toEqual([])
    expect(h.folders.exists(managedHome(staged.realmId))).toBe(false)
    // The earlier conversations stay where they were.
    expect(h.folders.files.has(`${homeOf(oldRealm)}\\history.jsonl`)).toBe(true)
  })

  it('Cancel while the history is carried over, or just after, switches nothing: the replacement goes and the account keeps its sign-in (final review round, F1)', async () => {
    // During the copy: it stops at the next batch.
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    plantHistory(h, homeOf(oldRealm), 300)
    const { link } = h.folders.ops
    let links = 0
    h.folders.ops.link = (s, d) => { if (++links === 1) expect(h.service.cancelSignIn({ accountId: a }, 1)).toEqual({ ok: true }); link(s, d) }
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'cancelled' })
    expect(links).toBeLessThan(301)
    expect(realmIdOf(h, a)).toBe(oldRealm)
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('active')
    expect(h.doc().journals).toEqual([])
    expect([...h.folders.dirs].filter((x) => x.startsWith('c:\\res\\codex-realms\\') && !x.startsWith(homeOf(oldRealm)))).toEqual([])
    // Just after it: the switch is not made.
    const k = await harness()
    const b = await addCodexAccount(k, 'B')
    const bOld = realmIdOf(k, b)
    plantHistory(k, homeOf(bOld), 2)
    const copy = k.codex.realmFolders!.copyHistory!
    k.codex.realmFolders!.copyHistory = async (from, to, opts) => { const r = await copy(from, to, opts); k.service.cancelSignIn({ accountId: b }, 1); return r }
    expect(await k.service.signInAgain({ sameAccount: true, accountId: b, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'cancelled' })
    expect(realmIdOf(k, b)).toBe(bOld)
    expect(k.doc().journals).toEqual([])
  })

  it('says when it moves on to carrying the history over, before the switch, for the dialog\'s status line (final review round, F3)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    plantHistory(h, homeOf(oldRealm), 2)
    const phases: Array<{ phase: string; realm: string; links: number }> = []
    const said = (phase: string) => { phases.push({ phase, realm: realmIdOf(h, a), links: h.folders.log.filter((l) => l.startsWith('link ')).length }) }
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1, undefined, said)).toEqual({ ok: true, state: 'signed-in' })
    expect(phases).toEqual([{ phase: 'carrying-history', realm: oldRealm, links: 0 }])
    // A display that throws never breaks the run.
    const k = await harness()
    const b = await addCodexAccount(k, 'B')
    expect(await k.service.signInAgain({ sameAccount: true, accountId: b, method: 'browser' }, 1, undefined, () => { throw new Error('gone') })).toEqual({ ok: true, state: 'signed-in' })
  })

  it('a name added while the names were counted, at the earlier place, is caught by the count after the link: the new name goes and the file is left behind (final review round, F5)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const first = homeOf(realmIdOf(h, a))
    plantHistory(h, first, 1)
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    const second = homeOf(realmIdOf(h, a))
    // In the folder in use, a file that is also a name of a file outside.
    const outside = `${USER.toLowerCase()}\\victim.txt`
    h.folders.files.add(outside)
    const race = `${second}\\sessions\\2026\\09\\01\\rollout-race.jsonl`
    h.folders.ops.link(outside, race)
    // The earlier realm's place is given the same file just as it is looked at.
    const twin = race.replace(second, first)
    const lstat = h.folders.fs.lstat
    let armed = true
    h.folders.fs.lstat = (p) => {
      if (armed && p.toLowerCase() === twin) { armed = false; h.folders.ops.link(outside, twin) }
      return lstat(p)
    }
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in', notCarriedOver: 1 })
    expect(armed).toBe(false)
    const third = homeOf(realmIdOf(h, a))
    expect(h.folders.files.has(race.replace(second, third))).toBe(false)
    // Made, counted, and taken back: the file has the names it had.
    expect(h.folders.log).toContain(`unlink ${managedHome(realmIdOf(h, a))}\\sessions\\2026\\09\\01\\rollout-race.jsonl`)
    expect(h.folders.fs.lstat(outside).nlink).toBe(3)
  })

  it('a folder in the replacement swapped for a link or junction while a file is linked into it: the new name goes, and nothing changes (final review round, F5)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    const [one] = plantHistory(h, homeOf(oldRealm), 1)
    const realpath = h.folders.fs.realpath
    const { link } = h.folders.ops
    let swapped = ''
    h.folders.ops.link = (s, d) => {
      link(s, d)
      // The folder it went into now resolves somewhere else.
      if (!swapped && s.toLowerCase() === one) swapped = d.toLowerCase().replace(/\\[^\\]+$/, '')
    }
    h.folders.fs.realpath = (p) => (swapped && p.toLowerCase() === swapped ? 'C:\\elsewhere\\01' : realpath(p))
    const copy = h.codex.realmFolders!.copyHistory!
    let made = ''
    h.codex.realmFolders!.copyHistory = async (from, to, opts) => {
      made = homeOf(to.authRealmId)
      const r = await copy(from, to, opts)
      h.folders.fs.realpath = realpath
      return r
    }
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'unsafe-path' })
    expect(swapped).not.toBe('')
    expect(h.folders.files.has(one.replace(homeOf(oldRealm), made))).toBe(false)
    expect(realmIdOf(h, a)).toBe(oldRealm)
    expect(h.doc().journals).toEqual([])
    expect(h.folders.fs.lstat(one).nlink).toBe(1)
  })

  it('never a folder it did not make, nor a sign-in it did not perform: refused, the folder left as found (review round 2, L2-2)', async () => {
    for (const plant of ['folder', 'signed-in'] as const) {
      const h = await harness()
      const a = await addCodexAccount(h, 'A')
      const oldRealm = realmIdOf(h, a)
      const prepare = h.codex.realmFolders!.prepare
      let planted = ''
      h.codex.realmFolders!.prepare = async (ref) => {
        const home = homeOf(ref.authRealmId)
        if (plant === 'folder') { h.folders.dirs.add(home); planted = home }
        const r = await prepare(ref)
        if (plant === 'signed-in') { h.signedIn.set(home, 'chatgpt'); planted = home }
        return r
      }
      const runs = h.runs.length
      expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1), plant).toMatchObject({ ok: false, code: 'changed' })
      expect(realmIdOf(h, a), plant).toBe(oldRealm)
      expect(h.doc().journals, plant).toEqual([])
      expect(h.runs.slice(runs).filter((r) => r.args === 'login'), plant).toEqual([])
      if (plant === 'folder') expect(h.folders.exists(planted), plant).toBe(true)
    }
  })

  it('a sign-out signs out the old sign-in a sign in again left too (review round 2, L1-2)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    expect(h.signedIn.get(homeOf(oldRealm))).toBe('chatgpt')
    expect(await h.service.logout({ accountId: a })).toEqual({ ok: true, state: 'signed-out' })
    expect(h.signedIn.size).toBe(0)
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('retired')
    expect(h.service.snapshot().accounts[0].oldSignInLeft).toBeUndefined()
  })

  it('a sign-out whose result could not be read back leaves the account needing a check, never "signed in, ready" (review round 2, L2-1)', async () => {
    let odd = false
    const h = await harness({ script: {
      'login status': (r) => {
        if (odd) return { exitCode: 2, stderr: 'error: something odd' + NL }
        return h.signedIn.has(r.home.toLowerCase()) ? { exitCode: 0, stderr: 'Logged in using ChatGPT' + NL } : { exitCode: 1, stderr: 'Not logged in' + NL }
      },
      'logout': (r) => { h.signedIn.delete(r.home.toLowerCase()); odd = true; return { exitCode: 0, stdout: 'Successfully logged out' + NL } },
    } })
    const a = await addCodexAccount(h, 'A')
    expect((await h.service.logout({ accountId: a })).ok).toBe(false)
    expect(findAccount(h.doc(), a)).toMatchObject({ lastKnownAuthState: 'unknown', operationalState: 'attention' })
    // Nothing ran (refused before the CLI): nothing is recorded either.
    odd = false
    const k = await harness()
    const b = await addCodexAccount(k, 'B')
    k.state.envFile.add(homeOf(realmIdOf(k, b)))
    expect(await k.service.logout({ accountId: b })).toMatchObject({ ok: false, code: 'realm-env-file' })
    expect(findAccount(k.doc(), b)).toMatchObject({ lastKnownAuthState: 'signed-in', operationalState: 'ready' })
  })

  it('a sign-out that ran, whose read-back then could not start or found the CLI changed, leaves the account needing a check: a sign-out, this computer\'s sign in again, an archive (review round 3, C3)', async () => {
    for (const how of ['read-back not started', 'CLI replaced'] as const) {
      const mk = async () => {
        let after = false
        const h = await harness({ script: {
          'logout': (r) => {
            h.signedIn.delete(r.home.toLowerCase())
            after = true
            if (how === 'CLI replaced') h.state.exeStat = { ...h.state.exeStat, mtimeMs: 999 }
            return { exitCode: 0, stdout: 'Successfully logged out' + NL }
          },
          'login status': (r) => {
            if (after && how === 'read-back not started') return { spawnError: 'EAGAIN' }
            return h.signedIn.has(r.home.toLowerCase()) ? { exitCode: 0, stderr: 'Logged in using ChatGPT' + NL } : { exitCode: 1, stderr: 'Not logged in' + NL }
          },
        } })
        return h
      }
      const h = await mk()
      const a = await addCodexAccount(h, 'A')
      expect((await h.service.logout({ accountId: a })).ok, how).toBe(false)
      expect(h.signedIn.has(homeOf(realmIdOf(h, a))), how).toBe(false)
      expect(findAccount(h.doc(), a), how).toMatchObject({ lastKnownAuthState: 'unknown', operationalState: 'attention' })
      const k = await mk()
      const ext = await withExternalHome(k)
      expect((await k.service.signInAgain({ sameAccount: true, acknowledgeExternal: true, accountId: ext, method: 'browser' }, 1)).ok, how).toBe(false)
      expect(k.signedIn.has(EXT_HOME.toLowerCase()), how).toBe(false)
      expect(findAccount(k.doc(), ext), how).toMatchObject({ lastKnownAuthState: 'unknown', operationalState: 'attention' })
      const m = await mk()
      const b = await addCodexAccount(m, 'B')
      expect(await m.service.setLifecycle({ accountId: b, lifecycle: 'inactive' }), how).toEqual({ ok: true })
      expect((await m.service.setLifecycle({ accountId: b, lifecycle: 'archived' })).ok, how).toBe(false)
      expect(findAccount(m.doc(), b), how).toMatchObject({ lifecycle: 'inactive', lastKnownAuthState: 'unknown' })
    }
  })

  it('archive asks the account\'s own folder first: nothing is signed out when it cannot finish (review round 2, L2-3)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    expect((await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })).ok).toBe(true)
    h.state.envFile.add(homeOf(realmIdOf(h, a)))
    const runs = h.runs.length
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })).toMatchObject({ ok: false, code: 'realm-env-file' })
    expect(h.signedIn.get(homeOf(oldRealm))).toBe('chatgpt')
    expect(h.runs.slice(runs).filter((r) => r.args === 'logout')).toEqual([])
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('recovery')
  })

  it('a settle whose save failed leaves the old sign-in visible, retried later (T3)', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    // The journal, the credentials mark, the switch, then the settle.
    h.port.failWrites = [h.port.writes + 4]
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('retiring')
    expect(h.service.snapshot().accounts[0]).toMatchObject({ oldSignInLeft: 'kept', operationalState: 'attention' })
    expect(await h.service.refreshStatus({ accountId: a })).toEqual({ ok: true, state: 'signed-in' })
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('recovery')
  })

  it('an old sign-in whose removal did not finish is said so, and a check tries again (Q3)', async () => {
    let refuse = true
    const h = await harness({ script: { logout: (r) => {
      if (refuse) return { exitCode: 1, stderr: 'could not log out' + NL }
      h.signedIn.delete(r.home.toLowerCase())
      return { exitCode: 0, stdout: 'Successfully logged out' + NL }
    } } })
    const a = await addCodexAccount(h, 'A')
    await proveRemoval(h)
    const oldRealm = realmIdOf(h, a)
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('recovery')
    expect(h.service.snapshot().accounts[0]).toMatchObject({ oldSignInLeft: 'failed', operationalState: 'attention' })
    // Sign-out not available: said so, and nothing is tried.
    h.setCapabilities({ 'auth.retireReplaced': { state: 'supported' }, 'auth.logout': { state: 'unknown' } })
    const runs = h.runs.length
    expect(h.service.snapshot().accounts[0].oldSignInLeft).toBe('unavailable')
    expect(await h.service.refreshStatus({ accountId: a })).toEqual({ ok: true, state: 'signed-in' })
    expect(h.args().slice(runs).filter((x) => x === 'logout')).toEqual([])
    // Available and working again: a check retries it.
    h.setCapabilities({ 'auth.retireReplaced': { state: 'supported' } })
    refuse = false
    expect(await h.service.refreshStatus({ accountId: a })).toEqual({ ok: true, state: 'signed-in' })
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('retired')
    expect(h.signedIn.has(homeOf(oldRealm))).toBe(false)
    expect(findAccount(h.doc(), a)!.operationalState).toBe('ready')
    expect(h.service.snapshot().accounts[0].oldSignInLeft).toBeUndefined()
  })

  it('archiving removes the old sign-in with the account\'s own, proof or not (both go), and refuses while it cannot', async () => {
    let refuseOld = true
    const h = await harness({ script: { logout: (r) => {
      if (refuseOld && r.home.toLowerCase() !== homeOf(realmIdOf(h, a))) return { exitCode: 1, stderr: 'could not log out' + NL }
      h.signedIn.delete(r.home.toLowerCase())
      return { exitCode: 0, stdout: 'Successfully logged out' + NL }
    } } })
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    expect(h.service.snapshot().accounts[0].oldSignInLeft).toBe('kept')
    expect((await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })).ok).toBe(true)
    // The old one cannot be signed out: refused before the account's own is touched.
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(h.signedIn.get(homeOf(realmIdOf(h, a)))).toBe('chatgpt')
    expect(findAccount(h.doc(), a)!.lifecycle).toBe('inactive')
    refuseOld = false
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })).toEqual({ ok: true })
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('retired')
    expect(h.signedIn.size).toBe(0)
  })

  it('a replacement the old sign-out took with it is checked again and said so: signed out, needing attention', async () => {
    const h = await harness({ script: { logout: () => { h.signedIn.clear(); return { exitCode: 0, stdout: 'Successfully logged out' + NL } } } })
    const a = await addCodexAccount(h, 'A')
    await proveRemoval(h)
    const oldRealm = realmIdOf(h, a)
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-out' })
    expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe('retired')
    expect(findAccount(h.doc(), a)).toMatchObject({ lastKnownAuthState: 'signed-out', operationalState: 'attention' })
  })

  it('an interrupted run recovers: before the switch it is listed and discarded, never named; after it, the next start settles the old realm by the same rule (Q2)', async () => {
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

    // The app closed after the switch, before the old sign-in was settled.
    const moveB = async (hh: H, b: string, tag: string) => {
      const bNew = `realm-${tag.repeat(32)}`
      const bStaged = `acct-${tag.repeat(32)}`
      expect((await hh.store.mutate((d, t) => beginAccountReauth(d, { accountId: bStaged, realmId: bNew, replacesAccountId: b, method: 'browser' }, t))).ok).toBe(true)
      expect((await hh.codex.realmFolders!.prepare({ authRealmId: bNew })).ok).toBe(true)
      hh.signedIn.set(homeOf(bNew), 'chatgpt')
      expect((await hh.store.mutate((d, t) => rebindAccountRealm(d, bStaged, { state: 'signed-in' }, t))).ok).toBe(true)
    }
    const b = await addCodexAccount(again, 'B')
    const bOld = realmIdOf(again, b)
    await moveB(again, b, 'f')
    // Not proven safe: the start settles it into visible recovery, running nothing.
    const third = await harness({ port: again.port, folders: again.folders })
    for (const [home, v] of again.signedIn) third.signedIn.set(home, v)
    expect(findRealm(third.doc(), bOld)!.lifecycle).toBe('retiring')
    await third.service.settleLeftoverSignIns()
    expect(third.runs.filter((r) => r.home.toLowerCase() === homeOf(bOld))).toEqual([])
    expect(findRealm(third.doc(), bOld)!.lifecycle).toBe('recovery')
    expect(third.service.snapshot().accounts.find((x) => x.id === b)).toMatchObject({ oldSignInLeft: 'kept', operationalState: 'attention' })
    // Proven safe: the start signs it out under an operation lease and retires it.
    const c = await addCodexAccount(third, 'C')
    const cOld = realmIdOf(third, c)
    await moveB(third, c, '9')
    const fourth = await harness({ port: third.port, folders: third.folders })
    for (const [home, v] of third.signedIn) fourth.signedIn.set(home, v)
    await proveRemoval(fourth)
    let leased = false
    fourth.leases.subscribe((id) => { if (id === c && fourth.leases.countKind(c, 'operation') > 0) leased = true })
    await fourth.service.settleLeftoverSignIns()
    expect(leased).toBe(true)
    expect(findRealm(fourth.doc(), cOld)!.lifecycle).toBe('retired')
    expect(fourth.signedIn.has(homeOf(cOld))).toBe(false)
    expect(findAccount(fourth.doc(), c)!.operationalState).toBe('ready')
  })

  it('a sign-in the app closed on after it turned out to be someone else is named as a new account at the next start (T3)', async () => {
    const sp = subjectProvider()
    const h = await harness({ authWrap: sp.wrap })
    const a = await addCodexAccount(h, 'A')
    sp.next.subject = 'user-2'
    const r = await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)
    const sep = (r as { separateAccountId: string }).separateAccountId
    const again = await harness({ port: h.port, folders: h.folders, authWrap: sp.wrap })
    for (const [home, v] of h.signedIn) again.signedIn.set(home, v)
    expect(again.service.snapshot().pendingSetups).toEqual([expect.objectContaining({ accountId: sep, state: 'credentials-written' })])
    expect(again.service.snapshot().pendingSetups[0].replacesAccountId).toBeUndefined()
    expect(await again.service.completeSetup({ accountId: sep, identity: { mode: 'new', friendlyName: 'Someone else', colourKey: 'rose' } })).toEqual({ ok: true, accountId: sep })
    expect(again.doc().accounts.map((x) => x.id).sort()).toEqual([a, sep].sort())
  })

  it('a staged sign-in the app left behind is discarded first when the account signs in again', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const stale = `realm-${'d'.repeat(32)}`
    expect((await h.store.mutate((d, t) => beginAccountReauth(d, { accountId: `acct-${'d'.repeat(32)}`, realmId: stale, replacesAccountId: a, method: 'browser' }, t))).ok).toBe(true)
    expect((await h.codex.realmFolders!.prepare({ authRealmId: stale })).ok).toBe(true)
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
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
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'apiKey', secretHandle: issued.handle }, 1)).toEqual({ ok: true, state: 'signed-in' })
    const keyed = h.runs.filter((r) => r.args === 'login --with-api-key').map((r) => r.home.toLowerCase())
    expect(keyed).toEqual([homeOf(oldRealm), homeOf(realmIdOf(h, a))])
    expect(findAccount(h.doc(), a)).toMatchObject({ authMethod: 'apiKey', lastKnownAuthState: 'signed-in' })
  })
})

describe('this computer\'s own sign-in, signed in again in place (design 9.2, last paragraph; review round 1, S2)', () => {
  it('only with the user\'s acknowledgement, and never while anything uses it', async () => {
    const h = await harness()
    const ext = await withExternalHome(h)
    const runs = h.runs.length
    expect(await h.service.signInAgain({ sameAccount: true, accountId: ext, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'acknowledgement-required' })
    expect((await h.service.acquireLaunchLease({ kind: 'session', providerId: 'codex', providerAccountId: ext, ownerId: 's1', acknowledgeRealmOnly: true })).ok).toBe(true)
    expect(await h.service.signInAgain({ sameAccount: true, acknowledgeExternal: true, accountId: ext, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'consumers', consumers: 1 })
    expect(h.runs.length).toBe(runs)
    expect(h.signedIn.get(EXT_HOME.toLowerCase())).toBe('chatgpt')
  })

  it('checks the home, signs it out, signs in again there, and keeps it this computer\'s own (unverified)', async () => {
    const h = await harness()
    const ext = await withExternalHome(h)
    const runs = h.runs.length
    expect(await h.service.signInAgain({ sameAccount: true, acknowledgeExternal: true, accountId: ext, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    const here = h.runs.slice(runs).filter((r) => r.home.toLowerCase() === EXT_HOME.toLowerCase()).map((r) => r.args)
    expect(here[0]).toBe('login status')
    expect(here.indexOf('logout')).toBeLessThan(here.indexOf('login'))
    expect(h.signedIn.get(EXT_HOME.toLowerCase())).toBe('chatgpt')
    expect(findAccount(h.doc(), ext)).toMatchObject({ identityAssurance: 'realm-only', lastKnownAuthState: 'signed-in', operationalState: 'ready', authRealmId: realmIdOf(h, ext) })
    // Never staged: no new realm, no journal.
    expect(h.doc().journals).toEqual([])
    expect(h.doc().realms.filter((r) => r.ownerProviderAccountId === ext)).toHaveLength(1)
  })

  it('a sign-in that fails or is cancelled leaves it signed out, needing attention', async () => {
    const h = await harness({ script: { login: (r) => (r.home.toLowerCase() === EXT_HOME.toLowerCase() ? { exitCode: 1, stderr: 'Login failed' + NL } : (h.signedIn.set(r.home.toLowerCase(), 'chatgpt'), { exitCode: 0, stdout: 'Successfully logged in' + NL })) } })
    const ext = await withExternalHome(h)
    expect((await h.service.signInAgain({ sameAccount: true, acknowledgeExternal: true, accountId: ext, method: 'browser' }, 1)).ok).toBe(false)
    expect(h.signedIn.has(EXT_HOME.toLowerCase())).toBe(false)
    expect(findAccount(h.doc(), ext)).toMatchObject({ lastKnownAuthState: 'signed-out', operationalState: 'attention' })
  })

  it('a home that now holds another kind of sign-in is not touched: blocked until reconciled', async () => {
    const h = await harness()
    const ext = await withExternalHome(h)
    h.signedIn.set(EXT_HOME.toLowerCase(), 'api-key')
    const runs = h.runs.length
    expect(await h.service.signInAgain({ sameAccount: true, acknowledgeExternal: true, accountId: ext, method: 'browser' }, 1)).toMatchObject({ ok: false, code: 'sign-in-changed' })
    expect(h.runs.slice(runs).map((r) => r.args)).toEqual(['login status'])
    expect(h.signedIn.get(EXT_HOME.toLowerCase())).toBe('api-key')
  })

  it('a sign-out there whose result could not be read back leaves it needing a check, never "signed in, ready" (review round 2, L2-1)', async () => {
    let odd = false
    const h = await harness({ script: {
      'logout': (r) => { h.signedIn.delete(r.home.toLowerCase()); if (r.home.toLowerCase() === EXT_HOME.toLowerCase()) odd = true; return { exitCode: 0, stdout: 'Successfully logged out' + NL } },
      'login status': (r) => {
        if (odd && r.home.toLowerCase() === EXT_HOME.toLowerCase()) return { exitCode: 2, stderr: 'error: something odd' + NL }
        return h.signedIn.has(r.home.toLowerCase()) ? { exitCode: 0, stderr: 'Logged in using ChatGPT' + NL } : { exitCode: 1, stderr: 'Not logged in' + NL }
      },
    } })
    const ext = await withExternalHome(h)
    expect((await h.service.signInAgain({ sameAccount: true, acknowledgeExternal: true, accountId: ext, method: 'browser' }, 1)).ok).toBe(false)
    expect(h.signedIn.has(EXT_HOME.toLowerCase())).toBe(false)
    expect(findAccount(h.doc(), ext)).toMatchObject({ lastKnownAuthState: 'unknown', operationalState: 'attention' })
  })

  it('the login port refuses this computer\'s own home without the acknowledgement', async () => {
    const h = await harness()
    const ext = await withExternalHome(h)
    h.signedIn.delete(EXT_HOME.toLowerCase())
    expect(await h.codex.auth!.login({ authRealmId: realmIdOf(h, ext) }, 'browser', {})).toMatchObject({ ok: false, code: 'external-realm' })
  })
})

describe('a realm an account moved off is only checked or signed out (review round 1, T2)', () => {
  it('a sign-in, launch, usage read, sessions folder or folder change never reaches it, retiring or in recovery', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    const oldSessions = `${managedHome(oldRealm)}\\sessions`
    // The account moved by hand: its old realm is left retiring.
    const stagedId = `acct-${'c'.repeat(32)}`
    const next = `realm-${'c'.repeat(32)}`
    expect((await h.store.mutate((d, t) => beginAccountReauth(d, { accountId: stagedId, realmId: next, replacesAccountId: a, method: 'browser' }, t))).ok).toBe(true)
    expect((await h.codex.realmFolders!.prepare({ authRealmId: next })).ok).toBe(true)
    h.signedIn.set(homeOf(next), 'chatgpt')
    expect((await h.store.mutate((d, t) => rebindAccountRealm(d, stagedId, { state: 'signed-in' }, t))).ok).toBe(true)
    for (const lifecycle of ['retiring', 'recovery'] as const) {
      if (lifecycle === 'recovery') expect((await h.store.mutate((d, t) => settleSupersededRealm(d, oldRealm, 'recovery', t))).ok).toBe(true)
      expect(findRealm(h.doc(), oldRealm)!.lifecycle).toBe(lifecycle)
      const ref = { authRealmId: oldRealm }
      const runs = h.runs.length
      expect(await h.codex.auth!.login(ref, 'browser', {}), lifecycle).toMatchObject({ ok: false, code: 'realm-unavailable' })
      expect(await h.codex.launch!.prepare(ref), lifecycle).toMatchObject({ ok: false, code: 'realm-unavailable' })
      expect(await h.codex.launch!.sessionsDir!(ref), lifecycle).toBeNull()
      const read = await h.codex.usage!.read!(ref, { mayStart: () => true })
      await read.ended
      expect(read.outcome, lifecycle).toEqual({ ok: false, failure: 'refused' })
      expect(await h.codex.realmFolders!.prepare(ref), lifecycle).toMatchObject({ ok: false, code: 'realm-unavailable' })
      expect(await h.codex.realmFolders!.remove(ref, { contents: 'all' }), lifecycle).toMatchObject({ ok: false, code: 'realm-unavailable' })
      expect(h.runs.length, lifecycle).toBe(runs)
      // The sessions scans name only the account's own folder.
      expect((await h.service.sessionsRoots('codex'))!.map((x) => x.dir), lifecycle).not.toContain(oldSessions)
      expect(await h.service.sessionsDirs('codex'), lifecycle).not.toContain(oldSessions)
      // Its status still reads.
      expect(await h.codex.auth!.status(ref), lifecycle).toMatchObject({ ok: true, state: 'signed-in' })
    }
    expect(await h.codex.auth!.logout({ authRealmId: oldRealm })).toMatchObject({ ok: true, state: 'signed-out' })
  })
})

describe('a provider that reports a subject (WP1.52, WP1.53)', () => {
  it('records it at setup, and keeps it when the same account signs in again', async () => {
    const sp = subjectProvider()
    const h = await harness({ authWrap: sp.wrap })
    const a = await addCodexAccount(h, 'A')
    expect(findAccount(h.doc(), a)).toMatchObject({ providerSubject: 'user-1', providerAuthorityId: 'auth.example' })
    const oldRealm = realmIdOf(h, a)
    expect(await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)).toEqual({ ok: true, state: 'signed-in' })
    expect(realmIdOf(h, a)).not.toBe(oldRealm)
    // Its old sign-in is kept (removal not proven safe): attention, not a block.
    expect(findAccount(h.doc(), a)).toMatchObject({ providerSubject: 'user-1', operationalState: 'attention' })
  })

  it('someone else becomes a separate account for the user to name; this one keeps its own sign-in, untouched', async () => {
    const sp = subjectProvider()
    const h = await harness({ authWrap: sp.wrap })
    const a = await addCodexAccount(h, 'A')
    const oldRealm = realmIdOf(h, a)
    const before = JSON.stringify(findAccount(h.doc(), a))
    sp.next.subject = 'user-2'
    const r = await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)
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
    const r = await h.service.signInAgain({ sameAccount: true, accountId: a, method: 'browser' }, 1)
    expect(r).toMatchObject({ ok: false, code: 'subject-conflict' })
    // Said as it is: that sign-in is another account here already.
    expect((r as { message: string }).message).toMatch(/already another account/)
    expect(JSON.stringify(h.doc().accounts)).toBe(before)
    expect(h.doc().realms).toHaveLength(realms)
    expect(h.doc().journals).toEqual([])
  })
})
