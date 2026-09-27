// WP1.4, WP1.8 -- WP2 slice 2 (design 6.1, 6.4): Claude's profiles.json as a registry port.
// PURE: the port gets its stores injected (as the composition root does), so
// no profiles.json or settings.json is touched (host quarantine). The strict
// reader itself is covered against real files in registry-fs-port.test.ts
// (VM/CI).
import { describe, it, expect, beforeEach } from 'vitest'
import type { AccountProfile } from '../../src/shared/account-types'
import { createClaudeLegacyAccountsPort } from '../../src/main/providers/claude/legacy-store'
import { createClaudePackage } from '../../src/main/providers/claude'
import type { ClaudeLegacyAccountsIo } from '../../src/main/providers/claude'

const state = {
  profiles: null as AccountProfile[] | null,
  saved: [] as AccountProfile[][],
  settings: { value: null as unknown, outcome: 'absent' as string },
}

/** The same contract the composition root injects, over in-memory state. */
const io: ClaudeLegacyAccountsIo = {
  readProfiles: () => (state.profiles ? state.profiles.map((p) => ({ ...p })) : null),
  updateProfiles: (edit) => {
    if (!state.profiles) return false
    const isRecord = (v: unknown): v is AccountProfile => !!v && typeof v === 'object' && !Array.isArray(v)
    const entries = (state.profiles as unknown[]).map((v) => (isRecord(v) ? { ...v } : v))
    if (edit(entries.filter(isRecord))) { state.profiles = entries as AccountProfile[]; state.saved.push(entries as AccountProfile[]) }
    return true
  },
  readSettings: () => state.settings,
}

const P = (id: string, over: Partial<AccountProfile> = {}): AccountProfile => ({ id, name: `Name ${id}`, accountEmail: `${id}@example.com`, createdAt: 1, ...over })

beforeEach(() => {
  state.profiles = [P('profile-a1', { isPrimary: true }), P('profile-b2'), P('profile-c3', { accountEmail: '' })]
  state.saved = []
  state.settings = { value: null, outcome: 'absent' }
})

describe('reading (strict: unreadable is null, never "no accounts")', () => {
  it('snapshots every profile, with the email overrides applied', () => {
    state.settings = { value: { accountColourOverrides: { 'profile-b2@example.com': 'indigo' } }, outcome: 'ok' }
    const snap = createClaudeLegacyAccountsPort(io).read()
    expect(snap?.map((s) => [s.legacyId, s.isDefault])).toEqual([['profile-a1', true], ['profile-b2', false], ['profile-c3', false]])
    expect(snap?.[1].colourKey).toBe('indigo')
  })

  it('an unreadable profiles.json is null', () => {
    state.profiles = null
    expect(createClaudeLegacyAccountsPort(io).read()).toBeNull()
  })

  it.each(['failed', 'unparseable'])('a settings file that exists but reads as %s is null, so colours are never re-derived without their overrides', (outcome) => {
    state.settings = { value: null, outcome }
    expect(createClaudeLegacyAccountsPort(io).read()).toBeNull()
  })

  it('absent settings or a malformed override map means no overrides, not a failure', () => {
    expect(createClaudeLegacyAccountsPort(io).read()).toHaveLength(3)
    state.settings = { value: { accountColourOverrides: ['x'] }, outcome: 'ok' }
    expect(createClaudeLegacyAccountsPort(io).read()).toHaveLength(3)
  })
})

