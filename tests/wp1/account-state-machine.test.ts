// WP1.15, WP1.16, WP1.42, WP1.47, WP1.61 (design 5.3, 5.5, 5.7, 9.3, 11):
// account lifecycle, provider defaults, setup journals, launch-binding
// resolution, sign-in drift and its explicit reconcile, and the reviewer
// default, as a transition table over the pure registry. No filesystem, no
// process.
import { describe, it, expect } from 'vitest'
import {
  emptyRegistry, checkRegistryInvariants, createIdentity, beginAccountSetup, commitAccountSetup,
  abandonAccountSetup, markSetupCredentialsWritten, setAccountLifecycle, setProviderDefault,
  recordAuthCheck, resolveLaunchBinding, providerDefaultAccount, selectableAccounts,
  reconcileAccountSignIn, setReviewerDefault, chooseReviewerAccount, parseRegistryDoc, linkAccountIdentity,
} from '../../src/shared/providers'
import type { ProviderRegistryDoc, AccountLifecycle } from '../../src/shared/providers'

const hex = (n: number) => n.toString(16).padStart(24, '0')
const idn = (n: number) => `idn-${hex(n)}`
const acct = (n: number) => `acct-${hex(n)}`
const realm = (n: number) => `realm-${hex(n)}`

function ok(r: { ok: true; doc: ProviderRegistryDoc } | { ok: false; code: string; message: string }): ProviderRegistryDoc {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`)
  return r.doc
}

function addCodex(doc: ProviderRegistryDoc, n: number, t = n * 10): ProviderRegistryDoc {
  doc = ok(createIdentity(doc, { id: idn(n), friendlyName: `Account ${n}`, colourKey: 'pink' }, t))
  doc = ok(beginAccountSetup(doc, { accountId: acct(n), realmId: realm(n), providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${realm(n)}` }, t + 1))
  return ok(commitAccountSetup(doc, acct(n), { identityId: idn(n), authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: 'user-asserted' }, t + 2))
}

const two = () => addCodex(addCodex(emptyRegistry(), 1), 2)

