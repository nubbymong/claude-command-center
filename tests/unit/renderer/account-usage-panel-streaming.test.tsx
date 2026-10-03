// @vitest-environment jsdom
//
// Plan P3: the account-usage page shows a skeleton per account up front and fills
// each row as its usage STREAMS in, instead of one all-or-nothing "Loading…" gate.
// These mount the real panel with the streaming IPC mocked and assert: skeletons
// render before any usage lands, each resolves independently as its result
// arrives, and a manual Refresh returns rows to skeletons and re-streams.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountUsage } from '../../../src/shared/usage-types'
import type { AccountProfile } from '../../../src/shared/account-types'
import type { AccountsSnapshot, AccountView, ProviderAccountUsageView, ProviderUsageStreamResult } from '../../../src/shared/providers'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useReauthAccount', () => ({ useReauthAccount: () => vi.fn() }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark', useThemeController: () => {} }))
vi.mock('../../../src/renderer/components/PageFrame', () => ({
  default: ({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) =>
    <div data-testid="page-frame"><div data-testid="pf-actions">{actions}</div>{children}</div>,
}))

const list = vi.fn<() => Promise<AccountProfile[]>>()
const authInfo = vi.fn(async () => [] as unknown[])
/** Every stream call's controller, in order — emit a result, finish, or reject.
 *  Collected (not just the latest) so a superseded stream can be driven too. */
interface StreamCtl { emit: (u: AccountUsage) => void; done: () => void; reject: (e: unknown) => void }
const streams: StreamCtl[] = []
const latest = (): StreamCtl => streams[streams.length - 1]
const fetchAllStream = vi.fn((onResult: (u: AccountUsage) => void) => new Promise<void>((resolve, reject) => {
  streams.push({ emit: (u) => act(() => onResult(u)), done: () => resolve(), reject: (e) => reject(e) })
}))
const fetchOne = vi.fn(async () => null)
/** The provider-neutral usage stream (MP3), driven the same way. */
interface ProviderStreamCtl { emit: (v: ProviderAccountUsageView) => void; done: (r?: ProviderUsageStreamResult) => void; reject: (e: unknown) => void }
const providerStreams: ProviderStreamCtl[] = []
const usageStream = vi.fn((_providerId: string, onResult: (v: ProviderAccountUsageView) => void, _opts?: { read?: boolean }) => new Promise<ProviderUsageStreamResult>((resolve, reject) => {
  providerStreams.push({ emit: (v) => act(() => onResult(v)), done: (r) => resolve(r ?? { ok: true, provider: 'on', accounts: 0 }), reject: (e) => reject(e) })
}))
const usageOne = vi.fn(async (_accountId: string, _opts?: { read?: boolean }): Promise<unknown> => ({ ok: false, code: 'not-found' }))
const usageStreamStop = vi.fn(async (_providerId: string) => ({ ok: true }))

Object.defineProperty(window, 'electronAPI', {
  writable: true, configurable: true,
  value: { accountProfiles: { list, authInfo }, accountUsage: { fetchAllStream, fetchOne }, providerAccounts: { usageStream, usageOne, usageStreamStop } },
})

const { default: AccountUsagePanel, FOCUS_REFRESH_MS } = await import('../../../src/renderer/components/AccountUsagePanel')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { choiceSettings } = await import('../../../src/renderer/onboarding/provider-choice')

const profile = (id: string): AccountProfile => ({ id, name: id, accountEmail: `${id}@x.com`, createdAt: 0 })
const usage = (profileId: string, percent: number): AccountUsage => ({
  profileId, email: `${profileId}@x.com`, name: profileId, isPrimary: false, active: true,
  status: 'ok', buckets: [{ key: 'session:', label: '5h', group: 'session', percent, resetsAt: '', severity: 'normal' }], fetchedAt: Date.now(),
})

let container: HTMLDivElement
let root: Root
const skeletons = () => container.querySelectorAll('[data-testid="account-usage-skeleton"]')
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

beforeEach(() => {
  list.mockReset(); authInfo.mockReset(); fetchAllStream.mockClear(); fetchOne.mockReset(); streams.length = 0
  usageStream.mockClear(); usageOne.mockClear(); usageStreamStop.mockClear(); providerStreams.length = 0
  authInfo.mockResolvedValue([]); fetchOne.mockResolvedValue(null)
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

async function mount() {
  await act(async () => { root.render(<AccountUsagePanel onClose={() => {}} onReauthNavigate={() => {}} />) })
  await flush()
}

describe('AccountUsagePanel — streaming skeletons (plan P3)', () => {
  it('shows a skeleton per account before any usage lands, then resolves each as it streams in', async () => {
    list.mockResolvedValue([profile('a'), profile('b'), profile('c')])
    await mount()

    // Before any result: three skeletons, no account cards.
    expect(skeletons().length).toBe(3)
    expect(container.textContent).not.toContain('a@x.com')

    // Stream the first account -> its row resolves, the other two stay skeletons.
    latest().emit(usage('a', 41))
    await flush()
    expect(skeletons().length).toBe(2)
    expect(container.textContent).toContain('a@x.com')
    expect(container.textContent).toContain('41%')

    // Stream the rest.
    latest().emit(usage('b', 12)); latest().emit(usage('c', 7))
    await flush()
    expect(skeletons().length).toBe(0)
    expect(container.textContent).toContain('b@x.com')
    expect(container.textContent).toContain('c@x.com')
    latest().done()
  })

  it('renders placeholder skeletons while the account list itself is still resolving', async () => {
    let resolveList!: (p: AccountProfile[]) => void
    list.mockReturnValue(new Promise<AccountProfile[]>((r) => { resolveList = r }))
    await act(async () => { root.render(<AccountUsagePanel onClose={() => {}} onReauthNavigate={() => {}} />) })
    // List not resolved yet: placeholder skeletons, no "No accounts found".
    expect(skeletons().length).toBeGreaterThan(0)
    expect(container.textContent).not.toMatch(/No accounts found/)
    resolveList([profile('a')])
    await flush()
    expect(skeletons().length).toBe(1) // now one per real account
    latest().done()
  })

  it('shows "No accounts found" only once the list resolves empty', async () => {
    list.mockResolvedValue([])
    await mount()
    expect(container.textContent).toMatch(/No accounts found/)
    expect(skeletons().length).toBe(0)
  })

  it('a manual Refresh returns rows to skeletons and re-streams', async () => {
    list.mockResolvedValue([profile('a')])
    await mount()
    latest().emit(usage('a', 20)); await flush()
    expect(container.textContent).toContain('20%')
    expect(skeletons().length).toBe(0)

    // Click Refresh (rendered into the mocked PageFrame actions slot).
    const refresh = container.querySelector('[data-testid="pf-actions"] button') as HTMLElement
    await act(async () => { refresh.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    // Back to a skeleton until the new stream lands.
    expect(skeletons().length).toBe(1)
    expect(fetchAllStream).toHaveBeenCalledTimes(2)
    latest().emit(usage('a', 55)); await flush()
    expect(container.textContent).toContain('55%')
    latest().done()
  })

  it('ignores a late result from a stream a Refresh superseded (generation guard)', async () => {
    list.mockResolvedValue([profile('a')])
    await mount()
    const old = latest() // stream #1

    // Refresh before #1 delivered anything -> stream #2, row reset to a skeleton.
    const refresh = container.querySelector('[data-testid="pf-actions"] button') as HTMLElement
    await act(async () => { refresh.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(streams.length).toBe(2)

    // A late result from the SUPERSEDED stream must not repopulate the row.
    old.emit(usage('a', 99))
    await flush()
    expect(container.textContent).not.toContain('99%')
    expect(skeletons().length).toBe(1) // still waiting on stream #2

    // The current stream fills it.
    latest().emit(usage('a', 7)); await flush()
    expect(container.textContent).toContain('7%')
    latest().done()
  })

  it('a rejected account-list load shows an error, not "No accounts found" or an endless skeleton', async () => {
    list.mockRejectedValue(new Error('profiles read failed'))
    await mount()
    expect(container.textContent).toMatch(/Couldn.t load account usage/i)
    expect(container.textContent).not.toMatch(/No accounts found/)
    expect(skeletons().length).toBe(0)
  })

  it('a stream that fails mid-way turns the unresolved rows terminal (Retry), not permanent skeletons', async () => {
    list.mockResolvedValue([profile('a'), profile('b')])
    await mount()
    latest().emit(usage('a', 33)) // a resolves
    await flush()
    expect(skeletons().length).toBe(1) // b still streaming

    // The stream itself fails before b arrives.
    latest().reject(new Error('stream died'))
    await flush()
    expect(skeletons().length).toBe(0) // no endless shimmer
    expect(container.textContent).toContain('a@x.com') // a kept its card
    expect(container.querySelectorAll('[data-testid="account-usage-unavailable"]').length).toBe(1) // b terminal

    // Retry on the terminal row fetches just that account.
    fetchOne.mockResolvedValueOnce(usage('b', 44))
    const retry = container.querySelector('[data-testid="account-usage-unavailable"] button') as HTMLElement
    await act(async () => { retry.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(fetchOne).toHaveBeenCalledWith('b')
    expect(container.textContent).toContain('44%')
  })
})

// Usage track MP3 review (D5): with Claude Code switched off the page reads
// nothing of it: not the credential state (authInfo reads every account's
// credential file), not the usage stream. It shows the one D5 line; turning
// Claude Code back on loads the page as before.
describe('AccountUsagePanel with Claude Code off (D5)', () => {
  afterEach(() => { useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true }) })

  it('calls neither authInfo nor the usage stream, and shows only the D5 line', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false }, isLoaded: true })
    list.mockResolvedValue([profile('a')])
    await mount()
    expect(authInfo).not.toHaveBeenCalled()
    expect(fetchAllStream).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Claude Code is off. Turn it on in Settings, Accounts to see its accounts.')
    expect(skeletons().length).toBe(0)
    expect(container.textContent).not.toContain('a@x.com')
    expect(container.textContent).not.toMatch(/countdown/i)
    // Refresh while off reads nothing either.
    const refresh = container.querySelector('[data-testid="pf-actions"] button') as HTMLElement
    await act(async () => { refresh.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(authInfo).not.toHaveBeenCalled()
    expect(fetchAllStream).not.toHaveBeenCalled()
  })

  // Usage track MP4: with Codex not on, the page is exactly the Claude page:
  // no section headings and no Codex call (row 14).
  it('with Codex not on, nothing of Codex is asked for and there are no section headings', async () => {
    list.mockResolvedValue([profile('a'), profile('b')])
    await mount()
    expect(usageStream).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid^="account-usage-section-"]')).toBeNull()
    latest().done()
  })

  it('loads as before once Claude Code is turned back on', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false }, isLoaded: true })
    list.mockResolvedValue([profile('a')])
    await mount()
    await act(async () => { useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: true }, isLoaded: true }) })
    await flush()
    expect(authInfo).toHaveBeenCalled()
    expect(fetchAllStream).toHaveBeenCalled()
    latest().emit(usage('a', 12))
    await flush()
    expect(container.textContent).toContain('12%')
  })
})

