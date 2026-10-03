// WP1.8, WP1.9, WP1.4 (design 6.1, 6.2): Claude profiles become provider
// accounts with private identities, deterministically, and the neutral
// registry reconciles with profiles.json field by field. PURE: the snapshot
// builder takes profile records and the colour-override map as values; the
// reconcile takes and returns documents. No profiles.json is read here -- the
// file-backed adapter is exercised on the VM/CI only (host quarantine).
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  emptyRegistry, checkRegistryInvariants, reconcileLegacyAccounts, updateIdentity, findIdentity,
  createIdentity, beginAccountSetup, commitAccountSetup, setProviderDefault, setAccountLifecycle, resolveIdentityConflict,
  recordAuthCheck, parseRegistryDoc, linkAccountIdentity, normaliseLabel, FRIENDLY_NAME_MAX,
} from '../../src/shared/providers'
import type { ProviderRegistryDoc, LegacyAccountSnapshot, OpaqueIdKind } from '../../src/shared/providers'
import { ID_PREFIX } from '../../src/shared/providers'
import { claudeLegacySnapshot } from '../../src/main/providers/claude/legacy-accounts'
import { colourForEmail } from '../../src/main/account-color'
import type { AccountProfile } from '../../src/shared/account-types'

const idFor = (kind: OpaqueIdKind, seed: string) => `${ID_PREFIX[kind]}-${createHash('sha256').update(`${kind}:${seed}`).digest('hex').slice(0, 32)}`
const ctx = (now: number) => ({ now, deterministicId: idFor })

function rec(doc: ProviderRegistryDoc, snap: LegacyAccountSnapshot[], now = 100) {
  const r = reconcileLegacyAccounts(doc, 'claude', snap, ctx(now))
  if (!r.ok) throw new Error(r.problems.join('; '))
  return r
}

const P = (id: string, over: Partial<AccountProfile> = {}): AccountProfile => ({ id, name: `Name ${id}`, accountEmail: `${id}@example.com`, createdAt: 1, ...over })

describe('the Claude legacy snapshot (design 6.2 steps 1-6)', () => {
  it('maps name, colour, active and primary exactly as the existing Claude surfaces show them', () => {
    const snap = claudeLegacySnapshot([
      P('profile-a1', { isPrimary: true, colourKey: 'pink' }),
      P('profile-b2', { active: false, colourKey: 'rose' }),
      P('profile-c3', { accountEmail: '', colourKey: undefined }),
    ], { 'profile-b2@example.com': 'indigo' })
    expect(snap).toEqual([
      expect.objectContaining({ legacyId: 'profile-a1', friendlyName: 'Name profile-a1', colourKey: 'pink', lifecycle: 'active', isDefault: true, providerLabel: 'profile-a1@example.com' }),
      // The email override wins over the profile's own key, as every chip resolves it.
      expect.objectContaining({ legacyId: 'profile-b2', colourKey: 'indigo', lifecycle: 'inactive', isDefault: false }),
      // No email yet (setup incomplete): the fallback colour, and no label.
      expect.objectContaining({ legacyId: 'profile-c3', colourKey: 'mauve', lifecycle: 'active' }),
    ])
    expect(snap[2].providerLabel).toBeUndefined()
    expect(snap[0].realm).toEqual({ kind: 'claude-config-home', ownership: 'conductor-managed', pathRef: 'claude-profile:profile-a1' })
  })

  it('a primary marked inactive by a hand edit is still active (isAccountActive rule)', () => {
    expect(claudeLegacySnapshot([P('profile-a1', { isPrimary: true, active: false })], undefined)[0].lifecycle).toBe('active')
  })

  it('a profile id that is not a safe legacy id is skipped, never migrated', () => {
    expect(claudeLegacySnapshot([P('../evil')], undefined)).toEqual([])
  })
})

describe('first migration (design 6.2, WP1.8, WP1.9)', () => {
  const profiles = () => claudeLegacySnapshot([
    P('profile-a1', { isPrimary: true, colourKey: 'pink' }),
    P('profile-b2', { colourKey: 'rose', accountEmail: 'same@example.com' }),
    P('profile-c3', { colourKey: 'plum', accountEmail: 'same@example.com' }),
  ], undefined)

  it('one account, one realm, one private identity per profile; primary becomes the default', () => {
    const { doc, created } = rec(emptyRegistry(), profiles())
    expect(created).toBe(3)
    expect(doc.accounts.map((a) => [a.providerId, a.isProviderDefault, a.lifecycle])).toEqual([['claude', true, 'active'], ['claude', false, 'active'], ['claude', false, 'active']])
    expect(new Set(doc.accounts.map((a) => a.identityId)).size).toBe(3)
    expect(doc.identities.map((i) => [i.friendlyName, i.colourKey])).toEqual([['Name profile-a1', 'pink'], ['Name profile-b2', 'rose'], ['Name profile-c3', 'plum']])
    expect(checkRegistryInvariants(doc)).toEqual([])
  })

  it('equal emails are never merged (WP1.9, WP1.12)', () => {
    const { doc } = rec(emptyRegistry(), profiles())
    const same = doc.accounts.filter((a) => a.providerLabel === 'same@example.com')
    expect(same).toHaveLength(2)
    expect(same[0].identityId).not.toBe(same[1].identityId)
  })

  it('a rerun is idempotent: same ids, no duplicates, no writes', () => {
    const first = rec(emptyRegistry(), profiles())
    const second = rec(first.doc, profiles(), 200)
    expect(second.created).toBe(0)
    expect(second.writes).toEqual([])
    expect(second.doc.accounts.map((a) => a.id)).toEqual(first.doc.accounts.map((a) => a.id))
    expect(second.doc.identities).toHaveLength(3)
  })

  it('ids are derived from the profile id alone, so a lost registry reattaches rather than duplicates', () => {
    const a = rec(emptyRegistry(), profiles()).doc
    const b = rec(emptyRegistry(), profiles(), 999).doc
    expect(b.accounts.map((x) => x.id)).toEqual(a.accounts.map((x) => x.id))
  })
})

