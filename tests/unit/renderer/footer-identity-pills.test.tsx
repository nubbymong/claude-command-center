// @vitest-environment jsdom
//
// Usage track MP5 (the approved canvas, usage footer option B): the
// multi-account footer shows one pill per IDENTITY, with a meter group per
// provider it has live sessions of, each group led by its provider's mark when
// the identity is linked or the group is Codex's; groups are never merged.
// A pill with only Claude Code sessions reads exactly as before (the regression
// case: its email with meters, its name with dots, the name from the aliases,
// the colour from the email overrides, the order and the "+N"). D2: a window
// past its reset shows a static no-reading meter. D3: a Codex group that will
// never report says "per token" or "no reading". The overflow counts
// "identities" once Codex is in use.
//
// PURE: the real component and stores, set directly; no IPC.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountProfile } from '../../../src/shared/account-types'
import type { UsageBucket } from '../../../src/shared/usage-types'
import type { AccountsSnapshot, AccountView, IdentityView } from '../../../src/shared/providers'
import type { Session } from '../../../src/renderer/stores/sessionStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark', useThemeController: () => {} }))

const {
  default: MultiAccountStatusline, liveIdentityUsage, preferBucket,
} = await import('../../../src/renderer/components/MultiAccountStatusline')
const { formatResetTime } = await import('../../../src/renderer/utils/terminalFormatting')
const { SCENARIO } = await import('../../fixtures/footer/claude-only-scenario')
const { default: PRE_MP5 } = (await import('../../fixtures/footer/pre-mp5-claude-only.json')) as { default: { meters: string; dots: string } }
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useAccountProfilesStore } = await import('../../../src/renderer/stores/accountProfilesStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { choiceSettings } = await import('../../../src/renderer/onboarding/provider-choice')
const { resolveAccountColourKey } = await import('../../../src/shared/account-chip-color')
const { resolveIdentityColor } = await import('../../../src/shared/identity-colors')
const { useStatuslineSubscription } = await import('../../../src/renderer/hooks/useStatuslineSubscription')

// ---------------------------------------------------------------- fixtures --

const profiles: AccountProfile[] = [
  { id: 'p1', accountEmail: 'a@x.com', name: '', isPrimary: true, createdAt: 0 },
  { id: 'p2', accountEmail: 'b@x.com', name: '', createdAt: 0 },
  { id: 'p3', accountEmail: 'c@x.com', name: '', createdAt: 0 },
]
const aliases = { 'a@x.com': 'Alpha', 'b@x.com': 'Bravo', 'c@x.com': 'Charlie' }
const overrides = { 'b@x.com': 'rose' as const }

const identity = (id: string, friendlyName: string, colourKey: string): IdentityView => ({ id, friendlyName, colourKey })
const account = (id: string, providerId: 'claude' | 'codex', identityId: string, over: Partial<AccountView> = {}): AccountView => ({
  id, providerId, identityId, lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false,
  authMethod: 'browser', lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted',
  realmLifecycle: 'active', external: false, unverified: false, legacyLinked: false, runningSessions: 0, runningReviews: 0, consumers: 0,
  ...over,
})
// Every Claude profile is mirrored to an identity whose name and colour are
// NOT the aliases and overrides: a plain pill must keep the latter.
const snapshot: AccountsSnapshot = {
  revision: 1, registry: { mode: 'ready' } as AccountsSnapshot['registry'],
  providers: [{ providerId: 'claude', displayName: 'Claude Code' }, { providerId: 'codex', displayName: 'Codex' }] as AccountsSnapshot['providers'],
  identities: [identity('i-a', 'Ann', 'plum'), identity('i-b', 'Bob', 'indigo'), identity('i-c', 'Cat', 'violet'), identity('i-d', 'Dee', 'orchid'), identity('i-e', 'Eve', 'pink')],
  groups: [],
  accounts: [
    account('cl-1', 'claude', 'i-a', { legacyId: 'p1', legacyLinked: true, providerLabel: 'a@x.com' }),
    account('cl-2', 'claude', 'i-b', { legacyId: 'p2', legacyLinked: true, providerLabel: 'b@x.com' }),
    account('cl-3', 'claude', 'i-e', { legacyId: 'p3', legacyLinked: true, providerLabel: 'c@x.com' }),
    account('cx-1', 'codex', 'i-a', { isProviderDefault: true }),
    account('cx-2', 'codex', 'i-c', { authMethod: 'apiKey' }),
    account('cx-3', 'codex', 'i-d'),
    account('cx-4', 'codex', 'i-e', { authMethod: 'device' }),
    account('cx-5', 'codex', 'i-a', { authMethod: 'apiKey', providerLabel: 'Team key' }),
    account('cl-9', 'claude', 'i-b', { legacyId: 'p9', legacyLinked: true }),
  ],
  pendingSetups: [], externalDefaults: [], conflicts: [], reviewerNotices: [],
}

const future = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()
const bucket = (label: string, percent: number, over: Partial<UsageBucket> = {}): UsageBucket =>
  ({ key: label.toLowerCase(), label, group: label === '5h' ? 'session' : 'weekly', percent, resetsAt: future(3), severity: 'normal', ...over })
const cxBuckets = (p5: number, pw: number): UsageBucket[] => [
  bucket('5h', p5, { key: 'codex/300:' }), bucket('Weekly', pw, { key: 'codex/10080:' }),
]
let seq = 0
const claude = (email: string, over: Partial<Session> = {}): Session =>
  ({ id: `s${++seq}`, label: 'x', status: 'working', provider: 'claude', accountEmail: email, ...over }) as Session
const codex = (over: Partial<Session> = {}): Session =>
  ({ id: `s${++seq}`, label: 'x', status: 'working', provider: 'codex', ...over }) as Session

// ------------------------------------------------------------ pure grouping --

describe('liveIdentityUsage (usage track MP5)', () => {
  it('Claude Code only: named from the aliases and coloured from the email overrides, whatever the registry calls them', () => {
    const sessions = [
      claude('b@x.com', { usageBuckets: [bucket('5h', 10), bucket('Weekly', 20), bucket('Fable', 30, { key: 'weekly:Fable' })] }),
      claude('a@x.com', { rateLimitCurrent: 30, rateLimitWeekly: 12 }),
      claude('a@x.com', { rateLimitCurrent: 55, rateLimitWeekly: 4 }),
      // An SSH session reports its remote account (#571).
      claude('', { accountEmail: undefined, sshRemoteAccount: 'C@X.com', sessionType: 'ssh', rateLimitCurrent: 5 } as Partial<Session>),
    ]
    const out = liveIdentityUsage(sessions, profiles, aliases, overrides, snapshot)
    expect(out.map((i) => [i.name, i.email, i.count, i.isPrimary])).toEqual([['Alpha', 'a@x.com', 2, true], ['Bravo', 'b@x.com', 1, false], ['Charlie', 'C@X.com', 1, false]])
    expect(out.map((i) => i.colourKey)).toEqual([resolveAccountColourKey('a@x.com', overrides, undefined), 'rose', resolveAccountColourKey('C@X.com', overrides, undefined)])
    expect(out.every((i) => i.plain && i.groups.length === 1)).toBe(true)
  })

  // MP5 review Q1: an idle session's passed window never hides the current one.
  it('of two readings of one label, the one whose reset is still ahead wins, whatever its percentage', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const ahead = future(2)
    const out = liveIdentityUsage([
      claude('a@x.com', { status: 'idle', usageBuckets: [bucket('5h', 95, { resetsAt: past })] }),
      claude('a@x.com', { usageBuckets: [bucket('5h', 5, { resetsAt: ahead })] }),
    ], profiles, aliases, overrides, snapshot)
    expect(out[0].groups[0].buckets.map((b) => [b.percent, b.resetsAt])).toEqual([[5, ahead]])
  })

  it('within one window the worst case; of two windows ahead, the later', () => {
    const at = future(2)
    const soon = new Date(Date.parse(at) + 2 * 60_000).toISOString() // the same window, reported a little apart
    const n = Date.now()
    expect(preferBucket(bucket('5h', 30, { resetsAt: at }), bucket('5h', 60, { resetsAt: soon }), n)).toBe(true)
    expect(preferBucket(bucket('5h', 60, { resetsAt: at }), bucket('5h', 30, { resetsAt: soon }), n)).toBe(false)
    expect(preferBucket(bucket('5h', 60, { resetsAt: future(1) }), bucket('5h', 10, { resetsAt: future(6) }), n)).toBe(true)
    expect(preferBucket(bucket('5h', 10, { resetsAt: future(6) }), bucket('5h', 60, { resetsAt: future(1) }), n)).toBe(false)
    // No reset time to compare: the worst case, as before.
    expect(preferBucket(bucket('5h', 10, { resetsAt: '' }), bucket('5h', 60, { resetsAt: '' }), n)).toBe(true)
    // A reading known to be past its reset loses to one not known to be.
    const gone = new Date(n - 60_000).toISOString()
    expect(preferBucket(bucket('5h', 95, { resetsAt: gone }), bucket('5h', 5, { resetsAt: '' }), n)).toBe(true)
    expect(preferBucket(bucket('5h', 5, { resetsAt: '' }), bucket('5h', 95, { resetsAt: gone }), n)).toBe(false)
  })

  // MP5 review Q2.
  it('an email no profile has is its own pill, never merged into the session\'s profile', () => {
    const out = liveIdentityUsage([
      claude('new@x.com', { profileId: 'p1', rateLimitCurrent: 3 }),
      claude('a@x.com', { profileId: 'p1', rateLimitCurrent: 4 }),
    ], profiles, aliases, overrides, snapshot)
    expect(out.map((i) => i.key).sort()).toEqual(['email:new@x.com', 'identity:i-a'])
    // A profile with no email of its own still takes its session's email.
    const noEmail = [...profiles, { id: 'p9', accountEmail: '', name: 'Nine', createdAt: 0 } as AccountProfile]
    const nine = liveIdentityUsage([claude('z@x.com', { profileId: 'p9', rateLimitCurrent: 1 })], noEmail, aliases, overrides, snapshot)
    expect(nine[0].key).toBe('identity:i-b')
  })

  // MP5 review Q3.
  it('two Codex accounts on one identity are two groups, each named, their allowances apart', () => {
    const out = liveIdentityUsage([
      codex({ providerAccountId: 'cx-1', usageBuckets: cxBuckets(20, 30) }),
      codex({ providerAccountId: 'cx-5' }),
      claude('b@x.com', { rateLimitCurrent: 1 }),
    ], profiles, aliases, overrides, snapshot)
    const ann = out.find((i) => i.name === 'Ann')!
    expect(ann.groups.map((g) => [g.key, g.accountName, g.word, g.buckets.length])).toEqual([
      ['codex:cx-1', 'ChatGPT sign-in', undefined, 2],
      ['codex:cx-5', 'Team key', 'per token', 0],
    ])
    // One Codex account: one group, not named.
    const one = liveIdentityUsage([codex({ providerAccountId: 'cx-1', usageBuckets: cxBuckets(20, 30) })], profiles, aliases, overrides, snapshot)
    expect(one[0].groups.map((g) => [g.key, g.accountName])).toEqual([['codex:cx-1', undefined]])
  })

  it('one identity, both providers live: one pill with a group per provider, named and coloured from the identity', () => {
    const out = liveIdentityUsage([
      claude('a@x.com', { usageBuckets: [bucket('5h', 30), bucket('Weekly', 40)] }),
      codex({ providerAccountId: 'cx-1', usageBuckets: cxBuckets(60, 5) }),
      claude('b@x.com', { rateLimitCurrent: 1 }),
    ], profiles, aliases, overrides, snapshot)
    const ann = out.find((i) => i.name === 'Ann')!
    expect(ann).toMatchObject({ colourKey: 'plum', count: 2, plain: false, isPrimary: true })
    expect(ann.groups.map((g) => g.providerId)).toEqual(['claude', 'codex'])
    // Worst case per label per provider: never merged across providers.
    expect(ann.groups.map((g) => g.buckets.find((b) => b.label === '5h')?.percent)).toEqual([30, 60])
    expect(ann.groups[0].email).toBe('a@x.com')
    expect(ann.groups[1].method).toBe('ChatGPT sign-in')
    expect(out.map((i) => i.name)).toEqual(['Ann', 'Bravo'])
  })

  it('a Codex session with no account named runs under the provider default', () => {
    const out = liveIdentityUsage([codex({ usageBuckets: cxBuckets(9, 9) }), claude('b@x.com')], profiles, aliases, overrides, snapshot)
    expect(out.find((i) => i.key === 'identity:i-a')?.groups.map((g) => g.providerId)).toEqual(['codex'])
  })

  it('an SSH session\'s remote account joins its identity\'s Codex group (#571)', () => {
    const out = liveIdentityUsage([
      claude('', { accountEmail: undefined, sshRemoteAccount: 'a@x.com', sessionType: 'ssh', rateLimitCurrent: 5 } as Partial<Session>),
      codex({ providerAccountId: 'cx-1', usageBuckets: cxBuckets(1, 1) }),
    ], profiles, aliases, overrides, snapshot)
    expect(out).toHaveLength(1)
    expect(out[0].groups.map((g) => g.providerId)).toEqual(['claude', 'codex'])
  })

  it('D3: an API-key Codex account says "per token"; one that will never report says "no reading"; a reading clears the word', () => {
    const out = liveIdentityUsage([
      codex({ providerAccountId: 'cx-2' }),
      codex({ providerAccountId: 'cx-3', usageUnavailable: 'no-reading' } as Partial<Session>),
    ], profiles, aliases, overrides, snapshot)
    expect(out.find((i) => i.name === 'Cat')?.groups[0].word).toBe('per token')
    expect(out.find((i) => i.name === 'Dee')?.groups[0].word).toBe('no reading')
    const read = liveIdentityUsage([codex({ providerAccountId: 'cx-3', usageUnavailable: 'no-reading', usageBuckets: cxBuckets(3, 3) } as Partial<Session>)], profiles, aliases, overrides, snapshot)
    expect(read[0].groups[0].word).toBeUndefined()
  })

  it('without a registry, or with an account it does not know, a Codex session is left out; Claude Code is keyed by email as before', () => {
    const sessions = [codex({ providerAccountId: 'cx-1', usageBuckets: cxBuckets(1, 1) }), claude('a@x.com'), claude('b@x.com')]
    expect(liveIdentityUsage(sessions, profiles, aliases, overrides, null).map((i) => i.key)).toEqual(['email:a@x.com', 'email:b@x.com'])
    expect(liveIdentityUsage([codex({ providerAccountId: 'nope' })], profiles, aliases, overrides, snapshot)).toEqual([])
  })
})

