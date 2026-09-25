// WP1.12, WP1.45, WP1.53 (design 5.3, 5.4): uniqueness over the pure registry.
// Canonicalising a real path (case, symlink, junction) happens in the main
// process before a pathRef exists; this suite proves a pathRef is never a path
// at all (a closed grammar tied to the realm's own record), that the registry
// refuses two live realms over one reference and two live accounts over one
// reliable authority-scoped subject, and that it never deduplicates on email.
import { describe, it, expect } from 'vitest'
import {
  emptyRegistry, checkRegistryInvariants, createIdentity, beginAccountSetup, commitAccountSetup,
  recordAuthCheck, setAccountLifecycle, setProviderDefault, parseRegistryDoc, resolveLaunchBinding,
  linkAccountIdentity, realmShapeProblem,
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

interface AddOpts { providerId?: 'claude' | 'codex'; external?: boolean; pathRef?: string; label?: string }

function add(doc: ProviderRegistryDoc, n: number, opts: AddOpts = {}): ProviderRegistryDoc {
  const providerId = opts.providerId ?? 'codex'
  const pathRef = opts.pathRef ?? (opts.external ? 'external-default' : providerId === 'codex' ? `managed:${realm(n)}` : `claude-profile:p${n}`)
  doc = ok(createIdentity(doc, { id: idn(n), friendlyName: `A${n}`, colourKey: 'pink' }, n))
  doc = ok(beginAccountSetup(doc, { accountId: acct(n), realmId: realm(n), providerId, method: 'browser', realmKind: providerId === 'codex' ? 'codex-home' : 'claude-config-home', ownership: opts.external ? 'external-default' : 'conductor-managed', pathRef }, n))
  return ok(commitAccountSetup(doc, acct(n), { identityId: idn(n), authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: opts.external ? 'realm-only' : 'user-asserted', providerLabel: opts.label }, n))
}

const begin = (doc: ProviderRegistryDoc, n: number, over: Record<string, unknown>) => beginAccountSetup(doc, {
  accountId: acct(n), realmId: realm(n), providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${realm(n)}`, ...over,
} as Parameters<typeof beginAccountSetup>[1], n)

describe('one realm per canonical path (WP1.45)', () => {
  it('a second live realm over the same pathRef is refused, even while the first is still pending', () => {
    const pending = ok(begin(emptyRegistry(), 1, { ownership: 'external-default', pathRef: 'external-default' }))
    expect(begin(pending, 2, { ownership: 'external-default', pathRef: 'external-default' })).toMatchObject({ ok: false, code: 'realm-conflict' })
  })

  it('the same pathRef under a DIFFERENT provider is a different realm', () => {
    const doc = add(add(emptyRegistry(), 1, { external: true }), 2, { providerId: 'claude', external: true })
    expect(doc.realms.map((r) => r.pathRef)).toEqual(['external-default', 'external-default'])
    expect(checkRegistryInvariants(doc)).toEqual([])
  })

  it('an archived account releases its pathRef, so the home can be registered again', () => {
    let doc = add(add(emptyRegistry(), 1, { external: true }), 2)
    doc = ok(setProviderDefault(doc, acct(2), 3))
    doc = ok(setAccountLifecycle(doc, acct(1), 'inactive', { consumers: 0 }, 4))
    doc = ok(setAccountLifecycle(doc, acct(1), 'archived', { consumers: 0 }, 5))
    expect(begin(doc, 3, { ownership: 'external-default', pathRef: 'external-default' }).ok).toBe(true)
  })
})

describe('a pathRef is a closed grammar, never a path (design 5.4)', () => {
  const refused = [
    'C:\\Users\\victim\\.claude', '\\\\attacker.example\\share', '/etc/passwd', 'https://evil.example/login', 'file:///C:/x',
    'managed:..\\..\\Users\\victim', `managed:${realm(1)}/.`, `MANAGED:${realm(1)}`, 'External-Default', '%USERPROFILE%\\.codex',
  ]
  for (const pathRef of refused) {
    it(`a managed Codex realm refuses ${JSON.stringify(pathRef)}`, () => {
      expect(begin(emptyRegistry(), 1, { pathRef })).toMatchObject({ ok: false, code: 'invalid-value' })
    })
  }

  it("a managed realm must name its OWN id -- never another realm's directory, live or retired", () => {
    let doc = add(add(emptyRegistry(), 1), 2)
    doc = ok(setAccountLifecycle(doc, acct(2), 'inactive', { consumers: 0 }, 3))
    doc = ok(setAccountLifecycle(doc, acct(2), 'archived', { consumers: 0 }, 4))
    expect(begin(doc, 3, { pathRef: `managed:${realm(2)}` })).toMatchObject({ ok: false, code: 'invalid-value' })
    expect(begin(doc, 3, { pathRef: `managed:${realm(1)}` })).toMatchObject({ ok: false, code: 'invalid-value' })
  })

  it('an external realm is exactly the external default home; a Claude realm names a valid profile id', () => {
    expect(begin(emptyRegistry(), 1, { ownership: 'external-default', pathRef: `managed:${realm(1)}` }).ok).toBe(false)
    expect(begin(emptyRegistry(), 1, { ownership: 'conductor-managed', pathRef: 'external-default' }).ok).toBe(false)
    const claude = { providerId: 'claude', realmKind: 'claude-config-home' }
    for (const bad of ['claude-profile:..', 'claude-profile:.', 'claude-profile:Profile-A1', 'claude-profile:profile-a1.', 'claude-profile:', 'profile-a1']) {
      expect(begin(emptyRegistry(), 1, { ...claude, pathRef: bad }), bad).toMatchObject({ ok: false, code: 'invalid-value' })
    }
    // Even a well-formed profile home is never set up by hand: only its own
    // profile registers it (reconcile), so no account can borrow one.
    expect(begin(emptyRegistry(), 1, { ...claude, pathRef: 'claude-profile:profile-a1' })).toMatchObject({ ok: false, code: 'legacy-owned' })
  })

  it('a realm kind belongs to one provider', () => {
    expect(realmShapeProblem({ id: realm(1), providerId: 'codex', kind: 'claude-config-home', ownership: 'conductor-managed', pathRef: 'claude-profile:p1' })).toMatch(/cannot belong/)
    expect(begin(emptyRegistry(), 1, { realmKind: 'claude-config-home', pathRef: 'claude-profile:p1' }).ok).toBe(false)
  })

  it('an external Claude home is the one realm-only Claude realm that setup may create', () => {
    const doc = add(emptyRegistry(), 1, { providerId: 'claude', external: true })
    expect(resolveLaunchBinding(doc, { providerId: 'claude', providerAccountId: acct(1) })).toMatchObject({ ok: true, realmOnly: true })
  })

  it('a hand-edited registry.json carrying a path, or two realms swapped onto each other, is rejected on read', () => {
    const base = JSON.parse(JSON.stringify(add(add(emptyRegistry(), 1), 2)))
    expect(parseRegistryDoc(base).ok).toBe(true)
    const pathy = JSON.parse(JSON.stringify(base))
    pathy.realms[0].pathRef = 'C:\\Users\\victim\\.codex'
    expect(parseRegistryDoc(pathy)).toMatchObject({ ok: false, reason: 'invalid' })
    const swapped = JSON.parse(JSON.stringify(base))
    ;[swapped.realms[0].pathRef, swapped.realms[1].pathRef] = [swapped.realms[1].pathRef, swapped.realms[0].pathRef]
    expect(parseRegistryDoc(swapped)).toMatchObject({ ok: false, reason: 'invalid' })
  })
})

describe('realm-only follows the realm, not a caller-set field (design 5.7)', () => {
  it('the external default home cannot be committed as vouched-for', () => {
    const doc = ok(begin(emptyRegistry(), 1, { ownership: 'external-default', pathRef: 'external-default' }))
    const withIdn = ok(createIdentity(doc, { id: idn(1), colourKey: 'pink' }, 1))
    for (const identityAssurance of ['user-asserted', 'verified-subject'] as const) {
      expect(commitAccountSetup(withIdn, acct(1), { identityId: idn(1), authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance, providerSubject: 's', providerAuthorityId: 'a' }, 2)).toMatchObject({ ok: false, code: 'invalid-value' })
    }
  })

  it('a hand edit that vouches for the external home fails the invariants; the binding still says realm-only', () => {
    const doc = add(emptyRegistry(), 1, { external: true })
    expect(resolveLaunchBinding(doc, { providerId: 'codex', providerAccountId: acct(1) })).toMatchObject({ ok: true, realmOnly: true })
    const edited = JSON.parse(JSON.stringify(doc)) as ProviderRegistryDoc
    edited.accounts[0].identityAssurance = 'user-asserted'
    expect(checkRegistryInvariants(edited).join('\n')).toMatch(/not realm-only/)
    expect(parseRegistryDoc(edited).ok).toBe(false)
    // Even handed the edited document directly, the binding derives from the realm.
    expect(resolveLaunchBinding(edited, { providerId: 'codex', providerAccountId: acct(1) })).toMatchObject({ ok: true, realmOnly: true })
    expect(linkAccountIdentity(edited, acct(1), idn(1), 5)).toMatchObject({ ok: false, code: 'not-linkable' })
  })

  it('verified-subject needs the subject and authority it claims', () => {
    const doc = ok(createIdentity(ok(begin(emptyRegistry(), 1, {})), { id: idn(1), colourKey: 'pink' }, 1))
    expect(commitAccountSetup(doc, acct(1), { identityId: idn(1), authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: 'verified-subject' }, 2)).toMatchObject({ ok: false, code: 'invalid-value' })
    expect(commitAccountSetup(doc, acct(1), { identityId: idn(1), authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: 'verified-subject', providerSubject: 's', providerAuthorityId: 'a' }, 2).ok).toBe(true)
  })
})

describe('reliable subjects (WP1.45, WP1.53)', () => {
  it('a second live account reporting a subject another account holds is BLOCKED, never adopted', () => {
    let doc = add(add(emptyRegistry(), 1), 2)
    doc = ok(recordAuthCheck(doc, acct(1), { state: 'signed-in', providerSubject: 'user-a', providerAuthorityId: 'auth.example' }, 10))
    doc = ok(recordAuthCheck(doc, acct(2), { state: 'signed-in', providerSubject: 'user-a', providerAuthorityId: 'auth.example' }, 11))
    expect(doc.accounts[1]).toMatchObject({ operationalState: 'blocked', lastKnownAuthState: 'signed-in' })
    expect(doc.accounts[1].providerSubject).toBeUndefined()
    expect(resolveLaunchBinding(doc, { providerId: 'codex', providerAccountId: acct(2) })).toMatchObject({ ok: false, code: 'blocked' })
    // Later checks still record (the account is not stuck), and it stays blocked.
    doc = ok(recordAuthCheck(doc, acct(2), { state: 'expired' }, 12))
    expect(doc.accounts[1]).toMatchObject({ operationalState: 'blocked', lastKnownAuthState: 'expired' })
    expect(checkRegistryInvariants(doc)).toEqual([])
  })

  it('the same subject under a different authority is a different upstream account', () => {
    let doc = add(add(emptyRegistry(), 1), 2)
    doc = ok(recordAuthCheck(doc, acct(1), { state: 'signed-in', providerSubject: 'user-a', providerAuthorityId: 'tenant-1' }, 10))
    doc = ok(recordAuthCheck(doc, acct(2), { state: 'signed-in', providerSubject: 'user-a', providerAuthorityId: 'tenant-2' }, 11))
    expect(doc.accounts.map((a) => a.operationalState)).toEqual(['ready', 'ready'])
  })

  it('without a reliable authority there is no automatic deduplication at all', () => {
    let doc = add(add(emptyRegistry(), 1), 2)
    doc = ok(recordAuthCheck(doc, acct(1), { state: 'signed-in', providerSubject: 'user-a' }, 10))
    const r = recordAuthCheck(doc, acct(2), { state: 'signed-in', providerSubject: 'user-a' }, 11)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc.accounts[1]).toMatchObject({ operationalState: 'ready' })
    if (r.ok) expect(r.doc.accounts[1].providerSubject).toBeUndefined()
  })

  it('once a subject is on record, any report that is not byte-identical blocks -- malformed and partial reports included', () => {
    const base = ok(recordAuthCheck(add(emptyRegistry(), 1), acct(1), { state: 'signed-in', providerSubject: 'user-a', providerAuthorityId: 'auth.example' }, 10))
    const drifts = [
      { providerSubject: 'user-b', providerAuthorityId: 'auth.example' },
      { providerSubject: 'user-b\u200b', providerAuthorityId: 'auth.example' },
      { providerSubject: 'user-a ', providerAuthorityId: 'auth.example' },
      { providerSubject: 'x'.repeat(300), providerAuthorityId: 'auth.example' },
      { providerSubject: 'user-a', providerAuthorityId: '' },
      { providerSubject: 'user-a' },
      { providerAuthorityId: 'auth.example' },
    ]
    for (const d of drifts) {
      const doc = ok(recordAuthCheck(base, acct(1), { state: 'signed-in', ...d }, 11))
      expect(doc.accounts[0].operationalState, JSON.stringify(d)).toBe('blocked')
      expect(doc.accounts[0]).toMatchObject({ providerSubject: 'user-a', providerAuthorityId: 'auth.example' })
    }
    // The same pair, or no subject at all, is not drift.
    expect(ok(recordAuthCheck(base, acct(1), { state: 'signed-in', providerSubject: 'user-a', providerAuthorityId: 'auth.example' }, 11)).accounts[0].operationalState).toBe('ready')
    expect(ok(recordAuthCheck(base, acct(1), { state: 'signed-out' }, 11)).accounts[0].operationalState).toBe('attention')
  })
})

describe('email is display data, never a key (design 4.2, WP1.12)', () => {
  it('the same email on a Claude and a Codex account yields two accounts on two identities', () => {
    const doc = add(add(emptyRegistry(), 1, { providerId: 'claude', external: true, label: 'me@example.com' }), 2, { label: 'me@example.com' })
    expect(doc.accounts.map((a) => a.identityId)).toEqual([idn(1), idn(2)])
    expect(checkRegistryInvariants(doc)).toEqual([])
  })
})

describe('the invariant checker catches every hand-edited inconsistency', () => {
  const base = () => JSON.parse(JSON.stringify(add(add(emptyRegistry(), 1), 2))) as ProviderRegistryDoc
  const cases: Array<[string, (d: ProviderRegistryDoc) => void, RegExp]> = [
    ['duplicate account id', (d) => { d.accounts[1].id = d.accounts[0].id }, /duplicate/],
    ['dangling identity', (d) => { d.accounts[0].identityId = idn(99) }, /identity/],
    ['dangling realm', (d) => { d.accounts[0].authRealmId = realm(99) }, /realm/],
    ['realm owned by another account', (d) => { d.realms[0].ownerProviderAccountId = acct(2) }, /owner/],
    ['realm of another provider', (d) => { d.realms[0].providerId = 'claude' }, /provider/],
    ['two defaults', (d) => { d.accounts[1].isProviderDefault = true }, /default/],
    ['a default that is not active', (d) => { d.accounts[0].lifecycle = 'inactive' }, /default/],
    ['two live realms on one pathRef', (d) => { d.realms[1].pathRef = d.realms[0].pathRef }, /pathRef/],
    ['a managed realm naming another realm', (d) => { d.realms[0].pathRef = `managed:${realm(7)}` }, /its own id/],
    ['a realm kind of another provider', (d) => { d.realms[0].kind = 'claude-config-home' }, /cannot belong/],
    ['an orphan realm still holding a reference', (d) => { d.realms.push({ ...d.realms[0], id: realm(9), pathRef: `managed:${realm(9)}` }) }, /is not its realm/],
    ['a verified account without its subject', (d) => { d.accounts[0].identityAssurance = 'verified-subject' }, /verified without/],
    ['a group reference to nothing', (d) => { d.identities[0].groupId = `grp-${hex(5)}` }, /group/],
    ['a conflict on a record that is not linked', (d) => { d.conflicts.push({ identityId: idn(1), field: 'friendlyName', providerId: 'claude', legacyId: 'profile-x', legacyValue: 'a', registryValue: 'b', detectedAt: 1 }) }, /unlinked legacy record/],
  ]
  for (const [name, mutate, re] of cases) {
    it(name, () => {
      const d = base()
      expect(checkRegistryInvariants(d)).toEqual([])
      mutate(d)
      const problems = checkRegistryInvariants(d)
      expect(problems.length).toBeGreaterThan(0)
      expect(problems.join('\n')).toMatch(re)
    })
  }
})