// Usage track MP4 (the approved canvas, Account usage option A): sections by
// provider. Claude-only is the page as it was; Codex-only has the D5 line, then
// the Codex section; with both, each section has its heading and count.
const cxAccount = (id: string, over: Partial<AccountView> = {}): AccountView => ({
  id, providerId: 'codex', identityId: `identity-${id}`, lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false,
  authMethod: 'browser', lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted',
  realmLifecycle: 'active', external: false, unverified: false, legacyLinked: false, runningSessions: 0, runningReviews: 0, consumers: 0,
  ...over,
})
const snapshotOf = (accounts: AccountView[]): AccountsSnapshot => ({
  revision: 1, registry: { mode: 'ready' } as AccountsSnapshot['registry'],
  providers: [{ providerId: 'claude', displayName: 'Claude Code' }, { providerId: 'codex', displayName: 'Codex' }] as AccountsSnapshot['providers'],
  identities: accounts.map((a) => ({ id: a.identityId, friendlyName: `Name ${a.id}`, colourKey: 'plum' })),
  groups: [], accounts, pendingSetups: [], externalDefaults: [], conflicts: [], reviewerNotices: [],
})
const cxView = (accountId: string, percent: number): ProviderAccountUsageView => ({
  accountId, providerId: 'codex', status: 'ok', source: 'live', readingAt: Date.now(),
  buckets: [{ key: 'codex/300:', label: '5h', group: 'session', percent, resetsAt: '', severity: 'normal' }],
})
const heading = (p: string) => container.querySelector(`[data-testid="account-usage-section-${p}"]`) as HTMLElement | null
const foot = () => container.querySelector('[data-testid="account-usage-foot"]')?.textContent ?? ''
const latestCx = (): ProviderStreamCtl => providerStreams[providerStreams.length - 1]

