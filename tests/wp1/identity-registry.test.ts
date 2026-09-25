// WP1.8, WP1.12, WP1.13, WP1.14, WP1.40 (design 5.1, 5.2): the provider-neutral
// identity registry. Pure -- no filesystem, no process, no real home. Every
// transition here is a function from one registry document to the next.
import { describe, it, expect } from 'vitest'
import {
  emptyRegistry, parseRegistryDoc, checkRegistryInvariants, REGISTRY_SCHEMA_VERSION,
  createIdentity, updateIdentity, createGroup, renameGroup, deleteGroup,
  linkAccountIdentity, unlinkAccountIdentity, beginAccountSetup, commitAccountSetup, normaliseLabel, FRIENDLY_NAME_MAX,
} from '../../src/shared/providers'
import type { ProviderRegistryDoc } from '../../src/shared/providers'

const hex = (n: number) => n.toString(16).padStart(24, '0')
const idn = (n: number) => `idn-${hex(n)}`
const grp = (n: number) => `grp-${hex(n)}`
const acct = (n: number) => `acct-${hex(n)}`
const realm = (n: number) => `realm-${hex(n)}`

function ok(r: { ok: true; doc: ProviderRegistryDoc } | { ok: false; code: string; message: string }): ProviderRegistryDoc {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`)
  return r.doc
}

/** A registry holding one committed Codex account on identity 1. */
function withCodexAccount(doc = emptyRegistry()): ProviderRegistryDoc {
  doc = ok(createIdentity(doc, { id: idn(1), friendlyName: 'Work', colourKey: 'indigo' }, 10))
  doc = ok(beginAccountSetup(doc, { accountId: acct(1), realmId: realm(1), providerId: 'codex', method: 'browser', realmKind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${realm(1)}` }, 11))
  return ok(commitAccountSetup(doc, acct(1), { identityId: idn(1), authMethod: 'browser', lastKnownAuthState: 'signed-in', identityAssurance: 'user-asserted' }, 12))
}