describe('setup journals (design 9.3, WP1.47)', () => {
  it('a pending setup reserves the realm but creates no selectable account', () => {
    const doc = ok(beginAccountSetup(emptyRegistry(), { accountId: acct(1), realmId: realm(1), providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${realm(1)}` }, 1))
    expect(doc.accounts).toEqual([])
    expect(doc.realms).toMatchObject([{ id: realm(1), lifecycle: 'pending', ownerProviderAccountId: acct(1) }])
    expect(doc.journals).toMatchObject([{ accountId: acct(1), realmId: realm(1), state: 'pending' }])
    expect(selectableAccounts(doc, 'codex')).toEqual([])
    expect(checkRegistryInvariants(doc)).toEqual([])
  })

  it('commit creates the account, activates the realm and clears the journal', () => {
    const doc = addCodex(emptyRegistry(), 1)
    expect(doc.journals).toEqual([])
    expect(doc.realms[0].lifecycle).toBe('active')
    expect(doc.accounts[0]).toMatchObject({ id: acct(1), providerId: 'codex', lifecycle: 'active', isProviderDefault: true, operationalState: 'ready', authRealmId: realm(1), identityId: idn(1) })
    expect(checkRegistryInvariants(doc)).toEqual([])
  })

  it('abandoning removes the pending realm and journal; a committed account cannot be abandoned', () => {
    let doc = ok(beginAccountSetup(emptyRegistry(), { accountId: acct(1), realmId: realm(1), providerId: 'codex', method: 'apiKey', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${realm(1)}` }, 1))
    doc = ok(abandonAccountSetup(doc, acct(1)))
    expect(doc).toEqual(emptyRegistry())
    expect(abandonAccountSetup(addCodex(emptyRegistry(), 1), acct(1))).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('a journal records that credentials were written, so startup recovery can offer to finish it', () => {
    let doc = ok(beginAccountSetup(emptyRegistry(), { accountId: acct(1), realmId: realm(1), providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${realm(1)}` }, 1))
    doc = ok(markSetupCredentialsWritten(doc, acct(1), 2))
    expect(doc.journals[0]).toMatchObject({ state: 'credentials-written', updatedAt: 2 })
  })

  it('commit refuses an identity that does not exist', () => {
    const doc = ok(beginAccountSetup(emptyRegistry(), { accountId: acct(1), realmId: realm(1), providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${realm(1)}` }, 1))
    expect(commitAccountSetup(doc, acct(1), { identityId: idn(9), authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: 'user-asserted' }, 2)).toMatchObject({ ok: false, code: 'not-found' })
  })
})

describe('provider defaults (design 5.3)', () => {
  it('the first active account of a provider becomes its default; later ones do not', () => {
    const doc = two()
    expect(doc.accounts.map((a) => a.isProviderDefault)).toEqual([true, false])
    expect(providerDefaultAccount(doc, 'codex')?.id).toBe(acct(1))
  })

  it('moving the default is exclusive, and only to an active account', () => {
    let doc = ok(setProviderDefault(two(), acct(2), 50))
    expect(doc.accounts.map((a) => a.isProviderDefault)).toEqual([false, true])
    doc = ok(setAccountLifecycle(doc, acct(1), 'inactive', { consumers: 0 }, 51))
    expect(setProviderDefault(doc, acct(1), 52)).toMatchObject({ ok: false, code: 'lifecycle' })
  })

  it('the default cannot be made inactive while another active account exists and no other default is chosen', () => {
    expect(setAccountLifecycle(two(), acct(1), 'inactive', { consumers: 0 }, 60)).toMatchObject({ ok: false, code: 'default-required' })
  })

  it('the LAST active account may go inactive; the provider then has no default until one is activated', () => {
    let doc = addCodex(emptyRegistry(), 1)
    doc = ok(setAccountLifecycle(doc, acct(1), 'inactive', { consumers: 0 }, 60))
    expect(providerDefaultAccount(doc, 'codex')).toBeNull()
    doc = ok(setAccountLifecycle(doc, acct(1), 'active', { consumers: 0 }, 61))
    expect(providerDefaultAccount(doc, 'codex')?.id).toBe(acct(1))
    expect(checkRegistryInvariants(doc)).toEqual([])
  })
})

describe('lifecycle transition table (design 11, WP1.15, WP1.16)', () => {
  // [from, to, consumers, expected]
  const table: Array<[AccountLifecycle, AccountLifecycle, number, 'ok' | string]> = [
    ['active', 'inactive', 0, 'ok'],
    ['active', 'inactive', 1, 'blocked-by-consumers'],
    ['active', 'archived', 0, 'lifecycle'],
    ['inactive', 'active', 0, 'ok'],
    ['inactive', 'archived', 0, 'ok'],
    ['inactive', 'archived', 2, 'blocked-by-consumers'],
    ['archived', 'active', 0, 'lifecycle'],
    ['archived', 'inactive', 0, 'lifecycle'],
  ]
  for (const [from, to, consumers, expected] of table) {
    it(`${from} -> ${to} with ${consumers} consumer(s): ${expected}`, () => {
      // Account 2 is never the default, so the default rule does not interfere.
      let doc = two()
      if (from !== 'active') doc = ok(setAccountLifecycle(doc, acct(2), 'inactive', { consumers: 0 }, 70))
      if (from === 'archived') doc = ok(setAccountLifecycle(doc, acct(2), 'archived', { consumers: 0 }, 71))
      const r = setAccountLifecycle(doc, acct(2), to, { consumers }, 80)
      if (expected === 'ok') {
        expect(r.ok).toBe(true)
        if (r.ok) {
          expect(r.doc.accounts[1].lifecycle).toBe(to)
          expect(checkRegistryInvariants(r.doc)).toEqual([])
        }
      } else {
        expect(r).toMatchObject({ ok: false, code: expected })
      }
    })
  }

  it('archived and inactive accounts stay resolvable but are not selectable for new work', () => {
    let doc = ok(setAccountLifecycle(two(), acct(2), 'inactive', { consumers: 0 }, 70))
    expect(selectableAccounts(doc, 'codex').map((a) => a.id)).toEqual([acct(1)])
    doc = ok(setAccountLifecycle(doc, acct(2), 'archived', { consumers: 0 }, 71))
    expect(doc.accounts.find((a) => a.id === acct(2))?.lifecycle).toBe('archived')
    expect(selectableAccounts(doc, 'codex').map((a) => a.id)).toEqual([acct(1)])
  })

  it('archiving retires the realm reference without deleting the record', () => {
    let doc = ok(setAccountLifecycle(two(), acct(2), 'inactive', { consumers: 0 }, 70))
    doc = ok(setAccountLifecycle(doc, acct(2), 'archived', { consumers: 0 }, 71))
    expect(doc.realms.find((r) => r.id === realm(2))?.lifecycle).toBe('retired')
  })
})

describe('auth checks (design 5.3, WP1.25)', () => {
  it('signed-out and expired states move the account to attention; signed-in restores ready', () => {
    let doc = ok(recordAuthCheck(two(), acct(1), { state: 'signed-out' }, 90))
    expect(doc.accounts[0]).toMatchObject({ lastKnownAuthState: 'signed-out', operationalState: 'attention', lastValidatedAt: 90 })
    doc = ok(recordAuthCheck(doc, acct(1), { state: 'expired' }, 91))
    expect(doc.accounts[0].operationalState).toBe('attention')
    doc = ok(recordAuthCheck(doc, acct(1), { state: 'signed-in', authMethod: 'apiKey' }, 92))
    expect(doc.accounts[0]).toMatchObject({ lastKnownAuthState: 'signed-in', operationalState: 'ready', authMethod: 'apiKey', lastAuthenticatedAt: 92 })
  })

  it('a different reliable subject on a bound realm BLOCKS the account and rewrites nothing', () => {
    let doc = ok(recordAuthCheck(two(), acct(1), { state: 'signed-in', providerSubject: 'user-a', providerAuthorityId: 'auth.example' }, 90))
    expect(doc.accounts[0]).toMatchObject({ providerSubject: 'user-a', operationalState: 'ready' })
    doc = ok(recordAuthCheck(doc, acct(1), { state: 'signed-in', providerSubject: 'user-b', providerAuthorityId: 'auth.example' }, 91))
    expect(doc.accounts[0]).toMatchObject({ providerSubject: 'user-a', operationalState: 'blocked' })
  })
})

describe('launch binding (design 5.7, WP1.42)', () => {
  it('resolves the exact account, realm and identity', () => {
    const r = resolveLaunchBinding(two(), { providerId: 'codex', providerAccountId: acct(2) })
    expect(r).toEqual({ ok: true, binding: { providerId: 'codex', providerAccountId: acct(2), authRealmId: realm(2), identityId: idn(2) }, realmOnly: false })
  })

  it('rejects a wrong provider, an unknown or malformed account, and a non-active account', () => {
    const doc = two()
    expect(resolveLaunchBinding(doc, { providerId: 'claude', providerAccountId: acct(2) })).toMatchObject({ ok: false, code: 'provider-mismatch' })
    expect(resolveLaunchBinding(doc, { providerId: 'codex', providerAccountId: acct(9) })).toMatchObject({ ok: false, code: 'not-found' })
    expect(resolveLaunchBinding(doc, { providerId: 'codex', providerAccountId: realm(2) })).toMatchObject({ ok: false, code: 'invalid-id' })
    const inactive = ok(setAccountLifecycle(doc, acct(2), 'inactive', { consumers: 0 }, 70))
    expect(resolveLaunchBinding(inactive, { providerId: 'codex', providerAccountId: acct(2) })).toMatchObject({ ok: false, code: 'not-active' })
  })

  it('a blocked account (subject drift) never launches; a signed-out one does, so the genuine CLI can sign in', () => {
    let doc = ok(recordAuthCheck(two(), acct(1), { state: 'signed-in', providerSubject: 'a', providerAuthorityId: 'x' }, 90))
    doc = ok(recordAuthCheck(doc, acct(1), { state: 'signed-in', providerSubject: 'b', providerAuthorityId: 'x' }, 91))
    expect(resolveLaunchBinding(doc, { providerId: 'codex', providerAccountId: acct(1) })).toMatchObject({ ok: false, code: 'blocked' })
    const signedOut = ok(recordAuthCheck(two(), acct(2), { state: 'signed-out' }, 90))
    expect(resolveLaunchBinding(signedOut, { providerId: 'codex', providerAccountId: acct(2) }).ok).toBe(true)
  })

  it('an external unverifiable realm resolves as realm-only, so the caller must require an acknowledgement', () => {
    let doc = ok(createIdentity(emptyRegistry(), { id: idn(1), friendlyName: 'External Codex sign-in -- account unverified', colourKey: 'mauve' }, 1))
    doc = ok(beginAccountSetup(doc, { accountId: acct(1), realmId: realm(1), providerId: 'codex', method: 'external', realmKind: 'codex-home', ownership: 'external-default', pathRef: 'external-default' }, 2))
    doc = ok(commitAccountSetup(doc, acct(1), { identityId: idn(1), authMethod: 'external', lastKnownAuthState: 'signed-in', identityAssurance: 'realm-only' }, 3))
    expect(resolveLaunchBinding(doc, { providerId: 'codex', providerAccountId: acct(1) })).toMatchObject({ ok: true, realmOnly: true })
  })

  it('a realm that is not active never launches, even under an active account (hand edit)', () => {
    for (const lifecycle of ['retiring', 'retired', 'recovery'] as const) {
      const doc = JSON.parse(JSON.stringify(two())) as ProviderRegistryDoc
      doc.realms[1].lifecycle = lifecycle
      expect(resolveLaunchBinding(doc, { providerId: 'codex', providerAccountId: acct(2) }), lifecycle).toMatchObject({ ok: false, code: 'realm-unavailable' })
    }
  })
})

describe('blocked is sticky (design 5.3, adversarial round 1)', () => {
  function blocked(): ProviderRegistryDoc {
    const doc = ok(recordAuthCheck(two(), acct(2), { state: 'signed-in', providerSubject: 'a', providerAuthorityId: 'x' }, 90))
    return ok(recordAuthCheck(doc, acct(2), { state: 'signed-in', providerSubject: 'b', providerAuthorityId: 'x' }, 91))
  }

  it('a later check with the original subject, or a sign-out, does not clear it', () => {
    let doc = ok(recordAuthCheck(blocked(), acct(2), { state: 'signed-in', providerSubject: 'a', providerAuthorityId: 'x' }, 92))
    expect(doc.accounts[1].operationalState).toBe('blocked')
    doc = ok(recordAuthCheck(doc, acct(2), { state: 'signed-out' }, 93))
    expect(doc.accounts[1].operationalState).toBe('blocked')
  })

  it('a blocked account cannot be re-activated or made the default', () => {
    const doc = ok(setAccountLifecycle(blocked(), acct(2), 'inactive', { consumers: 0 }, 94))
    expect(setAccountLifecycle(doc, acct(2), 'active', { consumers: 0 }, 95)).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(setProviderDefault(blocked(), acct(2), 95)).toMatchObject({ ok: false, code: 'lifecycle' })
  })
})

describe('the kind of credential is compared too (design 5.5)', () => {
  it('a realm signed in with an account that now reports an API key (or the reverse) is BLOCKED and its method kept', () => {
    let doc = ok(recordAuthCheck(two(), acct(1), { state: 'signed-in', observedCredential: 'account' }, 90))
    expect(doc.accounts[0]).toMatchObject({ authMethod: 'browser', operationalState: 'ready' })
    doc = ok(recordAuthCheck(doc, acct(1), { state: 'signed-in', observedCredential: 'api-key', authMethod: 'apiKey' }, 91))
    expect(doc.accounts[0]).toMatchObject({ authMethod: 'browser', operationalState: 'blocked' })
    const key = ok(recordAuthCheck(two(), acct(2), { state: 'signed-in', authMethod: 'apiKey' }, 90))
    expect(ok(recordAuthCheck(key, acct(2), { state: 'signed-in', observedCredential: 'account' }, 91)).accounts[1]).toMatchObject({ authMethod: 'apiKey', operationalState: 'blocked' })
  })

  it('a record with no known method compares nothing; an unknown kind is refused', () => {
    const unknown = ok(recordAuthCheck(two(), acct(1), { state: 'signed-in', authMethod: 'unknown' }, 90))
    expect(ok(recordAuthCheck(unknown, acct(1), { state: 'signed-in', observedCredential: 'api-key' }, 91)).accounts[0].operationalState).toBe('ready')
    expect(recordAuthCheck(two(), acct(1), { state: 'signed-in', observedCredential: 'token' as never }, 91)).toMatchObject({ ok: false, code: 'invalid-value' })
  })
})

describe('reconciling a blocked sign-in (design 5.3, 5.5)', () => {
  const subjectBlocked = () => {
    const doc = ok(recordAuthCheck(two(), acct(2), { state: 'signed-in', providerSubject: 'a', providerAuthorityId: 'x' }, 90))
    return ok(recordAuthCheck(doc, acct(2), { state: 'signed-in', providerSubject: 'b', providerAuthorityId: 'x' }, 91))
  }

  it('is the one transition that clears blocked: the reported subject replaces the one on record', () => {
    const doc = ok(reconcileAccountSignIn(subjectBlocked(), acct(2), { state: 'signed-in', providerSubject: 'b', providerAuthorityId: 'x' }, 92))
    expect(doc.accounts[1]).toMatchObject({ providerSubject: 'b', operationalState: 'ready', lastAuthenticatedAt: 92 })
    expect(checkRegistryInvariants(doc)).toEqual([])
    expect(resolveLaunchBinding(doc, { providerId: 'codex', providerAccountId: acct(2) }).ok).toBe(true)
  })

  it('adopts a credential of another kind as the method, keeping a kind to compare next time', () => {
    const blocked = ok(recordAuthCheck(two(), acct(1), { state: 'signed-in', observedCredential: 'api-key' }, 90))
    const keyed = ok(reconcileAccountSignIn(blocked, acct(1), { state: 'signed-in', observedCredential: 'api-key' }, 91))
    expect(keyed.accounts[0]).toMatchObject({ authMethod: 'apiKey', operationalState: 'ready' })
    const back = ok(reconcileAccountSignIn(ok(recordAuthCheck(keyed, acct(1), { state: 'signed-in', observedCredential: 'account' }, 92)), acct(1), { state: 'signed-in', observedCredential: 'account' }, 93))
    expect(back.accounts[0]).toMatchObject({ authMethod: 'browser', operationalState: 'ready' })
    // A signed-out realm is reconciled to attention: someone must sign in.
    expect(ok(reconcileAccountSignIn(blocked, acct(1), { state: 'signed-out' }, 94)).accounts[0]).toMatchObject({ operationalState: 'attention', authMethod: 'browser' })
  })

  it('refuses, leaving it blocked: a status that did not answer, a malformed or half subject, a subject another account holds, an archived account', () => {
    const doc = subjectBlocked()
    for (const state of ['error', 'unknown', 'unsupported'] as const) expect(reconcileAccountSignIn(doc, acct(2), { state }, 92), state).toMatchObject({ ok: false, code: 'invalid-value' })
    expect(reconcileAccountSignIn(doc, acct(2), { state: 'signed-in', providerSubject: 'b' }, 92)).toMatchObject({ ok: false, code: 'invalid-value' })
    expect(reconcileAccountSignIn(doc, acct(2), { state: 'signed-in', providerSubject: ' b', providerAuthorityId: 'x' }, 92)).toMatchObject({ ok: false, code: 'invalid-value' })
    const other = ok(recordAuthCheck(doc, acct(1), { state: 'signed-in', providerSubject: 'b', providerAuthorityId: 'x' }, 92))
    expect(reconcileAccountSignIn(other, acct(2), { state: 'signed-in', providerSubject: 'b', providerAuthorityId: 'x' }, 93)).toMatchObject({ ok: false, code: 'subject-conflict' })
    const archived = ok(setAccountLifecycle(ok(setAccountLifecycle(doc, acct(2), 'inactive', { consumers: 0 }, 94)), acct(2), 'archived', { consumers: 0 }, 95))
    expect(reconcileAccountSignIn(archived, acct(2), { state: 'signed-in' }, 96)).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(reconcileAccountSignIn(doc, acct(9), { state: 'signed-in' }, 96)).toMatchObject({ ok: false, code: 'not-found' })
  })
})

describe('the reviewer default (plan: provider review through MCP)', () => {
  it('at most one per provider; choosing another moves it; null clears it', () => {
    let doc = ok(setReviewerDefault(two(), 'codex', acct(2), 90))
    expect(doc.accounts.map((a) => a.isReviewerDefault)).toEqual([undefined, true])
    doc = ok(setReviewerDefault(doc, 'codex', acct(1), 91))
    expect(doc.accounts.map((a) => a.isReviewerDefault)).toEqual([true, undefined])
    expect(checkRegistryInvariants(doc)).toEqual([])
    doc = ok(setReviewerDefault(doc, 'codex', null, 92))
    expect(doc.accounts.every((a) => !('isReviewerDefault' in a))).toBe(true)
  })

  it('only an active, unblocked, vouched-for account of that provider', () => {
    const doc = two()
    expect(setReviewerDefault(doc, 'claude', acct(1), 90)).toMatchObject({ ok: false, code: 'invalid-value' })
    expect(setReviewerDefault(doc, 'codex', acct(9), 90)).toMatchObject({ ok: false, code: 'not-found' })
    expect(setReviewerDefault(doc, 'gemini' as never, acct(1), 90)).toMatchObject({ ok: false, code: 'invalid-value' })
    const inactive = ok(setAccountLifecycle(doc, acct(2), 'inactive', { consumers: 0 }, 90))
    expect(setReviewerDefault(inactive, 'codex', acct(2), 91)).toMatchObject({ ok: false, code: 'lifecycle' })
    const blocked = ok(recordAuthCheck(doc, acct(2), { state: 'signed-in', observedCredential: 'api-key' }, 90))
    expect(setReviewerDefault(blocked, 'codex', acct(2), 91)).toMatchObject({ ok: false, code: 'lifecycle' })
    let ext = ok(createIdentity(emptyRegistry(), { id: idn(1), colourKey: 'mauve' }, 1))
    ext = ok(beginAccountSetup(ext, { accountId: acct(1), realmId: realm(1), providerId: 'codex', method: 'external', realmKind: 'codex-home', ownership: 'external-default', pathRef: 'external-default' }, 2))
    ext = ok(commitAccountSetup(ext, acct(1), { identityId: idn(1), authMethod: 'external', lastKnownAuthState: 'signed-in', identityAssurance: 'realm-only' }, 3))
    expect(setReviewerDefault(ext, 'codex', acct(1), 4)).toMatchObject({ ok: false, code: 'realm-only' })
  })

  it('archiving the reviewer default clears it; the invariants refuse two, or an archived one', () => {
    let doc = ok(setReviewerDefault(two(), 'codex', acct(2), 90))
    doc = ok(setAccountLifecycle(ok(setAccountLifecycle(doc, acct(2), 'inactive', { consumers: 0 }, 91)), acct(2), 'archived', { consumers: 0 }, 92))
    expect('isReviewerDefault' in doc.accounts[1]).toBe(false)
    expect(checkRegistryInvariants(doc)).toEqual([])
    const both = JSON.parse(JSON.stringify(two())) as ProviderRegistryDoc
    both.accounts[0].isReviewerDefault = true
    both.accounts[1].isReviewerDefault = true
    expect(checkRegistryInvariants(both).join()).toMatch(/2 reviewer defaults/)
    const archived = JSON.parse(JSON.stringify(doc)) as ProviderRegistryDoc
    archived.accounts[1].isReviewerDefault = true
    expect(checkRegistryInvariants(archived).join()).toMatch(/reviewer default .* is archived/)
  })

  it('is only ever stored as true, and reads back', () => {
    const doc = ok(setReviewerDefault(two(), 'codex', acct(2), 90))
    expect(parseRegistryDoc(JSON.parse(JSON.stringify(doc)))).toEqual({ ok: true, doc })
    for (const v of [false, 'yes', 1, null]) {
      const bad = JSON.parse(JSON.stringify(doc))
      bad.accounts[0].isReviewerDefault = v
      expect(parseRegistryDoc(bad), String(v)).toMatchObject({ ok: false, reason: 'invalid' })
    }
    // A schema 2 file has no reviewer default: it reads as none chosen.
    expect(parseRegistryDoc({ ...JSON.parse(JSON.stringify(two())), schemaVersion: 2 })).toMatchObject({ ok: true, doc: { schemaVersion: 3 } })
  })

  it('the choice: the named account, else the reviewer default, else the provider default -- never a silent fallback past a chosen one', () => {
    const doc = two()
    expect(chooseReviewerAccount(doc, 'codex', acct(2))).toEqual({ ok: true, accountId: acct(2), source: 'explicit' })
    expect(chooseReviewerAccount(doc, 'codex')).toEqual({ ok: true, accountId: acct(1), source: 'provider-default' })
    const chosen = ok(setReviewerDefault(doc, 'codex', acct(2), 90))
    expect(chooseReviewerAccount(chosen, 'codex')).toEqual({ ok: true, accountId: acct(2), source: 'reviewer-default' })
    // Chosen then made inactive: still chosen, so the binding refuses it.
    const inactive = ok(setAccountLifecycle(chosen, acct(2), 'inactive', { consumers: 0 }, 91))
    expect(chooseReviewerAccount(inactive, 'codex')).toMatchObject({ accountId: acct(2), source: 'reviewer-default' })
    expect(resolveLaunchBinding(inactive, { providerId: 'codex', providerAccountId: acct(2) })).toMatchObject({ ok: false, code: 'not-active' })
    expect(chooseReviewerAccount(emptyRegistry(), 'codex')).toMatchObject({ ok: false, code: 'not-found' })
    expect(chooseReviewerAccount(doc, 'claude')).toMatchObject({ ok: false, code: 'not-found' })
  })
})

describe('ADR-009 round 1 regressions: unverified identities', () => {
  function withExternal(doc: ProviderRegistryDoc, n: number): ProviderRegistryDoc {
    doc = ok(createIdentity(doc, { id: idn(n), colourKey: 'mauve' }, n))
    doc = ok(beginAccountSetup(doc, { accountId: acct(n), realmId: realm(n), providerId: 'codex', method: 'external', realmKind: 'codex-home', ownership: 'external-default', pathRef: 'external-default' }, n + 1))
    return ok(commitAccountSetup(doc, acct(n), { identityId: idn(n), authMethod: 'external', lastKnownAuthState: 'signed-in', identityAssurance: 'realm-only' }, n + 2))
  }

  it('an identity an unverified sign-in shows cannot be joined, by a link or by a setup committed into it', () => {
    const doc = withExternal(two(), 7)
    expect(linkAccountIdentity(doc, acct(1), idn(7), 90)).toMatchObject({ ok: false, code: 'not-linkable' })
    let pending = ok(beginAccountSetup(doc, { accountId: acct(8), realmId: realm(8), providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${realm(8)}` }, 91))
    expect(commitAccountSetup(pending, acct(8), { identityId: idn(7), authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: 'user-asserted' }, 92)).toMatchObject({ ok: false, code: 'not-linkable' })
    // An ordinary identity still links.
    expect(linkAccountIdentity(doc, acct(1), idn(2), 93).ok).toBe(true)
    pending = ok(commitAccountSetup(pending, acct(8), { identityId: idn(2), authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: 'user-asserted' }, 94))
    expect(checkRegistryInvariants(pending)).toEqual([])
  })

  it('the invariants refuse an unverified reviewer default (a hand-edited file)', () => {
    const doc = JSON.parse(JSON.stringify(withExternal(emptyRegistry(), 7))) as ProviderRegistryDoc
    doc.accounts[0].isReviewerDefault = true
    expect(checkRegistryInvariants(doc).join()).toMatch(/reviewer default .* is an unverified sign-in/)
    expect(parseRegistryDoc(doc)).toMatchObject({ ok: false, reason: 'invalid' })
  })
})
