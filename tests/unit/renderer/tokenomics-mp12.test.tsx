// @vitest-environment jsdom
/// <reference types="vite/client" />
/**
 * Usage track MP12 (owner decisions Q1.4, Q1.5; the approved canvas
 * "Tokenomics with two providers", option A): the Tokenomics page with two
 * providers. The labels, groups, notices and tooltips (tk-labels), and the
 * filter bar, KPI split, cost series, "no price" rows, account column and
 * drawer line, and the heatmap while usage is sorted by account. Host-safe:
 * jsdom and the real stores, the preload API faked.
 */
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountsSnapshot } from '../../../src/shared/providers'
import type { TkAccountPresent, TkSummary, TkSessionRow, TkSessionDetail } from '../../../src/shared/types'
import {
  tkAccountLabel, tkAccountGroups, tkCostTooltip, tkUnpricedNotice, tkRereadNotice, tkKpiSplit, tkProvidersWithData,
  tkParseAccountValue, tkAccountValue, tkSeriesInRange, TK_NOT_RECORDED, TK_THIS_COMPUTER, TK_CODEX_COST_NOTE, TK_NO_PRICE_NOTE,
} from '../../../src/renderer/components/tokenomics/tk-labels'
import { useTokenomicsStore } from '../../../src/renderer/stores/tokenomicsStore'
import { useProviderAccountsStore } from '../../../src/renderer/stores/providerAccountsStore'
import { FilterBar } from '../../../src/renderer/components/tokenomics/FilterBar'
import { KpiRow } from '../../../src/renderer/components/tokenomics/KpiRow'
import { CostOverTimeChart } from '../../../src/renderer/components/tokenomics/CostOverTimeChart'
import { ModelCacheDonut } from '../../../src/renderer/components/tokenomics/ModelCacheDonut'
import { ActivityHeatmap } from '../../../src/renderer/components/tokenomics/ActivityHeatmap'
import { SessionsTable } from '../../../src/renderer/components/tokenomics/SessionsTable'
import { SessionDetailDrawer } from '../../../src/renderer/components/tokenomics/SessionDetailDrawer'
import { CostByConfig } from '../../../src/renderer/components/tokenomics/CostByConfig'
import pageSource from '../../../src/renderer/components/TokenomicsPage.tsx?raw'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const A_WORK = 'acct-' + 'a'.repeat(32)
const A_REVIEW = 'acct-' + 'b'.repeat(32)
const A_OLD = 'acct-' + 'c'.repeat(32)
const SNAPSHOT = {
  revision: 1,
  providers: [],
  identities: [
    { id: 'id-work', friendlyName: 'Work', colourKey: 'slate-blue' },
    { id: 'id-review', friendlyName: 'Reviewer', colourKey: 'pink' },
    { id: 'id-old', friendlyName: 'Side project' },
  ],
  accounts: [
    { id: A_WORK, providerId: 'claude', identityId: 'id-work', lifecycle: 'active', authMethod: 'browser', external: false },
    { id: A_REVIEW, providerId: 'codex', identityId: 'id-review', lifecycle: 'active', authMethod: 'apiKey', external: false },
    { id: A_OLD, providerId: 'codex', identityId: 'id-old', lifecycle: 'archived', authMethod: 'browser', external: false },
  ],
} as unknown as AccountsSnapshot
const PRESENT: TkAccountPresent[] = [
  { provider: 'claude', accountKey: '' },
  { provider: 'claude', accountKey: `claude:${A_WORK}` },
  { provider: 'codex', accountKey: '' },
  { provider: 'codex', accountKey: 'codex:external' },
  { provider: 'codex', accountKey: `codex:${A_REVIEW}` },
  { provider: 'codex', accountKey: `codex:${A_OLD}` },
]
const K = (v: number) => ({ lifeToDateCostUsd: v, last7dCostUsd: v / 10, prev7dCostUsd: v / 20, cacheEfficiencyPct: 50, cacheSavingsUsd: 1 })
function summary(over: Partial<TkSummary> = {}): TkSummary {
  return {
    kpis: K(1284.4),
    kpisByProvider: { claude: K(1102.1), codex: K(182.3) },
    dailySeries: [
      { day: '2026-09-25', costUsd: 10, byProvider: { claude: 7, codex: 3 } },
      { day: '2026-09-26', costUsd: 12, byProvider: { claude: 8, codex: 4 } },
    ],
    modelSplit: [{ model: 'claude-opus-4-8', costUsd: 824.1, tokens: 1 }, { model: 'gpt-5.4', costUsd: null, tokens: 1_000_000 }],
    unpriced: [{ model: 'gpt-5.4', provider: 'codex', tokens: 1_000_000 }, { model: 'gpt-5.4-mini', provider: 'codex', tokens: 400_000 }],
    cacheSplit: { inputUsd: 1, outputUsd: 1, cacheReadUsd: 1, cacheCreateUsd: 1 },
    costByConfig: [],
    heatmap: [],
    ...over,
  }
}

