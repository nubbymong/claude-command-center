// @vitest-environment jsdom
// P3.6 (row 7's migration, row 20): the account chips read the account's
// identity colour. The email-keyed Claude colour overrides are already carried
// into the identity's colour when the registry mirrors each profile (the
// reconcile's legacy snapshot), so a chip that finds the identity shows it,
// and one that cannot (no account list yet, an email no profile has, or one
// two profiles share: design 19, "migrate only when the email resolves
// uniquely to exactly one Claude profile") keeps the override path unchanged.
// Nothing here writes or removes an override: the setting stays as the
// backup the chips fall back to.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountsSnapshot, AccountView, IdentityView } from '../../../src/shared/providers'
import type { IdentityColorKey } from '../../../src/shared/identity-colors'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const OVERRIDES: Record<string, IdentityColorKey> = { 'a@x.com': 'rose', 'b@x.com': 'violet' }
const settingsState: any = { settings: { theme: 'dark', accountAliases: {}, accountColourOverrides: OVERRIDES, statusLine: { showAccount: true } } }
const profilesState: any = { profiles: [] }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: (s: any) => unknown) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore, DEFAULT_STATUS_LINE: { showAccount: true } }
})
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => {
  const useAccountProfilesStore: any = (sel: (s: any) => unknown) => sel(profilesState)
  useAccountProfilesStore.getState = () => profilesState
  return { useAccountProfilesStore }
})
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
const gateState: any = { queue: [], restored: [], resolveChoice: vi.fn(), cancelChoice: vi.fn() }
vi.mock('../../../src/renderer/stores/accountGateStore', () => ({ useAccountGateStore: (sel: any) => sel(gateState) }))

const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { chipColourKeyForEmail, chipColourKeyForProfile, uniqueProfileForEmail } = await import('../../../src/renderer/utils/accountChip')
const { resolveIdentityColor } = await import('../../../src/shared/identity-colors')
const { resolveAccountColourKey } = await import('../../../src/shared/account-chip-color')
const { default: SessionRow } = await import('../../../src/renderer/components/sidebar/SessionRow')

const PROFILES = [
  { id: 'p-a', name: 'Ann', accountEmail: 'a@x.com', createdAt: 0 },
  { id: 'p-b', name: '', accountEmail: 'b@x.com', createdAt: 0 },
  // Two profiles with one email: the email names neither.
  { id: 'p-d1', name: '', accountEmail: 'd@x.com', createdAt: 0 },
  { id: 'p-d2', name: '', accountEmail: 'D@X.com', createdAt: 0 },
]
const identity = (id: string, colourKey: string): IdentityView => ({ id, colourKey })
const account = (id: string, identityId: string, over: Partial<AccountView> = {}): AccountView => ({
  id, providerId: 'claude', identityId, lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false,
  authMethod: 'browser', lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted',
  realmLifecycle: 'active', external: false, unverified: false, legacyLinked: true, runningSessions: 0, runningReviews: 0, consumers: 0,
  ...over,
})
// The identity colours differ from the overrides on purpose, so a test can
// tell which one a chip read.
const SNAP: AccountsSnapshot = {
  revision: 1, registry: { mode: 'ready' } as AccountsSnapshot['registry'], providers: [], groups: [],
  identities: [identity('i-a', 'indigo'), identity('i-d1', 'pink'), identity('i-d2', 'plum')],
  // p-b is not mirrored yet (a partial registry): its override stays in use.
  accounts: [account('cl-a', 'i-a', { legacyId: 'p-a' }), account('cl-d1', 'i-d1', { legacyId: 'p-d1' }), account('cl-d2', 'i-d2', { legacyId: 'p-d2' })],
  pendingSetups: [], externalDefaults: [], conflicts: [], reviewerNotices: [],
}
const sources = (snapshot: AccountsSnapshot | null) => ({ profiles: PROFILES, snapshot, overrides: OVERRIDES })