const one = () => claudeLegacySnapshot([P('profile-a1', { isPrimary: true, colourKey: 'pink', name: 'Work' })], undefined)

describe('write-through and import (design 6.1, 6.4)', () => {

  it('a registry rename is written through: reconcile asks for the legacy write until legacy agrees', () => {
    let { doc } = rec(emptyRegistry(), one())
    const idn = doc.accounts[0].identityId
    const u = updateIdentity(doc, idn, { friendlyName: 'Office', colourKey: 'rose' }, 150)
    if (!u.ok) throw new Error(u.message)
    let r = rec(u.doc, one(), 160)
    expect(r.writes).toEqual([
      { providerId: 'claude', legacyId: 'profile-a1', field: 'friendlyName', value: 'Office' },
      { providerId: 'claude', legacyId: 'profile-a1', field: 'colourKey', value: 'rose' },
    ])
    // Nothing is imported back over the pending edit.
    expect(findIdentity(r.doc, idn)).toMatchObject({ friendlyName: 'Office', colourKey: 'rose' })
    // Legacy now agrees (the writes landed): the shadow converges, no more writes.
    const landed = claudeLegacySnapshot([P('profile-a1', { isPrimary: true, colourKey: 'rose', name: 'Office' })], undefined)
    r = rec(r.doc, landed, 170)
    expect(r.writes).toEqual([])
    doc = rec(r.doc, landed, 180).doc
    expect(doc.legacyLinks[0].shadow).toEqual({ friendlyName: 'Office', colourKey: 'rose', lifecycle: 'active' })
  })

  it('an edit made in profiles.json (an older build) is imported into the identity', () => {
    const { doc } = rec(emptyRegistry(), one())
    const edited = claudeLegacySnapshot([P('profile-a1', { isPrimary: true, colourKey: 'plum', name: 'Renamed' })], undefined)
    const r = rec(doc, edited, 200)
    expect(r.imported).toBe(2)
    expect(r.writes).toEqual([])
    expect(findIdentity(r.doc, r.doc.accounts[0].identityId)).toMatchObject({ friendlyName: 'Renamed', colourKey: 'plum' })
  })

  it('both sides edited differently: the registry value is kept and a conflict is recorded, nothing written', () => {
    const { doc } = rec(emptyRegistry(), one())
    const u = updateIdentity(doc, doc.accounts[0].identityId, { friendlyName: 'Mine' }, 150)
    if (!u.ok) throw new Error(u.message)
    const edited = claudeLegacySnapshot([P('profile-a1', { isPrimary: true, colourKey: 'pink', name: 'Theirs' })], undefined)
    const r = rec(u.doc, edited, 200)
    expect(r.writes).toEqual([])
    expect(findIdentity(r.doc, r.doc.accounts[0].identityId)?.friendlyName).toBe('Mine')
    expect(r.doc.conflicts).toMatchObject([{ field: 'friendlyName', legacyValue: 'Theirs', registryValue: 'Mine', legacyId: 'profile-a1' }])
    // Recorded once, not once per reconcile.
    expect(rec(r.doc, edited, 210).doc.conflicts).toHaveLength(1)
  })

  it('active/inactive follows the same three-way rule', () => {
    const two = [P('profile-a1', { isPrimary: true }), P('profile-b2')]
    const { doc } = rec(emptyRegistry(), claudeLegacySnapshot(two, undefined))
    const deactivated = claudeLegacySnapshot([P('profile-a1', { isPrimary: true }), P('profile-b2', { active: false })], undefined)
    const r = rec(doc, deactivated, 200)
    expect(r.doc.accounts[1].lifecycle).toBe('inactive')
    expect(checkRegistryInvariants(r.doc)).toEqual([])
  })

  it('a profile removed from profiles.json archives its account and retires its realm; history stays resolvable', () => {
    const { doc } = rec(emptyRegistry(), claudeLegacySnapshot([P('profile-a1', { isPrimary: true }), P('profile-b2')], undefined))
    const r = rec(doc, claudeLegacySnapshot([P('profile-a1', { isPrimary: true })], undefined), 200)
    expect(r.archived).toBe(1)
    expect(r.doc.accounts[1]).toMatchObject({ lifecycle: 'archived', isProviderDefault: false })
    expect(r.doc.realms[1].lifecycle).toBe('retired')
    expect(r.doc.legacyLinks.map((l) => l.legacyId)).toEqual(['profile-a1'])
    expect(checkRegistryInvariants(r.doc)).toEqual([])
  })

  it('the default follows the legacy primary', () => {
    const { doc } = rec(emptyRegistry(), claudeLegacySnapshot([P('profile-a1', { isPrimary: true }), P('profile-b2')], undefined))
    const moved = claudeLegacySnapshot([P('profile-a1'), P('profile-b2', { isPrimary: true })], undefined)
    const r = rec(doc, moved, 200)
    expect(r.doc.accounts.map((a) => a.isProviderDefault)).toEqual([false, true])
  })

  it('other providers are untouched by a Claude reconcile (WP1.59)', () => {
    const { doc } = rec(emptyRegistry(), one())
    let d = createIdentity(doc, { id: 'idn-' + 'c'.repeat(24), friendlyName: 'Codex', colourKey: 'indigo' }, 250)
    if (!d.ok) throw new Error(d.message)
    d = beginAccountSetup(d.doc, { accountId: 'acct-' + 'c'.repeat(24), realmId: 'realm-' + 'c'.repeat(24), providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: 'managed:realm-' + 'c'.repeat(24) }, 251)
    if (!d.ok) throw new Error(d.message)
    d = commitAccountSetup(d.doc, 'acct-' + 'c'.repeat(24), { identityId: 'idn-' + 'c'.repeat(24), authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: 'user-asserted' }, 252)
    if (!d.ok) throw new Error(d.message)
    const before = JSON.stringify(d.doc.accounts.filter((a) => a.providerId === 'codex'))
    // A Claude snapshot that drops profile-a1 archives that Claude account -- and only that.
    const r = rec(d.doc, claudeLegacySnapshot([P('profile-z9', { isPrimary: true })], undefined), 300)
    expect(JSON.stringify(r.doc.accounts.filter((a) => a.providerId === 'codex'))).toBe(before)
    expect(r.doc.accounts.filter((a) => a.providerId === 'claude').map((a) => a.lifecycle)).toEqual(['archived', 'active'])
    expect(checkRegistryInvariants(r.doc)).toEqual([])
  })
})