describe('the labels (MP12)', () => {
  it('names an account, this computer\'s sign-in, not recorded, an archived and a removed account', () => {
    expect(tkAccountLabel(SNAPSHOT, `claude:${A_WORK}`)).toBe('Work')
    expect(tkAccountLabel(SNAPSHOT, 'codex:external')).toBe(TK_THIS_COMPUTER)
    expect(tkAccountLabel(SNAPSHOT, '')).toBe(TK_NOT_RECORDED)
    expect(tkAccountLabel(SNAPSHOT, `codex:${A_OLD}`)).toBe('Side project (archived)')
    expect(tkAccountLabel(SNAPSHOT, `codex:acct-${'d'.repeat(32)}`)).toBe('Removed account')
    // An account id under the wrong provider is not that account.
    expect(tkAccountLabel(SNAPSHOT, `codex:${A_WORK}`)).toBe('Removed account')
  })

  it('groups the Account filter by provider, with "Not recorded" under Codex as under Claude', () => {
    const groups = tkAccountGroups(PRESENT, SNAPSHOT)
    expect(groups.map((g) => [g.label, g.options.map((o) => o.label)])).toEqual([
      ['Claude Code', ['Work', TK_NOT_RECORDED]],
      ['Codex', ['Reviewer', 'Side project (archived)', TK_THIS_COMPUTER, TK_NOT_RECORDED]],
    ])
    // The two "Not recorded" entries are told apart by their provider.
    const notRecorded = groups.flatMap((g) => g.options).filter((o) => o.label === TK_NOT_RECORDED)
    expect(notRecorded.map((o) => tkParseAccountValue(o.value))).toEqual([{ provider: 'claude', key: '' }, { provider: 'codex', key: '' }])
    // One provider chosen: its group only.
    expect(tkAccountGroups(PRESENT, SNAPSHOT, 'codex').map((g) => g.provider)).toEqual(['codex'])
    // A provider with no usage has no group.
    expect(tkAccountGroups([{ provider: 'claude', accountKey: '' }], SNAPSHOT).map((g) => g.provider)).toEqual(['claude'])
    expect(tkParseAccountValue('nope')).toBeNull()
    expect(tkParseAccountValue(tkAccountValue('codex', 'codex:external'))).toEqual({ provider: 'codex', key: 'codex:external' })
  })

  it('words each session\'s cost per provider (Q1.5), and says when there is no price', () => {
    // As the approved canvas words them (MP12 round 1).
    expect(tkCostTooltip('claude', `claude:${A_WORK}`, SNAPSHOT, 3)).toBe('API-equivalent estimate')
    expect(tkCostTooltip('codex', `codex:${A_REVIEW}`, SNAPSHOT, 3)).toBe('Estimate at API list prices')
    expect(tkCostTooltip('codex', 'codex:external', SNAPSHOT, 3)).toBe('API-equivalent estimate')
    expect(tkCostTooltip('codex', '', SNAPSHOT, 3)).toBe('API-equivalent estimate')
    expect(tkCostTooltip('codex', `codex:${A_REVIEW}`, SNAPSHOT, null)).toBe(TK_NO_PRICE_NOTE)
    expect(TK_NO_PRICE_NOTE).toBe('No price yet, so not in the totals.')
    expect(TK_CODEX_COST_NOTE).toBe('ChatGPT sign-in: API-equivalent estimate. API key: Estimate at API list prices.')
  })

  it('the unpriced notice names the models and their tokens', () => {
    expect(tkUnpricedNotice(summary().unpriced)).toBe('gpt-5.4 and gpt-5.4-mini have no price yet (1.4M tokens), so their cost is not in these figures.')
    expect(tkUnpricedNotice([{ model: 'gpt-5.4', provider: 'codex', tokens: 220_000 }])).toBe('gpt-5.4 has no price yet (220.0k tokens), so its cost is not in these figures.')
    expect(tkUnpricedNotice([{ model: 'a', provider: 'codex', tokens: 1 }, { model: 'b', provider: 'claude', tokens: 1 }, { model: 'c', provider: 'codex', tokens: 1 }])).toMatch(/^a, b and c have no price yet/)
    expect(tkUnpricedNotice([])).toBeNull()
    expect(tkUnpricedNotice(undefined)).toBeNull()
  })

  it('the notice while usage is sorted by account, in both stages, says the totals are complete', () => {
    expect(tkRereadNotice({ stage: 'reread', done: 3, total: 12 })).toBe('Sorting Codex history by account: 3 of 12 files. Totals are complete; the split by account fills in.')
    expect(tkRereadNotice({ stage: 'rebuild', done: 5000, total: 21000 })).toBe('Sorting usage by account and provider: 5000 of 21000 entries. Totals are complete; the split fills in.')
    expect(tkRereadNotice({ stage: 'reread', done: 0, total: 0 })).toBe('Sorting Codex history by account. Totals are complete; the split by account fills in.')
    expect(tkRereadNotice(null)).toBeNull()
  })

  it('the KPI split: both providers with usage and none chosen; "no price" for a provider whose usage has no price at all', () => {
    const s = summary()
    expect(tkKpiSplit(s, PRESENT)).toMatchObject({ providers: ['claude', 'codex'], noPrice: [] })
    expect(tkKpiSplit(s, PRESENT, 'codex')).toBeUndefined()
    expect(tkKpiSplit(s, [{ provider: 'claude', accountKey: '' }])).toBeUndefined()
    const allUnpriced = summary({ kpisByProvider: { claude: K(10), codex: K(0) } })
    expect(tkKpiSplit(allUnpriced, PRESENT)?.noPrice).toEqual(['codex'])
    // A provider with no cost but nothing unpriced is $0, not "no price".
    expect(tkKpiSplit(summary({ kpisByProvider: { claude: K(10), codex: K(0) }, unpriced: [] }), PRESENT)?.noPrice).toEqual([])
    expect(tkProvidersWithData(PRESENT)).toEqual(['claude', 'codex'])
  })

  // MP12 round 1: a series only for a provider with cost in the range shown.
  it('the cost chart\'s series: the providers with cost in the range shown, or none when fewer than two', () => {
    const both = summary().dailySeries
    expect(tkSeriesInRange(['claude', 'codex'], both)).toEqual(['claude', 'codex'])
    const claudeOnly = [{ day: '2026-09-26', costUsd: 8, byProvider: { claude: 8, codex: 0 } }]
    expect(tkSeriesInRange(['claude', 'codex'], claudeOnly)).toBeUndefined()
    expect(tkSeriesInRange(['claude', 'codex'], [])).toBeUndefined()
    expect(tkSeriesInRange(undefined, both)).toBeUndefined()
  })
})