describe('identities (WP1.40)', () => {
  it('creates an identity with a sanitised name and a palette colour', () => {
    const doc = ok(createIdentity(emptyRegistry(), { id: idn(1), friendlyName: '  Work\u202e  ', colourKey: 'pink' }, 5))
    expect(doc.identities).toEqual([{ id: idn(1), friendlyName: 'Work', colourKey: 'pink', createdAt: 5, updatedAt: 5 }])
    expect(checkRegistryInvariants(doc)).toEqual([])
  })

  it('refuses a malformed id, a colour outside the palette and a duplicate id', () => {
    expect(createIdentity(emptyRegistry(), { id: 'idn-XYZ', colourKey: 'pink' }, 1)).toMatchObject({ ok: false, code: 'invalid-id' })
    expect(createIdentity(emptyRegistry(), { id: acct(1), colourKey: 'pink' }, 1)).toMatchObject({ ok: false, code: 'invalid-id' })
    expect(createIdentity(emptyRegistry(), { id: idn(1), colourKey: '#ff0000' }, 1)).toMatchObject({ ok: false, code: 'invalid-value' })
    const one = ok(createIdentity(emptyRegistry(), { id: idn(1), colourKey: 'pink' }, 1))
    expect(createIdentity(one, { id: idn(1), colourKey: 'rose' }, 2)).toMatchObject({ ok: false, code: 'duplicate' })
  })

  it('an empty or all-control name is no name, never an empty label', () => {
    const doc = ok(createIdentity(emptyRegistry(), { id: idn(1), friendlyName: ' \u0007 ', colourKey: 'pink' }, 1))
    expect(doc.identities[0].friendlyName).toBeUndefined()
  })

  it('renaming or recolouring changes the identity only -- never an account, realm or lifecycle', () => {
    const before = withCodexAccount()
    const after = ok(updateIdentity(before, idn(1), { friendlyName: 'Home', colourKey: 'rose' }, 20))
    expect(after.identities[0]).toMatchObject({ friendlyName: 'Home', colourKey: 'rose', updatedAt: 20, createdAt: 10 })
    expect(after.accounts).toEqual(before.accounts)
    expect(after.realms).toEqual(before.realms)
  })

  it('the input document is never mutated', () => {
    const before = withCodexAccount()
    const snapshot = JSON.stringify(before)
    ok(updateIdentity(before, idn(1), { friendlyName: 'Home' }, 20))
    ok(createGroup(before, { id: grp(1), name: 'Work' }, 20))
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('groups (design 5.2)', () => {
  it('assigns, renames and deletes a group; deleting clears the identity reference', () => {
    let doc = withCodexAccount()
    doc = ok(createGroup(doc, { id: grp(1), name: 'Clients' }, 20))
    doc = ok(updateIdentity(doc, idn(1), { groupId: grp(1) }, 21))
    expect(doc.identities[0].groupId).toBe(grp(1))
    doc = ok(renameGroup(doc, grp(1), 'Customers', 22))
    expect(doc.groups[0]).toMatchObject({ name: 'Customers', updatedAt: 22 })
    doc = ok(deleteGroup(doc, grp(1), 23))
    expect(doc.groups).toEqual([])
    expect(doc.identities[0].groupId).toBeUndefined()
    expect(checkRegistryInvariants(doc)).toEqual([])
  })

  it('refuses a reference to a group that does not exist, and an empty group name', () => {
    expect(updateIdentity(withCodexAccount(), idn(1), { groupId: grp(9) }, 1)).toMatchObject({ ok: false, code: 'not-found' })
    expect(createGroup(emptyRegistry(), { id: grp(1), name: '   ' }, 1)).toMatchObject({ ok: false, code: 'invalid-value' })
  })

  it('orders new groups after the existing ones', () => {
    let doc = ok(createGroup(emptyRegistry(), { id: grp(1), name: 'A' }, 1))
    doc = ok(createGroup(doc, { id: grp(2), name: 'B' }, 2))
    expect(doc.groups.map((g) => g.order)).toEqual([0, 1])
  })
})

describe('linking accounts to identities (WP1.12, WP1.13, WP1.14)', () => {
  it('linking shares only the identity: the account keeps its realm, auth state and lifecycle', () => {
    let doc = withCodexAccount()
    doc = ok(createIdentity(doc, { id: idn(2), friendlyName: 'Home', colourKey: 'rose' }, 30))
    const linked = ok(linkAccountIdentity(doc, acct(1), idn(2), 31))
    const a = linked.accounts[0]
    expect(a.identityId).toBe(idn(2))
    expect({ ...a, identityId: doc.accounts[0].identityId, updatedAt: doc.accounts[0].updatedAt }).toEqual(doc.accounts[0])
    // The previous identity is retained: historical records may still name it.
    expect(linked.identities.map((i) => i.id)).toEqual([idn(1), idn(2)])
  })

  it('unlinking gives the account a new private identity copied from the old one, auth untouched', () => {
    const doc = withCodexAccount()
    const out = ok(unlinkAccountIdentity(doc, acct(1), idn(7), 40))
    expect(out.accounts[0].identityId).toBe(idn(7))
    expect(out.identities.find((i) => i.id === idn(7))).toMatchObject({ friendlyName: 'Work', colourKey: 'indigo', createdAt: 40 })
    expect(out.accounts[0].lastKnownAuthState).toBe('signed-in')
    expect(out.realms).toEqual(doc.realms)
  })

  it('an account whose identity cannot be verified (an external realm) is never linked', () => {
    let doc = ok(createIdentity(emptyRegistry(), { id: idn(1), friendlyName: 'External Codex sign-in -- account unverified', colourKey: 'mauve' }, 1))
    doc = ok(createIdentity(doc, { id: idn(2), friendlyName: 'Work', colourKey: 'indigo' }, 1))
    doc = ok(beginAccountSetup(doc, { accountId: acct(1), realmId: realm(1), providerId: 'codex', method: 'external', realmKind: 'codex-home', ownership: 'external-default', pathRef: 'external-default' }, 2))
    doc = ok(commitAccountSetup(doc, acct(1), { identityId: idn(1), authMethod: 'external', lastKnownAuthState: 'signed-in', identityAssurance: 'realm-only' }, 3))
    expect(linkAccountIdentity(doc, acct(1), idn(2), 4)).toMatchObject({ ok: false, code: 'not-linkable' })
  })
})

describe('the registry document (design 6.1, 6.4)', () => {
  it('an empty registry is valid and round-trips through JSON', () => {
    const doc = withCodexAccount()
    const parsed = parseRegistryDoc(JSON.parse(JSON.stringify(doc)))
    expect(parsed).toEqual({ ok: true, doc })
    expect(parseRegistryDoc(emptyRegistry())).toEqual({ ok: true, doc: emptyRegistry() })
  })

  it('a newer schema is reported as such, never guessed at (design 14: recovery mode)', () => {
    expect(parseRegistryDoc({ ...emptyRegistry(), schemaVersion: REGISTRY_SCHEMA_VERSION + 1 })).toMatchObject({ ok: false, reason: 'newer-schema' })
  })

  it('corrupt input fails closed with the problem named', () => {
    expect(parseRegistryDoc(null)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(parseRegistryDoc('{}')).toMatchObject({ ok: false, reason: 'invalid' })
    const bad = JSON.parse(JSON.stringify(withCodexAccount()))
    bad.accounts[0].identityId = idn(99)
    const r = parseRegistryDoc(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems.join('\n')).toMatch(/identity/)
  })

  it('unknown fields are dropped on parse, so nothing unvalidated reaches the renderer', () => {
    const raw = JSON.parse(JSON.stringify(withCodexAccount()))
    raw.accounts[0].accessToken = 'secret'
    raw.identities[0].evil = '<script>'
    const r = parseRegistryDoc(raw)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(JSON.stringify(r.doc)).not.toContain('secret')
      expect(JSON.stringify(r.doc)).not.toContain('<script>')
    }
  })

  it('a parsed name is re-sanitised, so a hand-edited file cannot smuggle a control character to a label', () => {
    const raw = JSON.parse(JSON.stringify(withCodexAccount()))
    raw.identities[0].friendlyName = 'Wo\u001b]8;;http://x\u0007rk'
    const r = parseRegistryDoc(raw)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc.identities[0].friendlyName).not.toMatch(/[\u001b\u0007]/)
  })
})

describe('stored labels carry nothing invisible (adversarial round 1)', () => {
  const cp = (...points: number[]) => String.fromCodePoint(...points)

  it('invisible fillers, variation selectors, format characters and lone surrogates are removed', () => {
    const payload = Array.from({ length: 60 }, (_, i) => cp(0xe0100 + i)).join('')
    expect(normaliseLabel(`Work${payload}`, FRIENDLY_NAME_MAX)).toBe('Work')
    expect(normaliseLabel(`W${cp(0x3164)}o${cp(0x115f)}r${cp(0x2800)}k${cp(0xfe0f)}${cp(0x206a)}${cp(0x034f)}`, FRIENDLY_NAME_MAX)).toBe('Work')
    expect(normaliseLabel(`Wo${String.fromCharCode(0xd800)}rk`, FRIENDLY_NAME_MAX)).toBe('Work')
  })

  it('a name made only of blank-rendering characters is no name', () => {
    expect(normaliseLabel(cp(0x3164, 0x3164, 0x3164), FRIENDLY_NAME_MAX)).toBeUndefined()
    expect(normaliseLabel(cp(0x2800, 0xffa0), FRIENDLY_NAME_MAX)).toBeUndefined()
  })

  it('a combining-mark flood is cut to a few marks per character', () => {
    const out = normaliseLabel(`a${cp(0x301).repeat(119)}`, FRIENDLY_NAME_MAX)
    expect(out).toBe(`a${cp(0x301).repeat(4)}`)
  })

  it('the cap is UTF-16 units (the Claude rename handler\'s unit) and never splits a pair', () => {
    const out = normaliseLabel(cp(0x1f600).repeat(100), FRIENDLY_NAME_MAX)!
    expect(out.length).toBe(120)
    expect(Array.from(out)).toHaveLength(60)
  })

  it('normalising is idempotent', () => {
    const samples = ['  a  b  ', `x${cp(0x301).repeat(9)}y`, cp(0x1f600).repeat(70), `${cp(0x202e)}evil${cp(0x3164)}`, 'plain']
    for (const s of samples) {
      const once = normaliseLabel(s, FRIENDLY_NAME_MAX)
      expect(normaliseLabel(once, FRIENDLY_NAME_MAX)).toBe(once)
    }
  })
})

describe('the parser bounds every number and requires every list (adversarial round 1)', () => {
  const base = () => JSON.parse(JSON.stringify(withCodexAccount()))

  it('a timestamp beyond what a Date can hold, or not an integer, is invalid', () => {
    for (const t of [1e308, 8.64e15 + 1, 1.5, -1]) {
      const raw = base()
      raw.accounts[0].createdAt = t
      expect(parseRegistryDoc(raw).ok, String(t)).toBe(false)
    }
  })

  it('a group order outside the bound is invalid', () => {
    const raw = base()
    raw.groups = [{ id: grp(1), name: 'G', order: 1e308, createdAt: 1, updatedAt: 1 }]
    expect(parseRegistryDoc(raw).ok).toBe(false)
  })

  it('a missing or misspelled list fails closed instead of reading as empty', () => {
    const raw = base()
    raw.providerAccounts = raw.accounts
    delete raw.accounts
    expect(parseRegistryDoc(raw)).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('a colour conflict must name palette colours', () => {
    const raw = base()
    raw.conflicts = [{ identityId: idn(1), field: 'colourKey', providerId: 'claude', legacyId: 'profile-a1', legacyValue: '#ff0000', registryValue: 'pink', detectedAt: 1 }]
    expect(parseRegistryDoc(raw).ok).toBe(false)
  })
})