describe('existence follows the legacy store, and one bad read never destroys it (adversarial round 1)', () => {
  const two = () => claudeLegacySnapshot([P('profile-a1', { isPrimary: true }), P('profile-b2')], undefined)

  it('an EMPTY snapshot (profiles.json unreadable, mid-write, emptied by hand) changes nothing', () => {
    const { doc } = rec(emptyRegistry(), two())
    const r = rec(doc, [], 200)
    expect(r.doc).toBe(doc)
    expect([r.archived, r.writes.length]).toEqual([0, 0])
    expect(r.warnings.join(' ')).toMatch(/unreadable/)
  })

  it('a snapshot with no USABLE record is the same unreadable store', () => {
    const { doc } = rec(emptyRegistry(), two())
    const r = rec(doc, claudeLegacySnapshot([P('..'), P('Profile-A1')], undefined), 200)
    expect(r.doc).toBe(doc)
  })

  it('a record that comes back restores its archived account and realm, legacy values winning', () => {
    let { doc } = rec(emptyRegistry(), two())
    doc = rec(doc, claudeLegacySnapshot([P('profile-a1', { isPrimary: true })], undefined), 200).doc
    expect(doc.accounts[1].lifecycle).toBe('archived')
    const back = claudeLegacySnapshot([P('profile-a1', { isPrimary: true }), P('profile-b2', { name: 'Back again', active: false })], undefined)
    const r = rec(doc, back, 300)
    expect(r.restored).toBe(1)
    expect(r.doc.accounts[1]).toMatchObject({ lifecycle: 'inactive', isProviderDefault: false })
    expect(r.doc.realms[1].lifecycle).toBe('active')
    expect(findIdentity(r.doc, r.doc.accounts[1].identityId)?.friendlyName).toBe('Back again')
    expect(r.doc.legacyLinks.map((l) => l.legacyId)).toEqual(['profile-a1', 'profile-b2'])
    expect(rec(r.doc, back, 310)).toMatchObject({ writes: [], restored: 0, imported: 0 })
    expect(checkRegistryInvariants(r.doc)).toEqual([])
  })

  it('a registry that lost its links (a hand edit) reattaches by deterministic id, never duplicating', () => {
    const first = rec(emptyRegistry(), two()).doc
    const unlinked = { ...first, legacyLinks: [] }
    const r = rec(unlinked, two(), 200)
    expect(r.created).toBe(0)
    expect(r.doc.accounts.map((a) => a.id)).toEqual(first.accounts.map((a) => a.id))
    expect(r.doc.legacyLinks.map((l) => [l.legacyId, l.accountId])).toEqual(first.legacyLinks.map((l) => [l.legacyId, l.accountId]))
    expect(r.doc.identities).toHaveLength(2)
  })

  it('a removal or deactivation of an account a session holds is deferred, not applied', () => {
    const { doc } = rec(emptyRegistry(), two())
    const b2 = doc.accounts[1].id
    const holding = (id: string) => (id === b2 ? 1 : 0)
    const removed = reconcileLegacyAccounts(doc, 'claude', claudeLegacySnapshot([P('profile-a1', { isPrimary: true })], undefined), { ...ctx(200), consumers: holding })
    if (!removed.ok) throw new Error(removed.problems.join('; '))
    expect([removed.archived, removed.doc.accounts[1].lifecycle, removed.doc.realms[1].lifecycle]).toEqual([0, 'active', 'active'])
    expect(removed.doc.legacyLinks).toHaveLength(2)
    expect(removed.warnings.join(' ')).toMatch(/deferred/)
    const off = reconcileLegacyAccounts(doc, 'claude', claudeLegacySnapshot([P('profile-a1', { isPrimary: true }), P('profile-b2', { active: false })], undefined), { ...ctx(200), consumers: holding })
    if (!off.ok) throw new Error(off.problems.join('; '))
    expect(off.doc.accounts[1].lifecycle).toBe('active')
    // Retried once the session ends: the shadow did not move.
    expect(rec(off.doc, claudeLegacySnapshot([P('profile-a1', { isPrimary: true }), P('profile-b2', { active: false })], undefined), 300).doc.accounts[1].lifecycle).toBe('inactive')
  })

  it('reconcile fails closed: a deterministic id that is another provider\'s account, or a setup in progress, is refused', () => {
    const accountId = idFor('account', 'claude:profile-a1')
    const realmId = idFor('realm', 'claude:profile-a1')
    let d = createIdentity(emptyRegistry(), { id: 'idn-' + 'c'.repeat(24), colourKey: 'indigo' }, 1)
    if (!d.ok) throw new Error(d.message)
    // A setup journal holding the account id the migration would allocate.
    d = beginAccountSetup(d.doc, { accountId, realmId: 'realm-' + 'c'.repeat(24), providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: 'managed:realm-' + 'c'.repeat(24) }, 2)
    if (!d.ok) throw new Error(d.message)
    expect(reconcileLegacyAccounts(d.doc, 'claude', one(), ctx(3))).toMatchObject({ ok: false })
    d = commitAccountSetup(d.doc, accountId, { identityId: 'idn-' + 'c'.repeat(24), authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: 'user-asserted' }, 4)
    if (!d.ok) throw new Error(d.message)
    expect(reconcileLegacyAccounts(d.doc, 'claude', one(), ctx(5))).toMatchObject({ ok: false })
    expect(realmId).not.toBe('realm-' + 'c'.repeat(24))
  })

  it('snapshot records the registry cannot store are skipped with a warning, never half-applied', () => {
    const bad = [
      { ...one()[0], legacyId: 'profile-q1', lifecycle: 'archived' },
      { ...one()[0], legacyId: 'profile-q2', authMethod: 'telepathy' },
      { ...one()[0], legacyId: 'profile-q3', realm: { kind: 'bogus-kind', ownership: 'conductor-managed', pathRef: 'claude-profile:profile-q3' } },
      { ...one()[0], legacyId: 'profile-q4', realm: { kind: 'claude-config-home', ownership: 'conductor-managed', pathRef: 'C:\\Users\\victim' } },
    ] as unknown as LegacyAccountSnapshot[]
    const r = rec(emptyRegistry(), [...one(), ...bad])
    expect(r.created).toBe(1)
    expect(r.warnings).toHaveLength(4)
  })
})