describe('the components (MP12)', () => {
  let container: HTMLDivElement
  let root: Root
  const api = {
    summary: vi.fn(async () => summary()),
    sessions: vi.fn(async () => ({ rows: [], nextCursor: null })),
    accounts: vi.fn(async () => PRESENT),
  }
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    ;(window as any).electronAPI = { ...((window as any).electronAPI ?? {}), tokenomics: api }
    api.summary.mockClear(); api.sessions.mockClear(); api.accounts.mockClear()
    useProviderAccountsStore.setState({ snapshot: SNAPSHOT, loaded: true })
    useTokenomicsStore.setState({ summary: summary(), accounts: PRESENT, filter: { range: 'all' }, sessions: [], selected: null, nextCursor: null, loadingSessions: false })
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })
  const render = (el: ReturnType<typeof createElement>) => act(() => { root.render(el) })

  it('the filter bar: Provider only when both have usage; Account grouped, "Not recorded" under both', async () => {
    render(createElement(FilterBar))
    expect(container.querySelector('[data-testid="tk-provider-filter"]')?.textContent).toBe('AllClaude CodeCodex')
    // MP12 round 1: a labelled group, each provider with its mark, and which is pressed.
    const group = container.querySelector('[data-testid="tk-provider-filter"]') as HTMLElement
    expect(group.getAttribute('role')).toBe('group')
    expect(document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Provider')
    const buttons = () => [...group.querySelectorAll('button')]
    expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])
    expect(buttons().map((b) => b.querySelector('[data-testid^="provider-mark-"]')?.getAttribute('data-testid') ?? null))
      .toEqual([null, 'provider-mark-claude', 'provider-mark-codex'])
    await act(async () => { buttons()[2].click() })
    expect(buttons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true'])
    await act(async () => { buttons()[0].click() })
    // The Account select has a real label.
    const labelled = container.querySelector('[data-testid="tk-account-filter"]') as HTMLSelectElement
    expect([...(labelled.labels ?? [])].map((l) => l.textContent)).toEqual(['Account'])
    const groups = [...container.querySelectorAll('[data-testid="tk-account-filter"] optgroup')].map((g) => [g.getAttribute('label'), [...g.querySelectorAll('option')].map((o) => o.textContent)])
    expect(groups).toEqual([
      ['Claude Code', ['Work', TK_NOT_RECORDED]],
      ['Codex', ['Reviewer', 'Side project (archived)', TK_THIS_COMPUTER, TK_NOT_RECORDED]],
    ])
    // Choosing Codex's "Not recorded" asks for Codex's usage with no account.
    const select = container.querySelector('[data-testid="tk-account-filter"]') as HTMLSelectElement
    await act(async () => {
      select.value = tkAccountValue('codex', '')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(useTokenomicsStore.getState().filter.account).toEqual({ provider: 'codex', key: '' })
    expect(api.summary).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'codex', accountKey: '' }))
    // One provider only: no Provider control.
    act(() => { useTokenomicsStore.setState({ accounts: [{ provider: 'claude', accountKey: '' }] }) })
    expect(container.querySelector('[data-testid="tk-provider-filter"]')).toBeNull()
    expect(container.querySelector('[data-testid="tk-account-filter"]')).not.toBeNull()
  })

  it('the KPIs: each split between the providers with a legend, and "no price" for a provider with no price', () => {
    const s = summary({ kpisByProvider: { claude: K(1102.1), codex: K(0) } })
    render(createElement(KpiRow, { kpis: s.kpis, split: tkKpiSplit(s, PRESENT) }))
    const splits = [...container.querySelectorAll('[data-testid="tk-kpi-split"]')]
    expect(splits).toHaveLength(3)
    expect(splits[0].textContent).toBe('Claude Code $1.1kCodex no price')
    expect(splits[2].textContent).toBe('Claude Code 50%Codex 50%')
    // As drawn (MP12 round 1): every split has its bar, the cache one too,
    // sized by each provider's share of the savings.
    for (const s of splits) expect(s.querySelector('[data-testid="tk-kpi-split-bar"]')).not.toBeNull()
    expect([...splits[2].querySelectorAll('[data-testid="tk-kpi-split-bar"] > div')].map((d) => (d as HTMLElement).style.width)).toEqual(['50%', '50%'])
    // The Codex cost legend carries the wording per sign-in; the others do not.
    expect(splits[0].querySelector('[data-testid="tk-kpi-legend-codex"]')?.getAttribute('title')).toBe(TK_CODEX_COST_NOTE)
    expect(splits[1].querySelector('[data-testid="tk-kpi-legend-codex"]')?.getAttribute('title')).toBe(TK_CODEX_COST_NOTE)
    expect(splits[2].querySelector('[data-testid="tk-kpi-legend-codex"]')?.hasAttribute('title')).toBe(false)
    expect(splits[0].querySelector('[data-testid="tk-kpi-legend-claude"]')?.hasAttribute('title')).toBe(false)
    // "no price" in muted italics.
    const np = [...splits[0].querySelectorAll('span')].find((e) => e.textContent === 'no price') as HTMLElement
    expect(np.className).toContain('italic')
    // No split given: none shown.
    render(createElement(KpiRow, { kpis: s.kpis }))
    expect(container.querySelectorAll('[data-testid="tk-kpi-split"]')).toHaveLength(0)
  })

  it('the cost chart: one line per provider with a legend when both are shown; the total line otherwise', () => {
    render(createElement(CostOverTimeChart, { data: summary().dailySeries, series: ['claude', 'codex'] }))
    expect(container.querySelector('[data-testid="tk-cost-series-legend"]')?.textContent).toBe('Claude CodeCodex')
    expect(container.querySelector('[data-testid="tk-cost-series-claude"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="tk-cost-series-codex"]')).not.toBeNull()
    render(createElement(CostOverTimeChart, { data: summary().dailySeries }))
    expect(container.querySelector('[data-testid="tk-cost-series-legend"]')).toBeNull()
    expect(container.querySelector('[data-testid="tk-cost-series-claude"]')).toBeNull()
  })

  it('the model breakdown lists a model with no price as "no price", never as a $0 slice', () => {
    const s = summary()
    render(createElement(ModelCacheDonut, { modelSplit: s.modelSplit, cacheSplit: s.cacheSplit }))
    const rows = [...container.querySelectorAll('[data-testid="tk-no-price-model"]')]
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toMatch(/no price$/)
    // As drawn (MP12 round 1): the model's own colour, not a dashed outline;
    // the words muted and italic.
    const swatch = rows[0].firstElementChild as HTMLElement
    expect(swatch.style.border).toBe('')
    expect(swatch.style.backgroundColor).not.toBe('')
    expect((rows[0].lastElementChild as HTMLElement).className).toContain('italic')
    expect(container.textContent).not.toContain('$0.00')
  })

  it('the heatmap says its hours are filling in while usage is sorted by account', () => {
    render(createElement(ActivityHeatmap, { data: [], filling: true }))
    expect(container.querySelector('[data-testid="tk-heatmap-filling"]')?.textContent).toBe('Filling in as usage is sorted by account.')
    render(createElement(ActivityHeatmap, { data: [] }))
    expect(container.querySelector('[data-testid="tk-heatmap-filling"]')).toBeNull()
  })

  const row = (over: Partial<TkSessionRow>): TkSessionRow => ({
    sessionId: 's', provider: 'codex', configId: null, configLabel: 'Website', model: 'gpt-5.5', costUsd: 3.12, unpricedTokens: 0,
    inTok: 1, outTok: 1, cacheReadTok: 1, cacheCreateTok: 0, msgCount: 1, lastTs: Date.parse('2026-09-26T10:00:00Z'), accountKey: '', ...over,
  })

  it('the sessions table: the provider mark in the Model cell, the Account column, and the cost wording per provider', () => {
    useTokenomicsStore.setState({ sessions: [
      row({ sessionId: 'a', provider: 'claude', model: 'claude-opus-4-8', accountKey: `claude:${A_WORK}`, costUsd: 8.4 }),
      row({ sessionId: 'b', accountKey: `codex:${A_REVIEW}` }),
      row({ sessionId: 'c', accountKey: 'codex:external', costUsd: null, unpricedTokens: 5 }),
      row({ sessionId: 'd', accountKey: '' }),
    ] })
    render(createElement(SessionsTable))
    expect([...container.querySelectorAll('th')].map((h) => h.textContent)).toContain('Account')
    const accounts = [...container.querySelectorAll('[data-testid="tk-session-account"]')]
    expect(accounts.map((c) => c.textContent)).toEqual(['Work', 'Reviewer', TK_THIS_COMPUTER, TK_NOT_RECORDED])
    expect(container.querySelectorAll('[data-testid="provider-mark-claude"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid="provider-mark-codex"]')).toHaveLength(3)
    // As drawn (MP12 round 1): an account's identity chip beside its name,
    // in its own colour; none where there is no account; "Not recorded" and
    // "This computer's sign-in" muted (the canvas draws both dim).
    const cells = accounts.map((c) => c.closest('td') as HTMLElement)
    const chips = cells.map((td) => (td.querySelector('span[aria-hidden="true"]') as HTMLElement | null)?.style.backgroundColor ?? null)
    expect(chips.map((c) => c !== null && c !== '')).toEqual([true, true, false, false])
    expect(chips[0]).not.toBe(chips[1])
    expect(cells.map((td) => td.style.color)).toEqual(['var(--text-secondary)', 'var(--text-secondary)', 'var(--text-muted)', 'var(--text-muted)'])
    const titles = [...container.querySelectorAll('tbody tr')].map((tr) => (tr.querySelectorAll('td')[3] as HTMLElement).title)
    expect(titles).toEqual(['API-equivalent estimate', 'Estimate at API list prices', TK_NO_PRICE_NOTE, 'API-equivalent estimate'])
  })

  // MP11 round 1 (Q-1): costs of $100 and more keep their dollar sign.
  it('costs of $100 and more keep their dollar sign in the table and the drawer', () => {
    useTokenomicsStore.setState({ sessions: [
      row({ sessionId: 'a', costUsd: 99.5 }), row({ sessionId: 'b', costUsd: 100 }), row({ sessionId: 'c', costUsd: 150.4 }), row({ sessionId: 'd', costUsd: 1234.6 }),
    ] })
    render(createElement(SessionsTable))
    const costs = [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('td')[3].textContent)
    expect(costs).toEqual(['$99.5', '$100', '$150', '$1235'])
    const detail: TkSessionDetail = { ...row({ costUsd: 150.4 }), firstTs: 1, projectDir: '', byModel: [{ model: 'gpt-5.5', costUsd: 120, inTok: 1, outTok: 1, cacheReadTok: 0, cacheCreateTok: 0, msgCount: 1 }] }
    useTokenomicsStore.setState({ selected: detail })
    render(createElement(SessionDetailDrawer))
    expect(container.textContent).toContain('$150')
    expect(container.textContent).toContain('$120')
    expect(container.textContent).not.toMatch(/(^|[^$\d.])150([^\d.]|$)/)
  })

  // MP11 round 1 (Q-2): a config whose usage has no price reads "no price".
  it('cost by config: "no price" for a config with no price, and dollar amounts otherwise', () => {
    render(createElement(CostByConfig, { data: [
      { configId: 'a', label: 'App', costUsd: 1234.5, sessions: 3 },
      { configId: 'b', label: 'Site', costUsd: 150, sessions: 1 },
      { configId: 'c', label: 'Lab', costUsd: null, sessions: 2 },
    ] }))
    const text = container.textContent ?? ''
    expect(text).toContain('$1.2k')
    expect(text).toContain('$150')
    expect(text).toContain('no price')
    expect(text).not.toContain('$0.00')
  })

  // MP12 round 1: a provider choice does not outlive the Provider control.
  it('a provider chosen in the filter is cleared once only one provider has usage', async () => {
    useTokenomicsStore.setState({ filter: { range: 'all', provider: 'codex' } })
    api.accounts.mockResolvedValueOnce([{ provider: 'claude', accountKey: '' }])
    await act(async () => { await useTokenomicsStore.getState().refresh() })
    expect(useTokenomicsStore.getState().filter.provider).toBeUndefined()
    expect(api.summary).toHaveBeenLastCalledWith(expect.not.objectContaining({ provider: 'codex' }))
    // While both have usage the choice stays.
    useTokenomicsStore.setState({ filter: { range: 'all', provider: 'codex' } })
    await act(async () => { await useTokenomicsStore.getState().refresh() })
    expect(useTokenomicsStore.getState().filter.provider).toBe('codex')
  })

  it('the drawer names the session\'s account', () => {
    const detail: TkSessionDetail = { ...row({ accountKey: `codex:${A_OLD}` }), firstTs: 1, projectDir: '', byModel: [] }
    useTokenomicsStore.setState({ selected: detail })
    render(createElement(SessionDetailDrawer))
    expect(container.querySelector('[data-testid="tk-detail-account"]')?.textContent).toBe('Side project (archived)')
    expect(container.textContent).toContain('Codex')
  })
})

