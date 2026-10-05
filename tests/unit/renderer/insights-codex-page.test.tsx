// @vitest-environment jsdom
// [host] WP2 PR 4, P4.7 (row 68): the Insights page with Codex accounts, as
// the approved mockup draws it (Agent Canvas, 2026-10-05, v1; screens 1 to 9
// and C1 = A). The real page and stores; window.electronAPI is a fake.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn(), retryFailedConfigSaves: vi.fn() }))

const ACCT = `acct-${'a'.repeat(16)}`
const ACCT2 = `acct-${'b'.repeat(16)}`
const EXT = `acct-${'c'.repeat(16)}`

const files = vi.hoisted(() => ({ report: {} as Record<string, string | null>, kpis: {} as Record<string, unknown> }))
const api = {
  insights: {
    run: vi.fn(async (_o?: unknown) => 'run-new'),
    runAll: vi.fn(async (_o?: unknown) => 'run-all'),
    getReport: vi.fn(async (id: string) => files.report[id] ?? null),
    getKpis: vi.fn(async (id: string) => files.kpis[id] ?? null),
    getCatalogue: vi.fn(async () => ({ runs: [] })),
    isRunning: vi.fn(async () => false),
  },
  tokenomics: { summary: vi.fn(async () => null) },
  accountProfiles: { authInfo: vi.fn(async () => []) },
}
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, ...api }

const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useInsightsStore } = await import('../../../src/renderer/stores/insightsStore')
const { useAccountProfilesStore } = await import('../../../src/renderer/stores/accountProfilesStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { default: InsightsPage } = await import('../../../src/renderer/components/InsightsPage')

const account = (id: string, identityId: string, over: Record<string, unknown> = {}) => ({
  id, providerId: 'codex', identityId, lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false, authMethod: 'chatgpt',
  providerLabel: `${identityId}@example.com`, lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'verified-subject',
  realmLifecycle: 'ready', external: false, unverified: false, legacyLinked: false, runningSessions: 0, runningReviews: 0, consumers: 0, ...over,
})
function snapshot(accounts: unknown[], codex: { enabled?: boolean; preference?: string } = {}) {
  return {
    revision: 1, registry: { mode: 'normal' }, groups: [], pendingSetups: [], conflicts: [], reviewerNotices: [],
    externalDefaults: [{ providerId: 'codex', folder: '~/.codex' }],
    providers: [{ providerId: 'codex', displayName: 'Codex', enabled: codex.enabled ?? true, preference: codex.preference ?? 'on', discoveryState: 'found' }],
    identities: [{ id: 'work', friendlyName: 'Work' }, { id: 'rev', friendlyName: 'Reviewer' }, { id: 'ext', friendlyName: '' }],
    accounts,
  } as never
}
const CODEX_ACCOUNTS = [account(ACCT, 'work', { isProviderDefault: true }), account(ACCT2, 'rev'), account(EXT, 'ext', { external: true, providerLabel: 'me@example.com' })]
const settings = (over: Record<string, unknown>) => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, codexEnabled: true, ...over } as never, isLoaded: true })
const profiles = (n: number) => useAccountProfilesStore.setState({
  profiles: [{ id: 'profile-work', accountEmail: 'w@example.com', name: 'Work', isPrimary: true }, { id: 'profile-personal', accountEmail: 'p@example.com', name: 'Personal' }].slice(0, n),
} as never)

const STORED = (horizon = 'A Cloud Agent could run the review pass.') => JSON.stringify({
  version: 1,
  title: 'Codex Insights',
  subtitle: '128 turns across 23 sessions | 2026-09-12 to 2026-10-02',
  sections: [
    { kind: 'at-a-glance', title: 'At a glance', body: "What's working: small edits\nWhat's hindering you: refusals\nQuick win to try: Standard" },
    { kind: 'narrative', title: 'How you use Codex', paragraphs: ['You use Codex mostly for focused edits.'] },
    { kind: 'horizon', title: 'On the horizon', body: horizon },
  ],
})
const KPIS = { period: { start: '2026-09-12', end: '2026-10-02', days: 11 }, kpis: { Volume: { sessions: { value: 23, label: 'Sessions', format: 'number', goodDirection: 'up' } } } }