describe('the legacy store owns what it can express (adversarial round 1)', () => {
  const two = () => claudeLegacySnapshot([P('profile-a1', { isPrimary: true }), P('profile-b2')], undefined)

  it('a registry deactivation of a non-primary account is written through until legacy agrees', () => {
    const { doc } = rec(emptyRegistry(), two())
    const off = setAccountLifecycle(doc, doc.accounts[1].id, 'inactive', { consumers: 0 }, 150)
    if (!off.ok) throw new Error(off.message)
    expect(rec(off.doc, two(), 160).writes).toEqual([{ providerId: 'claude', legacyId: 'profile-b2', field: 'lifecycle', value: 'inactive' }])
    const landed = claudeLegacySnapshot([P('profile-a1', { isPrimary: true }), P('profile-b2', { active: false })], undefined)
    expect(rec(off.doc, landed, 170)).toMatchObject({ writes: [], imported: 0 })
  })

  it('with no legacy primary the current default is kept, not reshuffled to the first account', () => {
    const none = () => claudeLegacySnapshot([P('profile-a1'), P('profile-b2')], undefined)
    const edited = JSON.parse(JSON.stringify(rec(emptyRegistry(), none()).doc)) as ProviderRegistryDoc
    edited.accounts[0].isProviderDefault = false
    edited.accounts[1].isProviderDefault = true
    expect(rec(edited, none(), 200).doc.accounts.map((a) => a.isProviderDefault)).toEqual([false, true])
  })

  it('the default is the legacy primary: moving it in the registry is refused, never silently reverted', () => {
    const { doc } = rec(emptyRegistry(), two())
    expect(setProviderDefault(doc, doc.accounts[1].id, 150)).toMatchObject({ ok: false, code: 'legacy-owned' })
  })

  it('the primary cannot be made inactive and a linked account cannot be archived here', () => {
    const { doc } = rec(emptyRegistry(), two())
    expect(setAccountLifecycle(doc, doc.accounts[0].id, 'inactive', { consumers: 0 }, 150)).toMatchObject({ ok: false, code: 'legacy-owned' })
    const off = setAccountLifecycle(doc, doc.accounts[1].id, 'inactive', { consumers: 0 }, 150)
    if (!off.ok) throw new Error(off.message)
    expect(setAccountLifecycle(off.doc, doc.accounts[1].id, 'archived', { consumers: 0 }, 151)).toMatchObject({ ok: false, code: 'legacy-owned' })
  })

  it('a legacy default the registry holds inactive (a hand edit) is imported as active, never written back in a loop', () => {
    const { doc } = rec(emptyRegistry(), two())
    const edited = JSON.parse(JSON.stringify(doc)) as ProviderRegistryDoc
    edited.accounts[0].lifecycle = 'inactive'
    edited.accounts[0].isProviderDefault = false
    edited.accounts[1].isProviderDefault = true
    const r = rec(edited, two(), 200)
    expect(r.writes).toEqual([])
    expect(r.doc.accounts.map((a) => [a.lifecycle, a.isProviderDefault])).toEqual([['active', true], ['active', false]])
  })

  it('a linked identity cannot have its name cleared (the legacy store would hand it straight back)', () => {
    const { doc } = rec(emptyRegistry(), two())
    expect(updateIdentity(doc, doc.accounts[0].identityId, { friendlyName: null }, 150)).toMatchObject({ ok: false, code: 'legacy-owned' })
    expect(updateIdentity(doc, doc.accounts[0].identityId, { friendlyName: '\u3164\u3164' }, 150)).toMatchObject({ ok: false, code: 'legacy-owned' })
  })
})