/** The page's source with its comments removed. */
const page = pageSource.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')

describe('the page wires the split and the notices (MP12)', () => {
  it('passes the split to the KPIs and the chart, the filling state to the heatmap, and shows both notices in the filesFailed slot', () => {
    expect(page).toMatch(/const split = summary \? tkKpiSplit\(summary, accounts, filter\.provider \?\? filter\.account\?\.provider\) : undefined/)
    expect(page).toMatch(/<KpiRow kpis=\{summary\.kpis\} split=\{split\} \/>/)
    // MP12 round 1: a series only for a provider with cost in the range shown.
    expect(page).toMatch(/<CostOverTimeChart data=\{summary\.dailySeries\} series=\{tkSeriesInRange\(split\?\.providers, summary\.dailySeries\)\} \/>/)
    expect(page).toMatch(/const rereading = useTokenomicsStore\(\(s\) => !!s\.indexStatus\?\.accountReread\)/)
    expect(page).toMatch(/const splitFilling = rereading && !!\(filter\.provider \|\| filter\.account\)/)
    expect(page).toMatch(/<ActivityHeatmap data=\{summary\.heatmap\} filling=\{splitFilling\} \/>/)
    expect(page).toMatch(/\[unpricedNotice, rereadNotice\]\.filter/)
    // Both after the unread-files notice, and the strip before the filter bar.
    expect(page.indexOf('[unpricedNotice, rereadNotice]')).toBeGreaterThan(page.indexOf('transcripts could not be read'))
    expect(page.indexOf('<IndexNotices unpricedNotice={unpricedNotice} />')).toBeGreaterThan(-1)
    expect(page.indexOf('<IndexNotices unpricedNotice={unpricedNotice} />')).toBeLessThan(page.indexOf('<NewFilterBar />'))
  })
})
