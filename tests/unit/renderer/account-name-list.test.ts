// tests/unit/renderer/account-name-list.test.ts
import { describe, it, expect } from 'vitest'
import { buildNameableAccounts } from '../../../src/renderer/lib/account-name-list'
import type { AccountProfile } from '../../../src/shared/account-types'

function profile(over: Partial<AccountProfile> & { id: string; accountEmail: string }): AccountProfile {
  return {
    name: '',
    createdAt: 0,
    ...over,
  }
}

describe('buildNameableAccounts', () => {
  it('returns one entry per profile, carrying its name + email + id', () => {
    const profiles = [
      profile({ id: 'p1', accountEmail: 'work@example.com', name: 'Work' }),
      profile({ id: 'p2', accountEmail: 'home@example.com', name: 'Home' }),
    ]
    const out = buildNameableAccounts(profiles, [], undefined)
    expect(out).toEqual([
      { email: 'work@example.com', profileId: 'p1', currentName: 'Work' },
      { email: 'home@example.com', profileId: 'p2', currentName: 'Home' },
    ])
  })

  it('adds session-only emails with their alias as currentName', () => {
    const aliases = { 'solo@example.com': 'My Solo' }
    const out = buildNameableAccounts([], ['solo@example.com'], aliases)
    expect(out).toEqual([
      { email: 'solo@example.com', profileId: undefined, currentName: 'My Solo' },
    ])
  })

  it('adds session-only emails with empty currentName when unaliased', () => {
    const out = buildNameableAccounts([], ['solo@example.com'], undefined)
    expect(out).toEqual([
      { email: 'solo@example.com', profileId: undefined, currentName: '' },
    ])
  })

  it('a session email matching a profile yields only the profile entry (no dup)', () => {
    const profiles = [profile({ id: 'p1', accountEmail: 'work@example.com', name: 'Work' })]
    const out = buildNameableAccounts(profiles, ['work@example.com'], undefined)
    expect(out).toEqual([
      { email: 'work@example.com', profileId: 'p1', currentName: 'Work' },
    ])
  })

  it('matches profile vs session email by canonical (case/whitespace-insensitive)', () => {
    const profiles = [profile({ id: 'p1', accountEmail: 'Work@Example.com', name: 'Work' })]
    const out = buildNameableAccounts(profiles, ['  work@example.com '], undefined)
    expect(out).toEqual([
      { email: 'Work@Example.com', profileId: 'p1', currentName: 'Work' },
    ])
  })

  it('de-dupes session-only emails that differ only by canonical form', () => {
    const out = buildNameableAccounts([], ['A@x.com', 'a@x.com'], undefined)
    expect(out).toHaveLength(1)
    expect(out[0].email).toBe('A@x.com')
    expect(out[0].profileId).toBeUndefined()
  })

  it('looks up an alias by the canonical key for a session-only email', () => {
    const aliases = { 'a@x.com': 'Alpha' }
    const out = buildNameableAccounts([], ['A@x.com'], aliases)
    expect(out).toEqual([
      { email: 'A@x.com', profileId: undefined, currentName: 'Alpha' },
    ])
  })

  it('orders profiles first, then session-only emails sorted', () => {
    const profiles = [profile({ id: 'p1', accountEmail: 'zeta@example.com', name: 'Zeta' })]
    const out = buildNameableAccounts(
      profiles,
      ['beta@example.com', 'alpha@example.com'],
      undefined,
    )
    expect(out.map((a) => a.email)).toEqual([
      'zeta@example.com',
      'alpha@example.com',
      'beta@example.com',
    ])
  })

  it('ignores empty / blank session emails', () => {
    const out = buildNameableAccounts([], ['', '   '], undefined)
    expect(out).toEqual([])
  })
})