describe('AccountUsagePanel by provider (usage track MP4)', () => {
  afterEach(() => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
    useProviderAccountsStore.setState({ snapshot: null, loaded: false })
    vi.useRealTimers()
  })
  const modes = (o: { claude: boolean; withCodex: boolean }, accounts: AccountView[]) => {
    // The switches as Settings saves them (an answer, either way).
    const saved = { ...choiceSettings(o.withCodex ? 'both' : 'claude'), claudeEnabled: o.claude }
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...saved, codexAnswered: true }, isLoaded: true })
    useProviderAccountsStore.setState({ snapshot: snapshotOf(accounts), loaded: true })
  }

  // Usage track MP8: a closed Codex account may be read afresh while the page
  // streams; the page closing stops that stream in main, and the read with it.
  it('the page closing stops its Codex stream in main (the fresh read under way with it), and only then', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    expect(usageStream).toHaveBeenCalledTimes(1)
    expect(usageStreamStop).not.toHaveBeenCalled()
    act(() => root.unmount())
    expect(usageStreamStop).toHaveBeenCalledTimes(1)
    expect(usageStreamStop).toHaveBeenCalledWith('codex')
    root = createRoot(container)
  })

  it('Claude-only: no headings, the foot says allowances only and keeps the countdown sentence', async () => {
    modes({ claude: true, withCodex: false }, [cxAccount('x')])
    list.mockResolvedValue([profile('a')])
    await mount()
    expect(heading('claude')).toBeNull()
    expect(heading('codex')).toBeNull()
    expect(usageStream).not.toHaveBeenCalled()
    expect(foot()).toContain('Allowances only. Token use and estimated cost are in Tokenomics.')
    expect(foot()).toMatch(/The countdown is the point at which an interactive sign-in becomes unavoidable/)
    latest().done()
  })

  it('Codex-only: the D5 line, then the Codex section with its count; nothing of Claude Code is read', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w'), cxAccount('r')])
    await mount()
    expect(list).not.toHaveBeenCalled()
    expect(authInfo).not.toHaveBeenCalled()
    expect(fetchAllStream).not.toHaveBeenCalled()
    // Opening the page reads afresh (MP8 round 2, ADR-022 bound 7).
    expect(usageStream).toHaveBeenCalledWith('codex', expect.any(Function), { read: true })
    expect(container.textContent).toContain('Claude Code is off. Turn it on in Settings, Accounts to see its accounts.')
    expect(heading('claude')).toBeNull()
    expect(heading('codex')?.textContent).toBe('Codex2 accounts')
    // Skeletons until each view streams in.
    expect(skeletons().length).toBe(2)
    latestCx().emit(cxView('w', 18))
    await flush()
    expect(skeletons().length).toBe(1)
    expect(container.textContent).toContain('Name w')
    expect(container.textContent).toContain('18%')
    latestCx().emit(cxView('r', 6))
    latestCx().done({ ok: true, provider: 'on', accounts: 2 })
    await flush()
    expect(skeletons().length).toBe(0)
    expect(foot()).toContain('Allowances only.')
    expect(foot()).not.toMatch(/countdown/)
    // The D5 line comes first.
    const text = container.textContent ?? ''
    expect(text.indexOf('Claude Code is off')).toBeLessThan(text.indexOf('Codex2 accounts'))
  })

  it('both: a heading with the count for each provider, Claude Code first', async () => {
    modes({ claude: true, withCodex: true }, [cxAccount('w')])
    list.mockResolvedValue([profile('a'), profile('b')])
    await mount()
    expect(heading('claude')?.textContent).toBe('Claude Code2 accounts')
    expect(heading('codex')?.textContent).toBe('Codex1 account')
    const order = Array.from(container.querySelectorAll('[data-testid^="account-usage-section-"]')).map((h) => h.getAttribute('data-testid'))
    expect(order).toEqual(['account-usage-section-claude', 'account-usage-section-codex'])
    latest().emit(usage('a', 30)); latest().emit(usage('b', 40)); latest().done()
    latestCx().emit(cxView('w', 18)); latestCx().done()
    await flush()
    expect(container.textContent).toContain('a@x.com')
    expect(container.textContent).toContain('18%')
  })

  it('a Codex stream that fails leaves Retry rows, and Retry reads that one account', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    latestCx().reject(new Error('stream died'))
    await flush()
    expect(skeletons().length).toBe(0)
    const unavailable = container.querySelectorAll('[data-testid="account-usage-unavailable"]')
    expect(unavailable.length).toBe(1)
    usageOne.mockResolvedValueOnce({ ok: true, usage: cxView('w', 44) })
    await act(async () => { (unavailable[0].querySelector('button') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    // A card's Retry reads afresh (MP8 round 2).
    expect(usageOne).toHaveBeenCalledWith('w', { read: true })
    expect(container.textContent).toContain('44%')
  })

  it('ignores a late Codex view from a stream a Refresh superseded', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    const old = latestCx()
    const refresh = container.querySelector('[data-testid="pf-actions"] button') as HTMLElement
    await act(async () => { refresh.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(providerStreams.length).toBe(2)
    old.emit(cxView('w', 99))
    await flush()
    expect(container.textContent).not.toContain('99%')
    expect(skeletons().length).toBe(1)
    latestCx().emit(cxView('w', 7)); latestCx().done()
    await flush()
    expect(container.textContent).toContain('7%')
  })

  it('a Codex that main answers is off has no section', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    expect(heading('codex')).not.toBeNull()
    latestCx().done({ ok: true, provider: 'off', accounts: 0 })
    await flush()
    expect(heading('codex')).toBeNull()
    expect(skeletons().length).toBe(0)
  })

  it('a parked Codex account shows as parked at once, never as loading', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('p', { lifecycle: 'inactive' })])
    await mount()
    expect(skeletons().length).toBe(0)
    expect(container.textContent).toMatch(/Parked/)
    latestCx().done()
  })

  // MP4 review F1: each provider loads on its own.
  it('switching Codex on or off re-streams Codex alone; Claude Code is not asked again, nor Codex by Claude Code\'s switch', async () => {
    modes({ claude: true, withCodex: false }, [cxAccount('w')])
    list.mockResolvedValue([profile('a')])
    await mount()
    expect(usageStream).not.toHaveBeenCalled()
    await act(async () => { modes({ claude: true, withCodex: true }, [cxAccount('w')]) })
    await flush()
    expect(usageStream).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(1)
    expect(authInfo).toHaveBeenCalledTimes(1)
    expect(fetchAllStream).toHaveBeenCalledTimes(1)
    await act(async () => { modes({ claude: false, withCodex: true }, [cxAccount('w')]) })
    await flush()
    expect(usageStream).toHaveBeenCalledTimes(1)
    latest().done(); latestCx().done()
  })

  it('Refresh reloads both providers', async () => {
    modes({ claude: true, withCodex: true }, [cxAccount('w')])
    list.mockResolvedValue([profile('a')])
    await mount()
    const refresh = container.querySelector('[data-testid="pf-actions"] button') as HTMLElement
    await act(async () => { refresh.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(fetchAllStream).toHaveBeenCalledTimes(2)
    expect(usageStream).toHaveBeenCalledTimes(2)
    latest().done(); latestCx().done()
  })

  // MP4 review F2: a registry change reads the account it touched.
  it('an account added to the registry after the stream reads that account alone', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    latestCx().emit(cxView('w', 18)); latestCx().done()
    await flush()
    usageOne.mockResolvedValueOnce({ ok: true, usage: cxView('n', 33) })
    // A parked account added too reads nothing.
    await act(async () => { useProviderAccountsStore.setState({ snapshot: snapshotOf([cxAccount('w'), cxAccount('n'), cxAccount('q', { lifecycle: 'inactive' })]), loaded: true }) })
    await flush()
    expect(usageOne.mock.calls.map((c) => c[0])).toEqual(['n'])
    expect(container.textContent).toContain('33%')
    expect(usageStream).toHaveBeenCalledTimes(1)
  })

  it('a registry change while the stream runs waits for it to end (no second read beside it)', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    usageOne.mockResolvedValueOnce({ ok: true, usage: cxView('n', 33) })
    await act(async () => { useProviderAccountsStore.setState({ snapshot: snapshotOf([cxAccount('w'), cxAccount('n')]), loaded: true }) })
    await flush()
    expect(usageOne).not.toHaveBeenCalled()
    latestCx().emit(cxView('w', 18)); latestCx().done()
    await flush()
    expect(usageOne.mock.calls.map((c) => c[0])).toEqual(['n'])
    expect(container.textContent).toContain('33%')
  })

  it('an account signed back in reads again', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w', { lastKnownAuthState: 'signed-out' })])
    await mount()
    latestCx().emit({ ...cxView('w', 10), status: 'not-signed-in', source: 'last-seen' }); latestCx().done()
    await flush()
    expect(container.textContent).toContain('Sign in again')
    usageOne.mockResolvedValueOnce({ ok: true, usage: cxView('w', 44) })
    await act(async () => { useProviderAccountsStore.setState({ snapshot: snapshotOf([cxAccount('w', { lastKnownAuthState: 'signed-in' })]), loaded: true }) })
    await flush()
    // A registry change shows what is there; it does not read afresh.
    expect(usageOne).toHaveBeenCalledWith('w', { read: false })
    expect(container.textContent).toContain('44%')
    expect(container.textContent).not.toContain('Sign in again')
  })

  // MP6 review N1: a focus reloads Codex alone; Claude Code's closed accounts
  // call a rate-limited endpoint and keep their own cadence.
  it('coming back to the window reloads Codex quietly, at most once a minute, and never re-asks Claude Code', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    modes({ claude: true, withCodex: true }, [cxAccount('w')])
    list.mockResolvedValue([profile('a')])
    await mount()
    latest().emit(usage('a', 20)); latest().done()
    latestCx().emit(cxView('w', 18)); latestCx().done()
    await flush()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(usageStream).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + FOCUS_REFRESH_MS + 1)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await flush()
    expect(usageStream).toHaveBeenCalledTimes(2)
    // The focus reload never reads afresh (MP8 round 2, ADR-022 bound 7).
    expect(usageStream.mock.calls.map((c) => c[2])).toEqual([{ read: true }, { read: false }])
    expect(fetchAllStream).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(1)
    expect(authInfo).toHaveBeenCalledTimes(1)
    // Quiet: the figures stay while the new stream runs.
    expect(container.textContent).toContain('20%')
    expect(container.textContent).toContain('18%')
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(usageStream).toHaveBeenCalledTimes(2)
    latestCx().done()
  })

  // MP6 review N2: the registry copy arriving after the stream started is
  // not a change to read every account again for.
  it('a registry copy arriving while the stream runs reads nothing again', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...choiceSettings('codex'), codexAnswered: true }, isLoaded: true })
    useProviderAccountsStore.setState({ snapshot: null, loaded: false })
    await mount()
    expect(usageStream).toHaveBeenCalledTimes(1)
    latestCx().emit(cxView('w', 18)); latestCx().emit(cxView('r', 6))
    await act(async () => { useProviderAccountsStore.setState({ snapshot: snapshotOf([cxAccount('w'), cxAccount('r')]), loaded: true }) })
    latestCx().done()
    await flush()
    expect(usageOne).not.toHaveBeenCalled()
    expect(container.textContent).toContain('18%')
    expect(container.textContent).toContain('6%')
  })

  // MP4 review F3.
  it('a Retry row names its account, and its Retry says whose', async () => {
    modes({ claude: true, withCodex: true }, [cxAccount('w')])
    list.mockResolvedValue([profile('a')])
    await mount()
    latest().reject(new Error('stream died'))
    latestCx().reject(new Error('stream died'))
    await flush()
    const rows = Array.from(container.querySelectorAll('[data-testid="account-usage-unavailable"]'))
    expect(rows.map((r) => r.querySelector('[data-testid="account-usage-unavailable-name"]')?.textContent)).toEqual(['a@x.com', 'Name w'])
    expect(rows.map((r) => r.querySelector('button')?.getAttribute('aria-label'))).toEqual(['Retry a@x.com', 'Retry Name w'])
  })

  // MP4 review F4.
  it('a failed Claude Code list: its heading with no count, the error in its place, Codex still drawn', async () => {
    modes({ claude: true, withCodex: true }, [cxAccount('w')])
    list.mockRejectedValue(new Error('profiles read failed'))
    await mount()
    expect(heading('claude')?.textContent).toBe('Claude Code')
    expect(container.textContent).toMatch(/Couldn.t load account usage/)
    expect(heading('codex')?.textContent).toBe('Codex1 account')
    latestCx().done()
  })

  // MP4 review F6.
  it('section headings are headings, and the foot\'s Tokenomics link opens Tokenomics', async () => {
    modes({ claude: true, withCodex: true }, [cxAccount('w')])
    list.mockResolvedValue([profile('a')])
    const onOpenTokenomics = vi.fn()
    await act(async () => { root.render(<AccountUsagePanel onClose={() => {}} onReauthNavigate={() => {}} onOpenTokenomics={onOpenTokenomics} />) })
    await flush()
    expect(Array.from(container.querySelectorAll('h2')).map((h) => h.getAttribute('data-testid'))).toEqual(['account-usage-section-claude', 'account-usage-section-codex'])
    const link = Array.from(container.querySelectorAll('[data-testid="account-usage-foot"] button')).find((b) => b.textContent === 'Tokenomics') as HTMLElement
    await act(async () => { link.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onOpenTokenomics).toHaveBeenCalledTimes(1)
    latest().done(); latestCx().done()
  })

  it('a Codex account whose realm cannot be used shows the Retry row', async () => {
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    latestCx().emit({ accountId: 'w', providerId: 'codex', status: 'error', buckets: [] })
    latestCx().done()
    await flush()
    expect(container.querySelectorAll('[data-testid="account-usage-unavailable"]').length).toBe(1)
  })

  it('a window that resets while the page is open turns to "no reading since" (D2)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    modes({ claude: false, withCodex: true }, [cxAccount('w')])
    await mount()
    const soon = new Date(Date.now() + 60_000).toISOString()
    latestCx().emit({ ...cxView('w', 18), buckets: [{ key: 'codex/300:', label: '5h', group: 'session', percent: 18, resetsAt: soon, severity: 'normal' }] })
    latestCx().done()
    await flush()
    expect(container.textContent).toContain('18%')
    await act(async () => { vi.advanceTimersByTime(61_000) })
    expect(container.textContent).not.toContain('18%')
    expect(container.textContent).toMatch(/no reading since/)
  })
})