let container: HTMLDivElement
let root: Root
const flush = async () => { await act(async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)) }) }
const render = async () => { await act(async () => { root.render(<InsightsPage />) }); await flush() }
const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const optionTexts = (sel: HTMLElement | null) => Array.from(sel?.querySelectorAll('option') ?? []).map((o) => o.textContent ?? '')
const pick = async (value: string) => {
  const sel = byTest('insights-account-picker') as HTMLSelectElement
  await act(async () => {
    sel.value = value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  for (const f of Object.values(api.insights)) (f as ReturnType<typeof vi.fn>).mockClear()
  files.report = {}
  files.kpis = {}
  settings({})
  profiles(2)
  useProviderAccountsStore.setState({ snapshot: snapshot(CODEX_ACCOUNTS), loaded: true })
  useInsightsStore.setState({ status: 'idle', statusMessage: null, error: null, batchActive: false, selectedRunId: null, catalogue: { runs: [] } as never, loadCatalogue: vi.fn(async () => {}) })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('the account picker (screen 2, D7)', () => {
  it("Claude Code's accounts, then Codex's under its own heading, in the New session dialog's order and labels [host]", async () => {
    await render()
    const picker = byTest('insights-account-picker')
    const groups = Array.from(picker!.querySelectorAll('optgroup')).map((g) => g.label)
    expect(groups).toEqual(['Claude Code', 'Codex'])
    const texts = optionTexts(picker)
    expect(texts.slice(0, 2)).toEqual(['Work (primary)', 'Personal'])
    expect(texts[2]).toBe('Work (Codex)')
    expect(texts[3]).toBe('Reviewer (Codex)')
    expect(texts[4]).toMatch(/Codex.* - confirm at launch$/)
  })

  it('with Codex off or not set up, its accounts leave the picker; no headings for one assistant [host]', async () => {
    settings({ codexEnabled: false })
    useProviderAccountsStore.setState({ snapshot: snapshot(CODEX_ACCOUNTS, { enabled: false, preference: 'off' }), loaded: true })
    await render()
    expect(byTest('insights-account-picker')!.querySelectorAll('optgroup')).toHaveLength(0)
    expect(optionTexts(byTest('insights-account-picker'))).toEqual(['Work (primary)', 'Personal'])
  })

  it('shows with two or more accounts across both assistants (one Claude Code profile and one Codex account) [host]', async () => {
    profiles(1)
    useProviderAccountsStore.setState({ snapshot: snapshot([account(ACCT, 'work', { isProviderDefault: true })]), loaded: true })
    await render()
    expect(optionTexts(byTest('insights-account-picker'))).toEqual(['Work (primary)', 'Work (Codex)'])
  })
})

describe('New run on a Codex account', () => {
  it('runs a report on it, in the S0 shape, with no confirmation [host]', async () => {
    await render()
    await pick(`codex:${ACCT}`)
    await act(async () => { byTest('insights-run-now')!.click() })
    expect(api.insights.run).toHaveBeenCalledWith({ profileId: ACCT, provider: 'codex' })
  })

  it("an account marked 'confirm at launch' asks the cloud agent's confirmation first; Run only once ticked; Cancel runs nothing (screen 4, D12) [host]", async () => {
    await render()
    await pick(`codex:${EXT}`)
    await act(async () => { byTest('insights-run-now')!.click() })
    expect(api.insights.run).not.toHaveBeenCalled()
    const confirm = byTest('insights-codex-confirm')!
    expect(confirm.textContent).toContain('Run this report with the Codex sign-in already on this computer (me@example.com)')
    const runBtn = byTest('insights-codex-confirm-run') as HTMLButtonElement
    expect(runBtn.disabled).toBe(true)
    await act(async () => { byTest('insights-codex-confirm-cancel')!.click() })
    expect(byTest('insights-codex-confirm')).toBeNull()
    expect(api.insights.run).not.toHaveBeenCalled()
    await act(async () => { byTest('insights-run-now')!.click() })
    await act(async () => { (byTest('insights-codex-ack') as HTMLInputElement).click() })
    await act(async () => { (byTest('insights-codex-confirm-run') as HTMLButtonElement).click() })
    expect(api.insights.run).toHaveBeenCalledWith({ profileId: EXT, provider: 'codex', acknowledgeRealmOnly: true })
  })

  it("an unverified account's confirmation uses the agent's other wording [host]", async () => {
    useProviderAccountsStore.setState({ snapshot: snapshot([account(ACCT, 'work', { isProviderDefault: true, unverified: true })]), loaded: true })
    profiles(1)
    await render()
    await pick(`codex:${ACCT}`)
    await act(async () => { byTest('insights-run-now')!.click() })
    expect(byTest('insights-codex-confirm')!.textContent).toContain('Run this report with this account although its sign-in is not verified')
  })
})

describe('an assistant switched off (screen 6, D8)', () => {
  it('Claude Code off: a Codex account is picked and runs; only a Claude account picked is disabled, with the reason [host]', async () => {
    settings({ claudeEnabled: false })
    await render()
    expect((byTest('insights-account-picker') as HTMLSelectElement).value).toBe(`codex:${ACCT}`)
    expect((byTest('insights-run-now') as HTMLButtonElement).disabled).toBe(false)
    expect(byTest('insights-claude-off')).toBeNull()
    await pick('claude:profile-personal')
    expect((byTest('insights-run-now') as HTMLButtonElement).disabled).toBe(true)
    expect(byTest('insights-claude-off')!.textContent).toBe('Claude Code is off. Turn it on in Settings, Accounts.')
  })
})

describe('a Codex-only user with no report yet (screen 9, D9)', () => {
  it("sees the page's own empty state with Run Insights Now and Run all, never the Claude-only message [host]", async () => {
    settings({ claudeEnabled: false })
    profiles(0)
    useProviderAccountsStore.setState({ snapshot: snapshot([account(ACCT, 'work', { isProviderDefault: true }), account(ACCT2, 'rev')]), loaded: true })
    await render()
    expect(container.textContent).toContain('No Insights Yet')
    expect(container.textContent).not.toContain('Insights aggregate from your Claude sessions')
    expect((byTest('insights-run-now') as HTMLButtonElement).disabled).toBe(false)
    expect(byTest('insights-run-all-empty')!.textContent).toBe('Run all (2)')
    await act(async () => { byTest('insights-run-all-empty')!.click() })
    expect(api.insights.runAll).toHaveBeenCalledWith(undefined)
  })

  it('Run all counts every account of both assistants that is on, less one that needs its own confirmation (C1 A) [host]', async () => {
    await render()
    expect(byTest('insights-run-all-empty')!.textContent).toBe('Run all (4)')
  })
})

describe('a Codex report (screens 1, 3, 5)', () => {
  const RUNS = () => [
    { id: 'r-claude', timestamp: Date.UTC(2026, 9, 2, 9, 14), status: 'complete', profileId: 'profile-work', accountEmail: 'w@example.com' },
    { id: 'r-codex-old', timestamp: Date.UTC(2026, 9, 1, 9, 0), status: 'complete', provider: 'codex', profileId: ACCT },
    { id: 'r-codex-failed', timestamp: Date.UTC(2026, 9, 3, 9, 51), status: 'failed', provider: 'codex', profileId: ACCT2, error: "Codex's reply was not a report the page can show, so nothing was kept. Try New run again. (\"atAGlance\" is missing)" },
    { id: 'r-codex', timestamp: Date.UTC(2026, 9, 3, 10, 2), status: 'complete', provider: 'codex', profileId: ACCT },
    { id: 'r-all', timestamp: Date.UTC(2026, 9, 3, 11, 20), status: 'complete', kind: 'aggregate', memberRunIds: ['a', 'b', 'c', 'd'] },
  ]
  const withRuns = (selectedRunId: string) => useInsightsStore.setState({ catalogue: { runs: RUNS() } as never, selectedRunId })

  it('the run picker: a Codex run says Codex with its account; a failed one says so (D6) [host]', async () => {
    files.report['r-codex'] = STORED()
    withRuns('r-codex')
    await render()
    const texts = optionTexts(byTest('insights-run-picker'))
    expect(texts.some((t) => t.endsWith(' \u00b7 Work (Codex)'))).toBe(true)
    expect(texts.some((t) => t.endsWith(' \u00b7 Reviewer (Codex) \u00b7 failed'))).toBe(true)
    expect(texts.some((t) => t.endsWith(' \u00b7 All accounts (4)'))).toBe(true)
    expect(texts.some((t) => t.endsWith(' \u00b7 Work'))).toBe(true)
  })

  it('with one account in all, a Codex run reads "Codex" alone [host]', async () => {
    profiles(0)
    settings({ claudeEnabled: false })
    useProviderAccountsStore.setState({ snapshot: snapshot([account(ACCT, 'work', { isProviderDefault: true })]), loaded: true })
    files.report['r-codex'] = STORED()
    withRuns('r-codex')
    await render()
    expect(optionTexts(byTest('insights-run-picker')).some((t) => t.endsWith(' \u00b7 Codex'))).toBe(true)
  })

  it("the title: Codex's mark, 'Codex Insights' and a '?' that says how the report is made (D3); the cards as text [host]", async () => {
    files.report['r-codex'] = STORED()
    files.kpis['r-codex'] = KPIS
    withRuns('r-codex')
    await render()
    expect(container.querySelector('h2')!.textContent).toContain('Codex Insights')
    expect(container.querySelector('h2 [data-testid="provider-mark-codex"]')).not.toBeNull()
    expect(byTest('insights-codex-help-text')).toBeNull()
    await act(async () => { byTest('insights-codex-help')!.click() })
    expect(byTest('insights-codex-help-text')!.textContent).toContain('Codex has no Insights command of its own, so the app makes this report.')
    expect(container.textContent).toContain('128 turns across 23 sessions | 2026-09-12 to 2026-10-02')
    expect(container.textContent).toContain('How you use Codex')
    expect(container.textContent).toContain('Key Metrics')
  })

  it('markup in a report renders inert: as text, never as elements (beside insights-no-iframe) [host]', async () => {
    files.report['r-codex'] = STORED('<img src=x onerror="window.__pwned=1"><iframe src="https://example.com"></iframe><script>window.__pwned=2</script>')
    withRuns('r-codex')
    await render()
    expect(container.querySelector('img, iframe, script')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=')
    expect((window as any).__pwned).toBeUndefined()
  })

  it('a report.json that does not check shows no report, never anything else [host]', async () => {
    files.report['r-codex'] = JSON.stringify({ version: 1, title: 'Codex Insights', subtitle: '', sections: [{ kind: 'raw-html', html: '<b>x</b>' }] })
    withRuns('r-codex')
    await render()
    expect(container.textContent).toContain('No report available for this run')
  })

  it("a Claude Code report is drawn as before: its own title, no mark, no '?' [host]", async () => {
    files.report['r-claude'] = '<html><h1>Claude Code Insights</h1><div class="subtitle">312 messages</div><div class="narrative"><h2>How you use Claude Code</h2><p>Mostly bug fixes.</p></div></html>'
    withRuns('r-claude')
    await render()
    expect(container.querySelector('h2')!.textContent).toBe('Claude Code Insights')
    expect(byTest('insights-codex-help')).toBeNull()
    expect(container.querySelector('h2 [data-testid="provider-mark-codex"]')).toBeNull()
  })

  it('a failed Codex run shows its reason (screen 5) [host]', async () => {
    withRuns('r-codex-failed')
    await render()
    expect(container.textContent).toContain('This run failed')
    expect(container.textContent).toContain("Codex's reply was not a report the page can show, so nothing was kept.")
  })

  it("'vs previous run' pairs a Codex run with that Codex account's previous run only [host]", async () => {
    files.report['r-codex'] = STORED()
    files.kpis['r-codex'] = KPIS
    files.kpis['r-codex-old'] = KPIS
    withRuns('r-codex')
    await render()
    expect(api.insights.getKpis).toHaveBeenCalledWith('r-codex-old')
    expect(api.insights.getKpis).not.toHaveBeenCalledWith('r-claude')
  })
})

describe('a lapsed Codex sign-in (screen 7, D10)', () => {
  it('is named in the banner with its own line; its button opens Settings, Accounts [host]', async () => {
    useProviderAccountsStore.setState({ snapshot: snapshot([account(ACCT, 'work', { isProviderDefault: true }), account(ACCT2, 'rev', { lastKnownAuthState: 'expired' })]), loaded: true })
    await render()
    expect(byTest('insights-auth-banner')!.textContent).toContain('One account needs to sign in again before Insights can analyse it.')
    expect(byTest('insights-auth-codex-line')!.textContent).toBe('A Codex report cannot run without a working sign-in.')
    const opened: unknown[] = []
    const onOpen = (e: Event) => opened.push((e as CustomEvent).detail)
    window.addEventListener('app:openSettings', onOpen)
    await act(async () => { byTest('insights-reauth-codex')!.click() })
    window.removeEventListener('app:openSettings', onOpen)
    expect(byTest('insights-reauth-codex')!.textContent).toBe('Sign in: Reviewer (Codex)')
    expect(opened).toEqual([{ tab: 'accounts' }])
  })

  it("a Codex account whose latest run failed to sign in, and has not signed in since, is named too [host]", async () => {
    useInsightsStore.setState({ catalogue: { runs: [{ id: 'r1', timestamp: 2000, status: 'failed', provider: 'codex', profileId: ACCT2, authFailed: true, error: 'not signed in' }] } as never })
    useProviderAccountsStore.setState({ snapshot: snapshot([account(ACCT, 'work', { isProviderDefault: true }), account(ACCT2, 'rev', { lastAuthenticatedAt: 1000 })]), loaded: true })
    await render()
    expect(byTest('insights-reauth-codex')!.textContent).toBe('Sign in: Reviewer (Codex)')
    act(() => { root.unmount() })
    root = createRoot(container)
    useProviderAccountsStore.setState({ snapshot: snapshot([account(ACCT, 'work', { isProviderDefault: true }), account(ACCT2, 'rev', { lastAuthenticatedAt: 3000 })]), loaded: true })
    await render()
    expect(byTest('insights-reauth-codex')).toBeNull()
  })
})

describe('the roll-up over both assistants (C1 A, D7)', () => {
  it("each column carries its assistant's mark; a Codex account keeps its own label; the left-out account is named [host]", async () => {
    const runs = [
      { id: 'm1', timestamp: 1, status: 'complete', profileId: 'profile-work', accountEmail: 'w@example.com' },
      { id: 'm2', timestamp: 2, status: 'complete', provider: 'codex', profileId: ACCT, accountEmail: 'w@example.com' },
      {
        id: 'agg', timestamp: 3, status: 'complete', kind: 'aggregate', memberRunIds: ['m1', 'm2'],
        members: [
          { profileId: 'profile-work', label: 'Work', status: 'complete', runId: 'm1' },
          { profileId: ACCT, label: 'Work (Codex)', status: 'complete', runId: 'm2' },
          { profileId: EXT, label: "This computer's Codex", status: 'failed', error: 'needs its own confirmation: run it on its own' },
        ],
      },
    ]
    files.kpis.agg = {
      synthesis: 'ai', windowsComparable: false, uniqueMetrics: [],
      accounts: [{ key: 'A1', runId: 'm1', profileId: 'profile-work', accountEmail: 'w@example.com', label: 'Work', spanDays: 21 }, { key: 'A2', runId: 'm2', profileId: ACCT, accountEmail: 'w@example.com', label: 'Work (Codex)', spanDays: 20 }],
      comparison: [{ metricKey: 'sessions', category: 'Volume', label: 'Sessions', format: 'number', goodDirection: 'up', values: [{ key: 'A1', value: 41 }, { key: 'A2', value: 23 }] }],
    }
    useInsightsStore.setState({ catalogue: { runs } as never, selectedRunId: 'agg' })
    await render()
    const headers = Array.from(container.querySelectorAll('th'))
    // The Codex column shares the Claude profile's email: its name is still its own.
    expect(headers.map((th) => th.textContent)).toEqual(['Metric', 'Work21d window', 'Work (Codex)20d window'])
    expect(headers[1].querySelector('[data-testid="provider-mark-claude"]')).not.toBeNull()
    expect(headers[2].querySelector('[data-testid="provider-mark-codex"]')).not.toBeNull()
    expect(container.textContent).toContain("Left out of this comparison: This computer's Codex (needs its own confirmation: run it on its own)")
  })

  it('a Claude Code roll-up is drawn as it always was: no marks [host]', async () => {
    const runs = [
      { id: 'm1', timestamp: 1, status: 'complete', profileId: 'profile-work' },
      { id: 'm2', timestamp: 2, status: 'complete', profileId: 'profile-personal' },
      { id: 'agg', timestamp: 3, status: 'complete', kind: 'aggregate', memberRunIds: ['m1', 'm2'], members: [] },
    ]
    files.kpis.agg = {
      synthesis: 'ai', windowsComparable: true, uniqueMetrics: [],
      accounts: [{ key: 'A1', runId: 'm1', label: 'Work' }, { key: 'A2', runId: 'm2', label: 'Personal' }],
      comparison: [],
    }
    useInsightsStore.setState({ catalogue: { runs } as never, selectedRunId: 'agg' })
    await render()
    expect(container.querySelector('[data-testid^="provider-mark-"]')).toBeNull()
  })
})