describe('conflicts are one per field, cleared on convergence, and resolvable (adversarial round 1)', () => {
  function conflicted() {
    const { doc } = rec(emptyRegistry(), one())
    const u = updateIdentity(doc, doc.accounts[0].identityId, { friendlyName: 'Mine' }, 150)
    if (!u.ok) throw new Error(u.message)
    return rec(u.doc, claudeLegacySnapshot([P('profile-a1', { isPrimary: true, colourKey: 'pink', name: 'Theirs' })], undefined), 200).doc
  }
  const theirs = (name = 'Theirs') => claudeLegacySnapshot([P('profile-a1', { isPrimary: true, colourKey: 'pink', name })], undefined)

  it('a moved value replaces the open conflict instead of appending another', () => {
    let doc = conflicted()
    for (const [i, name] of ['Mine 2', 'Mine 3', 'Mine 4'].entries()) {
      const u = updateIdentity(doc, doc.accounts[0].identityId, { friendlyName: name }, 210 + i)
      if (!u.ok) throw new Error(u.message)
      doc = rec(u.doc, theirs(), 220 + i).doc
    }
    expect(doc.conflicts).toMatchObject([{ registryValue: 'Mine 4', legacyValue: 'Theirs' }])
  })

  it('a conflict that converges on its own is cleared', () => {
    const doc = conflicted()
    expect(rec(doc, theirs('Mine'), 300).doc.conflicts).toEqual([])
  })

  it('keeping the registry value writes it through; keeping the legacy value converges at once', () => {
    const doc = conflicted()
    const ref = { identityId: doc.accounts[0].identityId, field: 'friendlyName' as const, providerId: 'claude' as const, legacyId: 'profile-a1' }
    const mine = resolveIdentityConflict(doc, ref, 'registry', 300)
    if (!mine.ok) throw new Error(mine.message)
    expect(mine.doc.conflicts).toEqual([])
    expect(rec(mine.doc, theirs(), 310).writes).toEqual([{ providerId: 'claude', legacyId: 'profile-a1', field: 'friendlyName', value: 'Mine' }])
    const legacy = resolveIdentityConflict(doc, ref, 'legacy', 300)
    if (!legacy.ok) throw new Error(legacy.message)
    expect(findIdentity(legacy.doc, ref.identityId)?.friendlyName).toBe('Theirs')
    expect(rec(legacy.doc, theirs(), 310)).toMatchObject({ writes: [], imported: 0 })
    expect(rec(legacy.doc, theirs(), 310).doc.conflicts).toEqual([])
  })
})

describe('snapshot fidelity (adversarial round 1)', () => {
  it('with no override and no stored key, the colour is the one every session chip shows for that email', () => {
    const snap = claudeLegacySnapshot([P('profile-a1', { accountEmail: 'Someone@Example.com ' })], {})
    expect(snap[0].colourKey).toBe(colourForEmail('someone@example.com'))
  })

  it('override lookups are own-property only: an email named like an Object member is not an override', () => {
    for (const email of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(claudeLegacySnapshot([P('profile-a1', { accountEmail: email })], {})[0].colourKey).toBe(colourForEmail(email))
    }
    expect(claudeLegacySnapshot([P('profile-a1', { accountEmail: 'me@x.io' })], { 'me@x.io': '#ff0000' as never })[0].colourKey).toBe(colourForEmail('me@x.io'))
  })

  it('a primary is read as truthy, exactly as the legacy app reads it', () => {
    expect(claudeLegacySnapshot([P('profile-a1', { isPrimary: 1 as unknown as boolean })], undefined)[0].isDefault).toBe(true)
  })

  it('only ids the profile-id rule accepts are migrated: no dots, no case variants of one directory', () => {
    const ids = ['.', '..', '...', 'PROFILE-A1', 'Profile-A1', 'profile-a1.', '.git', '-rf', '_x', 'con.txt', 'profile-a1']
    expect(claudeLegacySnapshot(ids.map((id) => P(id)), undefined).map((s) => s.legacyId)).toEqual(['profile-a1'])
    expect(rec(emptyRegistry(), ids.map((id) => ({ ...claudeLegacySnapshot([P('profile-a1')], undefined)[0], legacyId: id }))).created).toBe(1)
  })

  it('a hand-edited name cannot smuggle invisible text into an identity', () => {
    const vs = Array.from({ length: 40 }, (_, i) => String.fromCodePoint(0xe0100 + i)).join('')
    const hangul = String.fromCodePoint(0x3164)
    const snap = claudeLegacySnapshot([P('profile-a1', { name: `Wo${hangul}rk${vs}` })], undefined)
    const { doc } = rec(emptyRegistry(), snap)
    expect(doc.identities[0].friendlyName).toBe('Work')
  })

  it('profiles sharing one email share its legacy colour: a recolour lands on both, and they stay two accounts', () => {
    // A colour the email does not already hash to, so the recolour is a change.
    const to = colourForEmail('same@example.com') === 'rose' ? 'pink' : 'rose'
    const snap = (overrides?: Record<string, typeof to>) => claudeLegacySnapshot([
      P('profile-b2', { accountEmail: 'same@example.com', isPrimary: true }), P('profile-c3', { accountEmail: 'same@example.com' }),
    ], overrides)
    const { doc } = rec(emptyRegistry(), snap())
    const u = updateIdentity(doc, doc.accounts[0].identityId, { colourKey: to }, 150)
    if (!u.ok) throw new Error(u.message)
    const w = rec(u.doc, snap(), 160)
    expect(w.writes).toEqual([{ providerId: 'claude', legacyId: 'profile-b2', field: 'colourKey', value: to }])
    const landed = rec(w.doc, snap({ 'same@example.com': to }), 170)
    expect(landed.doc.identities.map((i) => i.colourKey)).toEqual([to, to])
    expect(new Set(landed.doc.accounts.map((a) => a.identityId)).size).toBe(2)
    expect(landed.writes).toEqual([])
  })
})