describe('writing back (design 6.1)', () => {
  const port = () => createClaudeLegacyAccountsPort(io)

  it('a name lands in profiles.json', () => {
    port().apply([{ providerId: 'claude', legacyId: 'profile-b2', field: 'friendlyName', value: 'Office' }])
    expect(state.profiles?.find((p) => p.id === 'profile-b2')?.name).toBe('Office')
  })

  it('the active flag lands, but never deactivates the primary or the last active account', () => {
    port().apply([{ providerId: 'claude', legacyId: 'profile-b2', field: 'lifecycle', value: 'inactive' }])
    expect(state.profiles?.find((p) => p.id === 'profile-b2')?.active).toBe(false)
    port().apply([{ providerId: 'claude', legacyId: 'profile-a1', field: 'lifecycle', value: 'inactive' }])
    expect(state.profiles?.find((p) => p.id === 'profile-a1')?.active).toBeUndefined()
    state.profiles = [P('profile-x1'), P('profile-y2', { active: false })]
    port().apply([{ providerId: 'claude', legacyId: 'profile-x1', field: 'lifecycle', value: 'inactive' }])
    expect(state.profiles?.[0].active).toBeUndefined()
  })

  it('a colour lands on the profile only when it has no email; an email colour stays with the renderer-owned override', () => {
    port().apply([
      { providerId: 'claude', legacyId: 'profile-b2', field: 'colourKey', value: 'rose' },
      { providerId: 'claude', legacyId: 'profile-c3', field: 'colourKey', value: 'rose' },
    ])
    expect(state.profiles?.find((p) => p.id === 'profile-b2')?.colourKey).toBeUndefined()
    expect(state.profiles?.find((p) => p.id === 'profile-c3')?.colourKey).toBe('rose')
  })

  it('writes for other providers, unknown profiles and non-palette colours are ignored; nothing changed means nothing saved', () => {
    port().apply([
      { providerId: 'codex', legacyId: 'profile-b2', field: 'friendlyName', value: 'X' },
      { providerId: 'claude', legacyId: 'profile-zz', field: 'friendlyName', value: 'X' },
      { providerId: 'claude', legacyId: 'profile-c3', field: 'colourKey', value: '#ff0000' },
      { providerId: 'claude', legacyId: 'profile-b2', field: 'friendlyName', value: 'Name profile-b2' },
    ])
    expect(state.saved).toEqual([])
  })

  it('stray hand-edited entries are neither targets nor "another active account", and are written back untouched', () => {
    // `{}` and a record with a bad id would read as "active" to isAccountActive.
    state.profiles = [P('profile-a1', { active: false }), P('profile-b2'), null, 'junk', {}, { id: '../x' }] as unknown as AccountProfile[]
    port().apply([{ providerId: 'claude', legacyId: 'profile-b2', field: 'lifecycle', value: 'inactive' }])
    expect(state.saved).toEqual([])
    port().apply([{ providerId: 'claude', legacyId: 'profile-b2', field: 'friendlyName', value: 'Office' }])
    expect(state.profiles).toEqual([P('profile-a1', { active: false }), P('profile-b2', { name: 'Office' }), null, 'junk', {}, { id: '../x' }])
  })

  it('a name is written in its stored form, and an empty one is never written', () => {
    const rlo = String.fromCodePoint(0x202e)
    port().apply([{ providerId: 'claude', legacyId: 'profile-b2', field: 'friendlyName', value: `  q${rlo}${'x'.repeat(300)}  ` }])
    const name = state.profiles?.find((p) => p.id === 'profile-b2')?.name ?? ''
    expect(name.length).toBeLessThanOrEqual(120)
    expect(name.includes(rlo)).toBe(false)
    expect(name.startsWith(' ')).toBe(false)
    const before = state.saved.length
    port().apply([{ providerId: 'claude', legacyId: 'profile-b2', field: 'friendlyName', value: String.fromCodePoint(0x3164) }])
    expect(state.saved.length).toBe(before)
  })

  it('an unreadable profiles.json throws, so the store knows the writes did not land', () => {
    state.profiles = null
    expect(() => port().apply([{ providerId: 'claude', legacyId: 'profile-b2', field: 'friendlyName', value: 'Office' }])).toThrow(/could not be read/)
  })
})

describe('the Claude package exposes the port (rule R7: reachable from the entry point)', () => {
  it('the package carries the port only when the root injects its stores, and creating it does no I/O', () => {
    let calls = 0
    const counting: ClaudeLegacyAccountsIo = { readProfiles: () => { calls++; return [] }, updateProfiles: () => { calls++; return true }, readSettings: () => { calls++; return { outcome: 'absent', value: null } } }
    expect(createClaudePackage({ legacyAccountsIo: counting }).legacyAccounts?.providerId).toBe('claude')
    expect(createClaudePackage().legacyAccounts).toBeUndefined()
    expect(calls).toBe(0)
  })
})