describe('the chip colour comes from the identity (P3.6, row 7)', () => {
  it('an email that belongs to exactly one mirrored profile takes that identity\'s colour, not the override', () => {
    expect(chipColourKeyForEmail('a@x.com', sources(SNAP), 'orchid')).toBe('indigo')
    expect(chipColourKeyForEmail(' A@X.COM ', sources(SNAP), 'orchid')).toBe('indigo')
  })

  it('with no account list, the override path as before (the override is the backup)', () => {
    expect(chipColourKeyForEmail('a@x.com', sources(null), 'orchid')).toBe(resolveAccountColourKey('a@x.com', OVERRIDES, 'orchid'))
    expect(chipColourKeyForEmail('a@x.com', sources(null), 'orchid')).toBe('rose')
  })

  it('a profile the list does not mirror yet (a partial registry) keeps its override', () => {
    expect(chipColourKeyForEmail('b@x.com', sources(SNAP), 'orchid')).toBe('violet')
  })

  it('an email two profiles share names neither: the override path', () => {
    expect(uniqueProfileForEmail('d@x.com', PROFILES)).toBeUndefined()
    expect(chipColourKeyForEmail('d@x.com', sources(SNAP), 'orchid')).toBe('orchid')
  })

  it('an email no profile has, or none at all: the fallback, as before', () => {
    expect(chipColourKeyForEmail('zz@x.com', sources(SNAP), 'orchid')).toBe('orchid')
    expect(chipColourKeyForEmail(undefined, sources(SNAP), 'orchid')).toBe('orchid')
    expect(chipColourKeyForEmail(undefined, sources(SNAP), undefined)).toBe('mauve')
  })

  it('a profile known by id (the launch gate) takes its own identity, even when its email is shared', () => {
    expect(chipColourKeyForProfile(PROFILES[2] as never, sources(SNAP))).toBe('pink')
    expect(chipColourKeyForProfile(PROFILES[3] as never, sources(SNAP))).toBe('plum')
    // Not mirrored, or no list: its override, else its own key.
    expect(chipColourKeyForProfile({ ...PROFILES[1], colourKey: 'lavender' } as never, sources(SNAP))).toBe('violet')
    expect(chipColourKeyForProfile({ id: 'p-z', accountEmail: 'z@x.com', colourKey: 'lavender' } as never, sources(SNAP))).toBe('lavender')
    expect(chipColourKeyForProfile(undefined, sources(SNAP))).toBe('mauve')
  })

  it('an archived account, or an identity colour outside the palette, is not used', () => {
    const snap = { ...SNAP, accounts: [account('cl-a', 'i-a', { legacyId: 'p-a', lifecycle: 'archived' })] }
    expect(chipColourKeyForEmail('a@x.com', sources(snap), 'orchid')).toBe('rose')
    const bad = { ...SNAP, identities: [identity('i-a', 'not-a-colour')] }
    expect(chipColourKeyForEmail('a@x.com', sources(bad), 'orchid')).toBe('rose')
  })

  it('reading the chips changes nothing: the overrides stay as they were', () => {
    const before = JSON.stringify(OVERRIDES)
    chipColourKeyForEmail('a@x.com', sources(SNAP), 'orchid')
    chipColourKeyForProfile(PROFILES[0] as never, sources(SNAP))
    expect(JSON.stringify(OVERRIDES)).toBe(before)
  })
})

describe('the sidebar card reads it (P3.6, row 20)', () => {
  let container: HTMLDivElement
  let root: Root
  const props = {
    isActive: false, needsAttention: false, isRenaming: false, renameValue: '', renameRef: { current: null },
    onRenameChange: () => {}, onRenameFinish: () => {}, onRenameCancel: () => {}, onClick: () => {}, onContextMenu: () => {},
  }
  const session = { id: 's1', label: 'web', model: 'sonnet', identityColorKey: 'mauve', color: '', status: 'idle', createdAt: 0, provider: 'claude', sessionType: 'local', accountEmail: 'a@x.com', accountColour: 'orchid' }
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    profilesState.profiles = PROFILES
  })
  afterEach(() => {
    act(() => root.unmount()); container.remove()
    useProviderAccountsStore.setState({ snapshot: null, loaded: false })
    profilesState.profiles = []
  })
  const dot = () => (container.querySelector('[data-testid="account-dot"]') as HTMLElement).style.backgroundColor
  const css = (key: IdentityColorKey) => { const el = document.createElement('span'); el.style.backgroundColor = resolveIdentityColor(key, 'dark'); return el.style.backgroundColor }

  it('with the account list, the identity colour; without it, the override', () => {
    useProviderAccountsStore.setState({ snapshot: SNAP, loaded: true })
    act(() => root.render(React.createElement(SessionRow, { ...(props as any), session })))
    expect(dot()).toBe(css('indigo'))
    act(() => root.unmount()); root = createRoot(container)
    useProviderAccountsStore.setState({ snapshot: null, loaded: false })
    act(() => root.render(React.createElement(SessionRow, { ...(props as any), session })))
    expect(dot()).toBe(css('rose'))
  })
})

describe('the launch picker reads it (P3.6, row 7)', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    profilesState.profiles = [{ ...PROFILES[0], isPrimary: true, active: true }, { ...PROFILES[1], active: true }]
    gateState.queue = [{ sessionId: 's1', sessionLabel: 'web', currentProfileId: 'p-a', resolve: () => {} }]
    settingsState.settings = { ...settingsState.settings, lastUsedAccountId: 'p-a' }
  })
  afterEach(() => {
    act(() => root.unmount()); container.remove()
    useProviderAccountsStore.setState({ snapshot: null, loaded: false })
    profilesState.profiles = []
    gateState.queue = []
  })
  const css = (key: IdentityColorKey) => { const el = document.createElement('span'); el.style.backgroundColor = resolveIdentityColor(key, 'dark'); return el.style.backgroundColor }
  const dots = () => Array.from(container.querySelectorAll('span.rounded-full')).map((s) => (s as HTMLElement).style.backgroundColor)

  it('the last-used and the selected dot take the profile\'s identity colour; without the list, its override', async () => {
    const { default: AccountLaunchGate } = await import('../../../src/renderer/components/AccountLaunchGate')
    useProviderAccountsStore.setState({ snapshot: SNAP, loaded: true })
    act(() => root.render(React.createElement(AccountLaunchGate)))
    expect(dots()).toEqual([css('indigo'), css('indigo')])
    act(() => root.unmount()); root = createRoot(container)
    useProviderAccountsStore.setState({ snapshot: null, loaded: false })
    act(() => root.render(React.createElement(AccountLaunchGate)))
    expect(dots()).toEqual([css('rose'), css('rose')])
  })
})
