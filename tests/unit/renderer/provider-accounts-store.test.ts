// @vitest-environment jsdom
/**
 * providerAccountsStore -- the renderer's copy of the Accounts snapshot.
 *
 * Covers the pure selectors the Accounts surface is built on, and the
 * start-up hydration: one process-lifetime onChanged subscription that keeps
 * the store current, and a fetch that never rolls a newer push back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AccountsSnapshot, AccountView, ProviderInstallationView } from '../../../src/shared/providers'
import {
  selectProviderAccounts, accountDisplayName, reviewerLine, canOfferMakeReviewer, reviewerNotice, showsReviewerBadge,
  accountState, providerStatus, accountFailureText, accountForLegacyId, ACCOUNT_NAME_FALLBACK,
  signInAgainMethods, canOfferMakeInactive, canOfferMakeActive, canOfferArchive,
} from '../../../src/renderer/stores/providerAccountsStore'

// ---------------------------------------------------------------------------
// Fixture

function provider(over: Partial<ProviderInstallationView> & Pick<ProviderInstallationView, 'providerId' | 'displayName'>): ProviderInstallationView {
  const cap = { enabled: true, labelExperimental: false }
  return {
    enabled: true, preference: 'on', discoveryState: 'found', version: '1.0.0', compatibility: 'supported', managedAccounts: over.providerId === 'codex',
    signInMethods: { browser: cap, device: cap, apiKey: cap }, status: cap, logout: cap,
    ...over,
  }
}

function account(over: Partial<AccountView> & Pick<AccountView, 'id' | 'providerId' | 'identityId'>): AccountView {
  return {
    lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false, authMethod: 'browser',
    lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted', realmLifecycle: 'active',
    external: false, unverified: false, legacyLinked: false, runningSessions: 0, runningReviews: 0, consumers: 0,
    ...over,
  }
}

const work = account({ id: 'acc-work', providerId: 'codex', identityId: 'id-work', providerLabel: 'alex@work.example', isProviderDefault: true })
const personal = account({ id: 'acc-personal', providerId: 'codex', identityId: 'id-personal', providerLabel: 'alex@home.example', isReviewerDefault: true, authMethod: 'apiKey' })
const local = account({ id: 'acc-local', providerId: 'codex', identityId: 'id-ext', external: true, unverified: true, authMethod: 'external', identityAssurance: 'realm-only' })
const old = account({ id: 'acc-old', providerId: 'codex', identityId: 'id-old', operationalState: 'blocked' })
const parked = account({ id: 'acc-parked', providerId: 'codex', identityId: 'id-parked', lifecycle: 'inactive' })
const gone = account({ id: 'acc-gone', providerId: 'codex', identityId: 'id-gone', lifecycle: 'archived' })
const claudeMain = account({ id: 'acc-claude-main', providerId: 'claude', identityId: 'id-claude', legacyId: 'profile-primary', legacyLinked: true, isProviderDefault: true })

function snapshot(over: Partial<AccountsSnapshot> = {}): AccountsSnapshot {
  return {
    revision: 1,
    registry: { mode: 'ready' },
    providers: [
      provider({ providerId: 'claude', displayName: 'Claude Code', version: '2.1.281', review: { ready: true, accountId: claudeMain.id, source: 'provider-default' } }),
      provider({ providerId: 'codex', displayName: 'Codex', version: '0.155.1', review: { ready: true, accountId: personal.id, source: 'reviewer-default' } }),
    ],
    identities: [
      { id: 'id-work', friendlyName: 'Work', colourKey: 'indigo' },
      { id: 'id-personal', friendlyName: 'Personal', colourKey: 'pink' },
      { id: 'id-ext', friendlyName: 'External Codex sign-in (account unverified)', colourKey: 'slate-blue' },
      { id: 'id-old', friendlyName: 'Old', colourKey: 'rose' },
      { id: 'id-parked', colourKey: 'plum' },
      { id: 'id-gone', colourKey: 'plum' },
      { id: 'id-claude', friendlyName: 'Me', colourKey: 'mauve' },
    ],
    groups: [],
    accounts: [parked, work, personal, local, old, gone, claudeMain],
    pendingSetups: [],
    externalDefaults: [],
    conflicts: [],
    reviewerNotices: [],
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Selectors

describe('selectProviderAccounts', () => {
  it("lists one provider's accounts, active before inactive, and hides archived ones", () => {
    const ids = selectProviderAccounts(snapshot(), 'codex').map((a) => a.id)
    expect(ids).toEqual(['acc-work', 'acc-personal', 'acc-local', 'acc-old', 'acc-parked'])
    expect(ids).not.toContain('acc-gone')
    expect(ids).not.toContain('acc-claude-main')
  })

  it('finds a mirrored account by its legacy id', () => {
    expect(accountForLegacyId(snapshot(), 'claude', 'profile-primary')?.id).toBe('acc-claude-main')
    expect(accountForLegacyId(snapshot(), 'codex', 'profile-primary')).toBeUndefined()
  })
})

describe('accountDisplayName', () => {
  it("uses the identity's friendly name first", () => {
    expect(accountDisplayName(snapshot(), work)).toBe('Work')
  })
  it('falls back to the provider label, then to a short fallback', () => {
    const labelled = account({ id: 'a1', providerId: 'codex', identityId: 'id-parked', providerLabel: 'x@y.example' })
    expect(accountDisplayName(snapshot(), labelled)).toBe('x@y.example')
    expect(accountDisplayName(snapshot(), parked)).toBe(ACCOUNT_NAME_FALLBACK)
  })
})

describe('reviewerLine', () => {
  it('names the chosen reviewer as "(reviewer)"', () => {
    expect(reviewerLine(snapshot(), 'codex')).toEqual({ kind: 'account', accountId: 'acc-personal', name: 'Personal', label: 'reviewer', ready: true })
  })

  it('says "(default)" when reviews fall back to the provider default', () => {
    expect(reviewerLine(snapshot(), 'claude')).toMatchObject({ name: 'Me', label: 'default' })
  })

  it('never labels a refused account as the reviewer, and says it cannot run', () => {
    const refused = { ...personal, reviewRefusal: { reason: 'unknown' as const, message: 'm' } }
    const s = snapshot({ accounts: [work, refused] })
    expect(reviewerLine(s, 'codex')).toMatchObject({ label: null, ready: false })
  })

  it('passes a not-ready review through', () => {
    const s = snapshot()
    s.providers[1] = { ...s.providers[1], review: { ready: false, accountId: personal.id, source: 'reviewer-default' } }
    expect(reviewerLine(s, 'codex')).toMatchObject({ ready: false })
  })

  it('says there is no account when none can review, and is null when the provider does not review', () => {
    const s = snapshot()
    s.providers[1] = { ...s.providers[1], review: { ready: false } }
    expect(reviewerLine(s, 'codex')).toEqual({ kind: 'no-account' })
    s.providers[0] = { ...s.providers[0], review: undefined }
    expect(reviewerLine(s, 'claude')).toBeNull()
  })
})

describe('canOfferMakeReviewer', () => {
  const s = snapshot()
  it('offers it on an active, vouched-for account that is not the reviewer', () => {
    expect(canOfferMakeReviewer(s, work)).toBe(true)
  })
  it.each([
    ['archived', gone],
    ['inactive', parked],
    ['blocked', old],
    ['external', local],
    ['unverified', account({ id: 'u', providerId: 'codex', identityId: 'id-work', unverified: true, identityAssurance: 'realm-only' })],
    ['refused (platform)', { ...work, reviewRefusal: { reason: 'platform' as const, message: 'm' } }],
    ['refused (unknown)', { ...work, reviewRefusal: { reason: 'unknown' as const, message: 'm' } }],
    ['already the reviewer', personal],
  ])('never offers it on an account that is %s', (_label, a) => {
    expect(canOfferMakeReviewer(s, a)).toBe(false)
  })
  it('never offers it when the provider does not review here', () => {
    const noReview = snapshot()
    noReview.providers[1] = { ...noReview.providers[1], review: undefined }
    expect(canOfferMakeReviewer(noReview, work)).toBe(false)
  })
})

describe('showsReviewerBadge', () => {
  it('shows it on the chosen reviewer and never on a refused one', () => {
    expect(showsReviewerBadge(personal)).toBe(true)
    expect(showsReviewerBadge({ ...personal, reviewRefusal: { reason: 'platform', message: 'm' } })).toBe(false)
    expect(showsReviewerBadge(work)).toBe(false)
  })
  it('never shows it on an external account, even one not marked unverified', () => {
    expect(showsReviewerBadge({ ...local, isReviewerDefault: true, unverified: false })).toBe(false)
  })
})

describe('reviewerNotice', () => {
  const notice = { providerId: 'claude' as const, message: 'On macOS only the normal sign-in can review.' }
  it('gives the macOS sentence for a cleared Claude reviewer on macOS', () => {
    expect(reviewerNotice(snapshot({ reviewerNotices: [notice] }), 'claude', 'darwin'))
      .toBe('Your earlier Claude reviewer was cleared: on macOS only the normal Claude sign-in can be the Claude reviewer.')
  })
  it("gives the provider's name and the main process's reason otherwise", () => {
    const codex = { providerId: 'codex' as const, message: 'That account cannot review here.' }
    expect(reviewerNotice(snapshot({ reviewerNotices: [codex] }), 'codex', 'win32'))
      .toBe('Your earlier Codex reviewer was cleared. That account cannot review here.')
  })
  it('is null when nothing was cleared for that provider', () => {
    expect(reviewerNotice(snapshot({ reviewerNotices: [notice] }), 'codex', 'darwin')).toBeNull()
  })
})

describe('row text', () => {
  it('says a blocked account needs attention before anything else', () => {
    expect(accountState(old)).toEqual({ text: 'Needs attention: signed in as a different account', tone: 'warn' })
    expect(accountState(work).text).toBe('Signed in')
    expect(accountState({ ...work, lastKnownAuthState: 'signed-out' }).text).toBe('Signed out')
    expect(accountState({ ...work, lastKnownAuthState: 'expired' }).text).toBe('Expired')
  })
  it('states a provider as "<name> <version> - ready"', () => {
    expect(providerStatus(snapshot().providers[0])).toEqual({ text: 'Claude Code 2.1.281 - ready', tone: 'ok' })
    expect(providerStatus({ ...snapshot().providers[1], compatibility: 'too-old' }).tone).toBe('warn')
  })
  it.each([
    [{ discoveryState: 'unchecked' as const }, 'Codex: not checked yet', 'muted'],
    [{ discoveryState: 'missing' as const }, 'Codex was not found on this computer', 'warn'],
    [{ discoveryState: 'invalid' as const }, 'Codex was found but did not run as expected', 'warn'],
    [{ discoveryState: 'error' as const }, 'Codex could not be checked', 'warn'],
    [{ compatibility: 'too-new' as const }, 'Codex 0.155.1 is newer than this app supports', 'warn'],
    [{ compatibility: 'unsupported' as const }, 'Codex 0.155.1 is not supported here', 'warn'],
    [{ compatibility: 'unknown' as const }, 'Codex 0.155.1 found', 'muted'],
    [{ enabled: false }, 'Off', 'muted'],
  ])('states a provider %o as its own sentence', (over, text, tone) => {
    expect(providerStatus({ ...snapshot().providers[1], ...over })).toEqual({ text, tone })
  })
  it('turns a consumers failure into "in use" with the count, never "sessions"', () => {
    expect(accountFailureText({ ok: false, code: 'consumers', consumers: 2, message: 'x' })).toBe('This account is in use (2).')
    expect(accountFailureText({ ok: false, code: 'consumers', consumers: 3, message: 'x' }, { runningSessions: 2, runningReviews: 0 }))
      .toBe('This account is in use (3). Running now: 2 sessions.')
    expect(accountFailureText({ ok: false, code: 'busy', message: 'Busy now.' })).toBe('Busy now.')
  })
  it("names the provider's external home by its label, whatever its identity is called", () => {
    expect(accountDisplayName(snapshot(), local)).toBe("This computer's Codex (~/.codex)")
  })
})

describe('menu offers that mirror the registry', () => {
  it('offers the recorded method family only, the recorded one first', () => {
    const p = snapshot().providers[1]
    expect(signInAgainMethods(p, { authMethod: 'device' })).toEqual({ methods: ['browser', 'device'], preselected: 'device' })
    expect(signInAgainMethods(p, { authMethod: 'apiKey' })).toEqual({ methods: ['apiKey'], preselected: 'apiKey' })
    const noDevice = { ...p, signInMethods: { ...p.signInMethods, device: { enabled: false, labelExperimental: false } } }
    expect(signInAgainMethods(noDevice, { authMethod: 'device' })).toEqual({ methods: ['browser'], preselected: 'browser' })
  })
  it('hides Make inactive where the registry refuses it', () => {
    const s = snapshot()
    expect(canOfferMakeInactive(s, work)).toBe(false) // the default, with other active accounts
    expect(canOfferMakeInactive(snapshot({ accounts: [work] }), work)).toBe(true) // the only active one
    expect(canOfferMakeInactive(s, personal)).toBe(true)
    expect(canOfferMakeInactive(s, parked)).toBe(false)
    const mirrored = account({ id: 'm1', providerId: 'claude', identityId: 'id-claude', legacyLinked: true })
    expect(canOfferMakeInactive(snapshot({ accounts: [claudeMain, mirrored] }), mirrored)).toBe(true)
    expect(canOfferMakeInactive(snapshot({ accounts: [claudeMain, mirrored] }), claudeMain)).toBe(false) // the provider's primary
    expect(canOfferMakeInactive(snapshot({ accounts: [mirrored] }), mirrored)).toBe(false) // its last active one
  })
  it('hides Make active on a blocked account and Archive on an active or mirrored one', () => {
    expect(canOfferMakeActive(parked)).toBe(true)
    expect(canOfferMakeActive({ ...parked, operationalState: 'blocked' })).toBe(false)
    expect(canOfferArchive(parked)).toBe(true)
    expect(canOfferArchive(work)).toBe(false)
    expect(canOfferArchive({ ...parked, legacyLinked: true })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Hydration

describe('hydrate + onChanged', () => {
  let pushed: ((s: AccountsSnapshot) => void) | null
  const onChanged = vi.fn((cb: (s: AccountsSnapshot) => void) => { pushed = cb; return () => {} })
  const fetchSnapshot = vi.fn<[], Promise<AccountsSnapshot | null>>()

  beforeEach(() => {
    pushed = null
    onChanged.mockClear()
    fetchSnapshot.mockReset()
    ;(window as any).electronAPI = { providerAccounts: { onChanged, snapshot: fetchSnapshot } }
    vi.resetModules()
  })

  it('fetches the snapshot and then follows every change the main process pushes', async () => {
    const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
    fetchSnapshot.mockResolvedValue(snapshot({ revision: 1 }))
    await useProviderAccountsStore.getState().hydrate()
    expect(useProviderAccountsStore.getState().snapshot?.revision).toBe(1)
    expect(useProviderAccountsStore.getState().loaded).toBe(true)

    expect(pushed).toBeTypeOf('function')
    pushed!(snapshot({ revision: 2, accounts: [work] }))
    expect(useProviderAccountsStore.getState().snapshot?.revision).toBe(2)
    expect(useProviderAccountsStore.getState().snapshot?.accounts.map((a) => a.id)).toEqual(['acc-work'])
  })

  it('subscribes once for the life of the renderer, however often it hydrates', async () => {
    const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
    fetchSnapshot.mockResolvedValue(snapshot())
    await useProviderAccountsStore.getState().hydrate()
    await useProviderAccountsStore.getState().hydrate()
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('never lets a slower fetch roll back a newer push', async () => {
    const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
    let answer: (s: AccountsSnapshot) => void = () => {}
    fetchSnapshot.mockReturnValue(new Promise((r) => { answer = r }))
    const pending = useProviderAccountsStore.getState().hydrate()
    pushed!(snapshot({ revision: 5 }))
    answer(snapshot({ revision: 4 }))
    await pending
    expect(useProviderAccountsStore.getState().snapshot?.revision).toBe(5)
  })
})