// ------------------------------------------------------------------ render --

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  useAccountProfilesStore.setState({ profiles })
  useProviderAccountsStore.setState({ snapshot, loaded: true })
  settings({})
})
afterEach(() => {
  act(() => root.unmount()); container.remove()
  useSessionStore.setState({ sessions: [] })
  useProviderAccountsStore.setState({ snapshot: null, loaded: false })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function settings(over: Record<string, unknown>, withCodex = true) {
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, ...choiceSettings(withCodex ? 'both' : 'claude'), codexAnswered: true, accountAliases: aliases, accountColourOverrides: overrides, ...over },
    isLoaded: true,
  })
}
function show(sessions: Session[]) {
  useSessionStore.setState({ sessions })
  act(() => { root.render(<MultiAccountStatusline />) })
}
const pills = () => Array.from(container.querySelectorAll('[data-testid="multi-account-pill"]')) as HTMLElement[]
const labels = () => pills().map((p) => p.querySelector('[data-testid="multi-account-pill-label"]')?.textContent)
const pillOf = (label: string) => pills().find((p) => p.querySelector('[data-testid="multi-account-pill-label"]')?.textContent === label)!
const marks = (el: Element) => Array.from(el.querySelectorAll('[data-testid^="provider-mark-"]')).map((m) => m.getAttribute('data-testid'))