describe('adversarial round 2: restore, borrowed homes and pinned branches', () => {
  const S = { providerSubject: 'uuid-1', providerAuthorityId: 'claude.ai' }
  const snap = (...ids: string[]) => claudeLegacySnapshot(ids.map((id, i) => P(id, i === 0 ? { isPrimary: true } : {})), undefined)

  it('a restored account forgets who was signed in and needs a fresh check, so a subject taken meanwhile cannot wedge reconcile', () => {
    let doc = rec(emptyRegistry(), snap('profile-a1', 'profile-b2')).doc
    let r1 = recordAuthCheck(doc, doc.accounts[1].id, { state: 'signed-in', ...S }, 110)
    if (!r1.ok) throw new Error(r1.message)
    doc = rec(r1.doc, snap('profile-a1'), 120).doc
    doc = rec(doc, snap('profile-a1', 'profile-c3'), 130).doc
    const c3 = doc.accounts[2].id
    r1 = recordAuthCheck(doc, c3, { state: 'signed-in', ...S }, 140)
    if (!r1.ok) throw new Error(r1.message)
    const r = rec(r1.doc, snap('profile-a1', 'profile-b2', 'profile-c3', 'profile-d4'), 150)
    expect([r.restored, r.created]).toEqual([1, 1])
    const b2 = r.doc.accounts[1]
    expect(b2).toMatchObject({ lifecycle: 'active', lastKnownAuthState: 'unknown', operationalState: 'attention' })
    expect(b2.providerSubject).toBeUndefined()
    expect(checkRegistryInvariants(r.doc)).toEqual([])
    // Its next check reports the subject c3 now holds: it is blocked, not merged.
    const again = recordAuthCheck(r.doc, b2.id, { state: 'signed-in', ...S }, 160)
    if (!again.ok) throw new Error(again.message)
    expect(again.doc.accounts[1].operationalState).toBe('blocked')
  })

  it("a snapshot record that names another profile's home is skipped; the owner keeps it", () => {
    const [a, b] = snap('profile-a1', 'profile-b2')
    const r = rec(emptyRegistry(), [{ ...a, realm: { ...a.realm, pathRef: 'claude-profile:profile-b2' } }, b])
    expect(r.created).toBe(1)
    expect(r.doc.legacyLinks.map((l) => l.legacyId)).toEqual(['profile-b2'])
    expect(r.warnings.join(' ')).toMatch(/another profile's home/)
  })

  it('a hand-edited registry that swaps two Claude homes is rejected on read', () => {
    const raw = JSON.parse(JSON.stringify(rec(emptyRegistry(), snap('profile-a1', 'profile-b2')).doc))
    ;[raw.realms[0].pathRef, raw.realms[1].pathRef] = [raw.realms[1].pathRef, raw.realms[0].pathRef]
    expect(checkRegistryInvariants(raw).join('\n')).toMatch(/not linked to it/)
    expect(parseRegistryDoc(raw).ok).toBe(false)
  })

  it('snapshot records whose assurance does not fit their realm are skipped, not fatal', () => {
    const [good] = snap('profile-a1')
    const bad = [
      { ...good, legacyId: 'profile-q1', realm: { ...good.realm, pathRef: 'claude-profile:profile-q1' }, identityAssurance: 'verified-subject' },
      { ...good, legacyId: 'profile-q2', realm: { kind: 'claude-config-home', ownership: 'external-default', pathRef: 'external-default' }, identityAssurance: 'user-asserted' },
    ] as LegacyAccountSnapshot[]
    const r = rec(emptyRegistry(), [good, ...bad])
    expect([r.created, r.warnings.length]).toEqual([1, 2])
  })

  it('a conflict cannot be resolved for an identity the account was relinked away from', () => {
    const { doc } = rec(emptyRegistry(), one())
    let u = updateIdentity(doc, doc.accounts[0].identityId, { friendlyName: 'Mine' }, 150)
    if (!u.ok) throw new Error(u.message)
    const c = rec(u.doc, claudeLegacySnapshot([P('profile-a1', { isPrimary: true, colourKey: 'pink', name: 'Theirs' })], undefined), 160).doc
    const oldIdn = c.accounts[0].identityId
    u = createIdentity(c, { id: 'idn-' + 'd'.repeat(24), friendlyName: 'Shared', colourKey: 'indigo' }, 170)
    if (!u.ok) throw new Error(u.message)
    u = linkAccountIdentity(u.doc, c.accounts[0].id, 'idn-' + 'd'.repeat(24), 171)
    if (!u.ok) throw new Error(u.message)
    expect(resolveIdentityConflict(u.doc, { identityId: oldIdn, field: 'friendlyName', providerId: 'claude', legacyId: 'profile-a1' }, 'legacy', 180)).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('a registry reactivation of an account legacy deactivated is written through (not reverted)', () => {
    const active = claudeLegacySnapshot([P('profile-a1', { isPrimary: true }), P('profile-b2')], undefined)
    const inactive = claudeLegacySnapshot([P('profile-a1', { isPrimary: true }), P('profile-b2', { active: false })], undefined)
    // Migrated active, then deactivated in legacy: the import moves the shadow.
    const off = rec(rec(emptyRegistry(), active).doc, inactive, 140)
    expect(off.doc.accounts[1].lifecycle).toBe('inactive')
    const on = setAccountLifecycle(off.doc, off.doc.accounts[1].id, 'active', { consumers: 0 }, 150)
    if (!on.ok) throw new Error(on.message)
    const r = rec(on.doc, inactive, 160)
    expect(r.writes).toEqual([{ providerId: 'claude', legacyId: 'profile-b2', field: 'lifecycle', value: 'active' }])
    expect(r.doc.accounts[1].lifecycle).toBe('active')
  })

  it('a blocked account that comes back stays blocked', () => {
    let doc = rec(emptyRegistry(), snap('profile-a1', 'profile-b2')).doc
    for (const [t, subject] of [[110, 'uuid-1'], [111, 'uuid-2']] as const) {
      const r = recordAuthCheck(doc, doc.accounts[1].id, { state: 'signed-in', providerSubject: subject, providerAuthorityId: 'claude.ai' }, t)
      if (!r.ok) throw new Error(r.message)
      doc = r.doc
    }
    expect(doc.accounts[1].operationalState).toBe('blocked')
    doc = rec(doc, snap('profile-a1'), 120).doc
    const back = rec(doc, snap('profile-a1', 'profile-b2'), 130)
    expect(back.restored).toBe(1)
    expect(back.doc.accounts[1]).toMatchObject({ lifecycle: 'active', operationalState: 'blocked' })
  })

  it("a retired realm hand-edited to another profile's home is left archived on return, never wedging reconcile", () => {
    let doc = rec(emptyRegistry(), snap('profile-a1', 'profile-b2')).doc
    doc = rec(doc, snap('profile-a1'), 120).doc
    const edited = JSON.parse(JSON.stringify(doc)) as ProviderRegistryDoc
    edited.realms[1].pathRef = 'claude-profile:profile-c3'
    expect(parseRegistryDoc(edited).ok).toBe(true)
    const r = rec(edited, snap('profile-a1', 'profile-b2', 'profile-d4'), 130)
    expect([r.restored, r.created]).toEqual([0, 1])
    expect(r.doc.accounts[1].lifecycle).toBe('archived')
    expect(r.warnings.join(' ')).toMatch(/not its own/)
  })

  it('a duplicated profile id is migrated once and reported', () => {
    const r = rec(emptyRegistry(), [...snap('profile-a1'), ...snap('profile-a1')])
    expect(r.created).toBe(1)
    expect(r.warnings.join(' ')).toMatch(/duplicate/)
  })

  it('on a lost-link reattach the legacy values win', () => {
    const first = rec(emptyRegistry(), one()).doc
    const renamed = claudeLegacySnapshot([P('profile-a1', { isPrimary: true, colourKey: 'plum', name: 'Renamed' })], undefined)
    const r = rec({ ...first, legacyLinks: [] }, renamed, 200)
    expect(r.writes).toEqual([])
    expect(findIdentity(r.doc, r.doc.accounts[0].identityId)).toMatchObject({ friendlyName: 'Renamed', colourKey: 'plum' })
  })

  it('the invariants reject a link to an archived account and two conflicts on one field', () => {
    const base = rec(emptyRegistry(), snap('profile-a1', 'profile-b2')).doc
    const archived = JSON.parse(JSON.stringify(base)) as ProviderRegistryDoc
    archived.accounts[1].lifecycle = 'archived'
    archived.realms[1].lifecycle = 'retired'
    expect(checkRegistryInvariants(archived).join('\n')).toMatch(/names archived account/)
    const twice = JSON.parse(JSON.stringify(base)) as ProviderRegistryDoc
    const c = { identityId: base.accounts[1].identityId, field: 'friendlyName' as const, providerId: 'claude' as const, legacyId: 'profile-b2', legacyValue: 'x', registryValue: 'y', detectedAt: 1 }
    twice.conflicts = [c, { ...c, legacyValue: 'z' }]
    expect(checkRegistryInvariants(twice).join('\n')).toMatch(/two open conflicts/)
  })

  it('a removal deferred for a running session keeps that record\'s open conflict', () => {
    const two = claudeLegacySnapshot([P('profile-a1', { isPrimary: true }), P('profile-b2', { name: 'Work' })], undefined)
    const { doc } = rec(emptyRegistry(), two)
    const u = updateIdentity(doc, doc.accounts[1].identityId, { friendlyName: 'Mine' }, 150)
    if (!u.ok) throw new Error(u.message)
    const c = rec(u.doc, claudeLegacySnapshot([P('profile-a1', { isPrimary: true }), P('profile-b2', { name: 'Theirs' })], undefined), 160).doc
    expect(c.conflicts).toHaveLength(1)
    const held = reconcileLegacyAccounts(c, 'claude', snap('profile-a1'), { ...ctx(170), consumers: (id) => (id === c.accounts[1].id ? 1 : 0) })
    if (!held.ok) throw new Error(held.problems.join('; '))
    expect(held.doc.conflicts).toEqual(c.conflicts)
  })

  it('default-ignorable code points (the unassigned smuggling ranges too) never reach a name', () => {
    const payload = [0x2065, 0xfff0, 0xfff8, 0xe0200, 0xe0fff].map((p) => String.fromCodePoint(p)).join('')
    expect(normaliseLabel(`Wo${payload}rk`, FRIENDLY_NAME_MAX)).toBe('Work')
  })

  it('a pair straddling the cap is dropped whole, never split', () => {
    expect(normaliseLabel(`${'a'.repeat(119)}${String.fromCodePoint(0x1f600)}`, FRIENDLY_NAME_MAX)).toBe('a'.repeat(119))
  })
})

describe('adversarial round 1, slice 2: each profile keeps its own identity and one stays active', () => {
  const two = () => claudeLegacySnapshot([P('profile-a1', { isPrimary: true }), P('profile-b2')], undefined)

  it('two profiles of one list cannot share an identity (an edit to one would rewrite the other)', () => {
    const { doc } = rec(emptyRegistry(), two())
    expect(linkAccountIdentity(doc, doc.accounts[1].id, doc.accounts[0].identityId, 150)).toMatchObject({ ok: false, code: 'legacy-owned' })
    const edited = JSON.parse(JSON.stringify(doc)) as ProviderRegistryDoc
    edited.accounts[1].identityId = edited.accounts[0].identityId
    expect(checkRegistryInvariants(edited).join('\n')).toMatch(/share identity/)
  })

  it('an account of another provider may still share a profile identity', () => {
    const { doc } = rec(emptyRegistry(), two())
    const codex = 'acct-' + 'e'.repeat(24)
    let d = beginAccountSetup(doc, { accountId: codex, realmId: 'realm-' + 'e'.repeat(24), providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: 'managed:realm-' + 'e'.repeat(24) }, 150)
    if (!d.ok) throw new Error(d.message)
    d = commitAccountSetup(d.doc, codex, { identityId: doc.accounts[0].identityId, authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: 'user-asserted' }, 151)
    expect(d.ok).toBe(true)
    if (d.ok) expect(checkRegistryInvariants(d.doc)).toEqual([])
  })

  it('the last active profile cannot be deactivated here, and a deactivation legacy could not take is imported, not kept pending', () => {
    const none = () => claudeLegacySnapshot([P('profile-a1'), P('profile-b2')], undefined)
    const { doc } = rec(emptyRegistry(), none())
    const off = setAccountLifecycle(doc, doc.accounts[1].id, 'inactive', { consumers: 0 }, 150)
    if (!off.ok) throw new Error(off.message)
    expect(setAccountLifecycle(off.doc, off.doc.accounts[0].id, 'inactive', { consumers: 0 }, 151)).toMatchObject({ ok: false, code: 'legacy-owned' })
    // Before the pending write landed, the user deactivated a1 in Claude:
    // b2 is now the only account Claude would keep active.
    const r = rec(off.doc, claudeLegacySnapshot([P('profile-a1', { active: false }), P('profile-b2')], undefined), 160)
    expect(r.writes).toEqual([])
    expect(r.doc.accounts.map((a) => a.lifecycle)).toEqual(['inactive', 'active'])
    expect(checkRegistryInvariants(r.doc)).toEqual([])
  })
})

describe('adversarial confirmation, slice 2: an archived profile is still a profile', () => {
  it('an archived profile and a live one cannot be linked to one identity in either direction (the archived one may come back)', () => {
    const two = () => claudeLegacySnapshot([P('profile-a1', { isPrimary: true }), P('profile-b2')], undefined)
    let { doc } = rec(emptyRegistry(), two())
    doc = rec(doc, claudeLegacySnapshot([P('profile-a1', { isPrimary: true })], undefined), 150).doc
    expect(doc.accounts[1].lifecycle).toBe('archived')
    expect(linkAccountIdentity(doc, doc.accounts[1].id, doc.accounts[0].identityId, 160)).toMatchObject({ ok: false, code: 'legacy-owned' })
    expect(linkAccountIdentity(doc, doc.accounts[0].id, doc.accounts[1].identityId, 160)).toMatchObject({ ok: false, code: 'legacy-owned' })
    // So the profile coming back never freezes the mirror.
    expect(rec(doc, two(), 170).restored).toBe(1)
  })
})