// [host] P4.11 (owner queue, PR 3 gate 6 observation 2, pre-existing): an open
// page's "Updated <age>" ages while the page stays open, on Claude's cards and
// Codex's alike. The age was read once per render, and the page re-rendered
// only on new data or at the next reset, so it kept "Updated just now".
describe('AccountUsagePanel: the age line ages while the page stays open (P4.11)', () => {
  afterEach(() => {
    vi.useRealTimers()
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
    useProviderAccountsStore.setState({ snapshot: null, loaded: false })
  })

  it('[host] a Claude card: "Updated just now", then "Updated 2 min ago" two minutes on, with no new data', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    list.mockResolvedValue([profile('a')])
    await mount()
    latest().emit(usage('a', 41))
    latest().done()
    await flush()
    expect(container.textContent).toContain('Updated just now')
    await act(async () => { vi.advanceTimersByTime(2 * 60_000 + 1_000) })
    expect(container.textContent).toContain('Updated 2 min ago')
    expect(container.textContent).not.toContain('Updated just now')
    expect(fetchAllStream).toHaveBeenCalledTimes(1)
  })

  it('[host] a Codex card: the same', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...choiceSettings('codex'), codexAnswered: true }, isLoaded: true })
    useProviderAccountsStore.setState({ snapshot: snapshotOf([cxAccount('w')]), loaded: true })
    await mount()
    latestCx().emit(cxView('w', 18))
    latestCx().done({ ok: true, provider: 'on', accounts: 1 })
    await flush()
    expect(container.textContent).toContain('Updated just now')
    await act(async () => { vi.advanceTimersByTime(2 * 60_000 + 1_000) })
    expect(container.textContent).toContain('Updated 2 min ago')
    expect(usageStream).toHaveBeenCalledTimes(1)
  })
})