/** jsdom does no layout: give the strip and each pill a width. */
function measure(available: number, pill: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const tid = this.getAttribute('data-testid')
    const width = tid === 'multi-account-statusline' ? available : tid === 'multi-account-pill' ? pill : 0
    return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON() { return {} } } as DOMRect
  })
}

describe('MultiAccountStatusline, one pill per identity (usage track MP5)', () => {
  // MP5 review Q5: the footer before MP5 (895ee237) rendered this scenario to
  // the recorded HTML; the footer now renders it byte for byte the same, with a
  // registry whose identities have other names and colours.
  it('Claude Code only: the same HTML as the footer before MP5, in both display modes', () => {
    useAccountProfilesStore.setState({ profiles: SCENARIO.profiles as AccountProfile[] })
    for (const mode of ['meters', 'dots'] as const) {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...SCENARIO.settings, footerAccountDisplay: mode } as typeof DEFAULT_SETTINGS, isLoaded: true })
      useSessionStore.setState({ sessions: SCENARIO.sessions as unknown as Session[] })
      act(() => { root.render(<MultiAccountStatusline />) })
      expect(container.innerHTML, mode).toBe(PRE_MP5[mode])
    }
  })

  it('Claude Code only: the pills read as before (emails with meters, names with dots, no marks, the same order)', () => {
    settings({}, false)
    const sessions = [claude('b@x.com', { rateLimitCurrent: 10, rateLimitWeekly: 20 }), claude('a@x.com', { rateLimitCurrent: 30, rateLimitWeekly: 12 })]
    show(sessions)
    expect(labels()).toEqual(['a@x.com', 'b@x.com'])
    expect(marks(container)).toEqual([])
    expect(container.querySelector('[data-testid^="multi-account-group-"]')).toBeNull()
    settings({ footerAccountDisplay: 'dots' }, false)
    show(sessions)
    expect(labels()).toEqual(['Alpha', 'Bravo'])
  })

  it('Claude Code only, overflowing: "+N more accounts", each row coloured from the email override', () => {
    settings({}, false)
    measure(300, 200)
    show([claude('a@x.com', { rateLimitCurrent: 1 }), claude('b@x.com', { rateLimitCurrent: 2 }), claude('c@x.com', { rateLimitCurrent: 3 })])
    const toggle = container.querySelector('[data-testid="multi-account-overflow-toggle"]') as HTMLElement
    expect(toggle.textContent).toBe('+1')
    expect(toggle.getAttribute('aria-label')).toBe('Show 1 more account')
    act(() => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const row = container.querySelector('[data-testid="multi-account-overflow-row"]') as HTMLElement
    expect(row.textContent).toContain('c@x.com')
    const dot = row.querySelector('span > span') as HTMLElement
    expect(dot.style.background).toBe(hexToRgb(resolveIdentityColor(resolveAccountColourKey('c@x.com', overrides, undefined), 'dark')))
  })

  it('a linked identity is one pill: its name, a Claude Code group and a Codex group, each led by its mark, a rule between', () => {
    show([
      claude('a@x.com', { usageBuckets: [bucket('5h', 30), bucket('Weekly', 40)] }),
      codex({ providerAccountId: 'cx-1', usageBuckets: cxBuckets(60, 5) }),
      claude('b@x.com', { rateLimitCurrent: 1 }),
    ])
    expect(labels()).toEqual(['Ann', 'b@x.com'])
    const ann = pillOf('Ann')
    expect(Array.from(ann.querySelectorAll('[data-testid^="multi-account-group-"]')).map((g) => g.getAttribute('data-testid')))
      .toEqual(['multi-account-group-claude', 'multi-account-group-rule', 'multi-account-group-codex'])
    expect(marks(ann)).toEqual(['provider-mark-claude', 'provider-mark-codex'])
    expect(ann.querySelectorAll('[role="progressbar"]')).toHaveLength(4)
    expect(ann.title).toContain(`Codex ${String.fromCharCode(0xb7)} ChatGPT sign-in`)
    // The plain Claude Code pill beside it keeps no mark.
    expect(marks(pillOf('b@x.com'))).toEqual([])
  })

  it('a Codex-only identity: its name, the Codex mark, its meters', () => {
    show([codex({ providerAccountId: 'cx-3', usageBuckets: cxBuckets(18, 47) }), claude('b@x.com')])
    const dee = pillOf('Dee')
    expect(marks(dee)).toEqual(['provider-mark-codex'])
    expect(Array.from(dee.querySelectorAll('[role="progressbar"]')).map((b) => b.getAttribute('aria-valuenow'))).toEqual(['18', '47'])
  })

  it('D3: "per token" and "no reading" instead of a placeholder, with no shimmer', () => {
    show([codex({ providerAccountId: 'cx-2' }), codex({ providerAccountId: 'cx-3', usageUnavailable: 'no-reading' } as Partial<Session>)])
    expect(pillOf('Cat').querySelector('[data-testid="multi-account-word"]')?.textContent).toBe('per token')
    expect(pillOf('Dee').querySelector('[data-testid="multi-account-word"]')?.textContent).toBe('no reading')
    expect(container.querySelector('[data-testid="rate-limit-pending"]')).toBeNull()
    expect(container.querySelector('.statusline-pending-track')).toBeNull()
  })

  it('a Codex group waiting for its first reading shows the placeholder only while the status line is on', () => {
    show([codex({ providerAccountId: 'cx-3' }), claude('b@x.com', { rateLimitCurrent: 1 })])
    expect(pillOf('Dee').querySelectorAll('[data-testid="rate-limit-pending"]')).toHaveLength(2)
    settings({ statusLineEnabled: false })
    show([codex({ providerAccountId: 'cx-3' }), claude('b@x.com', { rateLimitCurrent: 1 })])
    expect(pillOf('Dee').querySelector('[data-testid="rate-limit-pending"]')).toBeNull()
  })

  it('D2: a window past its reset shows a static no-reading meter, and the others keep their figures', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    show([codex({ providerAccountId: 'cx-3', usageBuckets: [bucket('5h', 70, { key: 'codex/300:', resetsAt: past }), bucket('Weekly', 40, { key: 'codex/10080:' })] }), claude('b@x.com', { rateLimitCurrent: 1 })])
    const dee = pillOf('Dee')
    const still = dee.querySelector('[data-testid="rate-limit-no-reading"]') as HTMLElement
    expect(still).not.toBeNull()
    expect(still.querySelector('.statusline-pending-track')).toBeNull()
    expect(still.title).toMatch(/no reading since/)
    expect(Array.from(dee.querySelectorAll('[role="progressbar"][aria-valuenow]')).map((b) => b.getAttribute('aria-valuenow'))).toEqual(['40'])
  })

  it('D2 in dots mode: a window past its reset is a static hollow dot, one group per provider each led by its mark', () => {
    settings({ footerAccountDisplay: 'dots' })
    const past = new Date(Date.now() - 60_000).toISOString()
    show([
      claude('a@x.com', { usageBuckets: [bucket('5h', 95)] }),
      codex({ providerAccountId: 'cx-1', usageBuckets: [bucket('5h', 10, { key: 'codex/300:', resetsAt: past })] }),
      claude('b@x.com', { rateLimitCurrent: 1 }),
    ])
    const ann = pillOf('Ann')
    expect(marks(ann)).toEqual(['provider-mark-claude', 'provider-mark-codex'])
    expect(ann.querySelector('[data-testid="multi-account-group-claude"] [data-testid="account-usage-dot"]')?.getAttribute('data-rag')).toBe('red')
    expect(ann.querySelector('[data-testid="multi-account-group-codex"] [data-testid="account-usage-dot-no-reading"]')).not.toBeNull()
    expect(ann.querySelector('[data-testid="multi-account-group-codex"] [data-testid="account-usage-dot"]')).toBeNull()
  })

  it('a window that resets while the footer is on screen turns to no reading on time', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const soon = new Date(Date.now() + 60_000).toISOString()
    show([codex({ providerAccountId: 'cx-3', usageBuckets: [bucket('5h', 70, { key: 'codex/300:', resetsAt: soon })] }), claude('b@x.com', { rateLimitCurrent: 1 })])
    expect(pillOf('Dee').querySelector('[data-testid="rate-limit-no-reading"]')).toBeNull()
    act(() => { vi.advanceTimersByTime(61_000) })
    expect(pillOf('Dee').querySelector('[data-testid="rate-limit-no-reading"]')).not.toBeNull()
  })

  it('with Codex in use the overflow counts identities, with a sub-row per provider group', () => {
    measure(300, 200)
    show([
      claude('a@x.com', { rateLimitCurrent: 5 }), codex({ providerAccountId: 'cx-1', usageBuckets: cxBuckets(6, 7) }),
      claude('b@x.com', { rateLimitCurrent: 1 }), codex({ providerAccountId: 'cx-3', usageBuckets: cxBuckets(8, 9) }), codex({ providerAccountId: 'cx-2' }),
      claude('c@x.com', { rateLimitCurrent: 2 }), codex({ providerAccountId: 'cx-4', usageBuckets: cxBuckets(3, 4) }),
    ])
    const toggle = container.querySelector('[data-testid="multi-account-overflow-toggle"]') as HTMLElement
    expect(toggle.getAttribute('aria-label')).toBe('Show 3 more identities')
    act(() => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const rows = Array.from(container.querySelectorAll('[data-testid="multi-account-overflow-row"]')) as HTMLElement[]
    expect(rows.map((r) => r.querySelector('.font-medium')?.textContent)).toEqual(['Cat', 'Dee', 'Eve'])
    expect(rows[0].querySelector('[data-testid="multi-account-overflow-group-codex"]')?.textContent).toContain('per token')
    expect(marks(rows[1])).toEqual(['provider-mark-codex'])
    // A linked identity: a sub-row per provider, each led by its mark.
    expect(Array.from(rows[2].querySelectorAll('[data-testid^="multi-account-overflow-group-"]')).map((g) => g.getAttribute('data-testid')))
      .toEqual(['multi-account-overflow-group-claude', 'multi-account-overflow-group-codex'])
    expect(marks(rows[2])).toEqual(['provider-mark-claude', 'provider-mark-codex'])
  })

  it('the footer\'s hidden labels: a bare label is Claude Code\'s (as it always was); "codex:<label>" is Codex\'s', () => {
    settings({ footerHiddenUsageBuckets: ['Weekly', 'codex:5h'] })
    show([
      claude('a@x.com', { usageBuckets: [bucket('5h', 30), bucket('Weekly', 40)] }),
      codex({ providerAccountId: 'cx-1', usageBuckets: cxBuckets(60, 5) }),
      claude('b@x.com', { rateLimitCurrent: 1 }),
    ])
    const ann = pillOf('Ann')
    const bars = (p: string) => Array.from(ann.querySelectorAll(`[data-testid="multi-account-group-${p}"] [role="progressbar"]`)).map((b) => b.getAttribute('aria-label'))
    expect(bars('claude')).toEqual(['5h rate limit utilisation'])
    expect(bars('codex')).toEqual(['Weekly rate limit utilisation'])
  })

  // Usage track MP6 (as drawn): a pill still waiting for its first reading
  // says so in its tooltip, a plain Claude Code one too, while the status line
  // is on.
  it('a pill waiting for its first reading says so in its tooltip, only while the status line is on', () => {
    settings({}, false)
    show([claude('a@x.com'), claude('b@x.com', { rateLimitCurrent: 1 })])
    expect(pillOf('a@x.com').title).toContain('Waiting for the status line')
    expect(pillOf('b@x.com').title).not.toContain('Waiting for the status line')
    settings({ statusLineEnabled: false }, false)
    show([claude('a@x.com'), claude('b@x.com', { rateLimitCurrent: 1 })])
    expect(pillOf('a@x.com').title).not.toContain('Waiting for the status line')
  })

  // MP5 review S1.
  it('a linked pill\'s tooltip says the reset time; a plain pill keeps its text as before', () => {
    const at = future(3)
    show([
      claude('a@x.com', { usageBuckets: [bucket('5h', 30, { resetsAt: at })] }),
      codex({ providerAccountId: 'cx-1', usageBuckets: [bucket('5h', 60, { key: 'codex/300:', resetsAt: at })] }),
      claude('b@x.com', { usageBuckets: [bucket('5h', 10, { resetsAt: at })] }),
    ])
    expect(pillOf('Ann').title).toContain(`resets ${formatResetTime(at)}`)
    expect(pillOf('Ann').title).not.toContain(at)
    expect(pillOf('b@x.com').title).toContain(`resets ${at}`)
  })

  // MP5 review S2: a waiting account in the "+N" popover shows the placeholder
  // bars while the status line is on (as drawn), and none while it is off.
  it('the overflow shows a waiting account\'s placeholder bars only while the status line is on', () => {
    for (const on of [true, false]) {
      settings({ statusLineEnabled: on }, false)
      measure(300, 200)
      show([claude('a@x.com', { rateLimitCurrent: 1 }), claude('b@x.com', { rateLimitCurrent: 2 }), claude('c@x.com')])
      const toggle = container.querySelector('[data-testid="multi-account-overflow-toggle"]') as HTMLElement
      act(() => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const row = container.querySelector('[data-testid="multi-account-overflow-row"]') as HTMLElement
      expect(row.textContent, String(on)).toContain('c@x.com')
      expect(row.querySelectorAll('[data-testid="rate-limit-pending"]').length, String(on)).toBe(on ? 2 : 0)
      act(() => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      vi.restoreAllMocks()
    }
  })

  // MP5 review S3: a dot's title in the drawn form, no dash.
  it('a no-reading dot\'s title reads "5h reset <time>, no reading since"', () => {
    settings({ footerAccountDisplay: 'dots' })
    const past = new Date(Date.now() - 60_000).toISOString()
    show([codex({ providerAccountId: 'cx-3', usageBuckets: [bucket('5h', 10, { key: 'codex/300:', resetsAt: past })] }), claude('b@x.com', { rateLimitCurrent: 1 })])
    expect((pillOf('Dee').querySelector('[data-testid="account-usage-dot-no-reading"]') as HTMLElement).title).toBe(`5h reset ${formatResetTime(past)}, no reading since`)
  })

  it('two Codex accounts on one identity: a group each, each named', () => {
    show([codex({ providerAccountId: 'cx-1', usageBuckets: cxBuckets(20, 30) }), codex({ providerAccountId: 'cx-5' }), claude('b@x.com', { rateLimitCurrent: 1 })])
    const ann = pillOf('Ann')
    expect(Array.from(ann.querySelectorAll('[data-testid="multi-account-group-account"]')).map((n) => n.textContent)).toEqual(['ChatGPT sign-in', 'Team key'])
    expect(ann.querySelector('[data-testid="multi-account-word"]')?.textContent).toBe('per token')
    expect(ann.title).toContain(`Codex ${String.fromCharCode(0xb7)} Team key ${String.fromCharCode(0xb7)} API key`)
  })

  it('shows nothing with fewer than two identities live, however many sessions', () => {
    show([claude('a@x.com', { rateLimitCurrent: 1 }), codex({ providerAccountId: 'cx-1', usageBuckets: cxBuckets(1, 1) })])
    expect(container.querySelector('[data-testid="multi-account-statusline"]')).toBeNull()
  })
})

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

// ------------------------------------------------ the statusline subscription --

describe('useStatuslineSubscription carries the reading time and D3 (usage track MP5)', () => {
  it('copies usageUnavailable onto the session', () => {
    let cb: ((d: unknown) => void) | null = null
    ;(window as any).electronAPI = { statusline: { onUpdate: (fn: (d: unknown) => void) => { cb = fn; return () => { cb = null } } } }
    useSessionStore.setState({ sessions: [{ id: 's-sub', label: 'a', status: 'idle', provider: 'codex' } as Session] })
    const Host: React.FC = () => { useStatuslineSubscription('s-sub'); return null }
    act(() => { root.render(<Host />) })
    act(() => { cb!({ sessionId: 's-sub', usageUnavailable: 'no-reading' }) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.usageUnavailable).toBe('no-reading')
  })
})
