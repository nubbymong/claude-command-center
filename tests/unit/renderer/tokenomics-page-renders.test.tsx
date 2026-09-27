// @vitest-environment jsdom
/**
 * Usage track MP12 round 1 (quality): the Tokenomics page subscribes only to
 * the index status fields it reads itself, so an index progress tick
 * re-renders the notice strip, not the dashboard; the sessions table and its
 * rows are memoised, so a page re-render or a longer list does not redraw
 * the rows already shown. Host-safe: jsdom and the real stores, the preload
 * API faked; the KPI row and the identity chip are counting stand-ins, and
 * the theme hook (on this page, the sessions table's alone) counts the
 * table's renders.
 */
import { createElement, type ReactNode } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountsSnapshot } from '../../../src/shared/providers'
import type { TkAccountPresent, TkSummary, TkSessionRow } from '../../../src/shared/types'

const renders = vi.hoisted(() => ({ kpi: 0, chip: 0, table: 0 }))
vi.mock('../../../src/renderer/components/tokenomics/KpiRow', () => ({
  KpiRow: () => { renders.kpi++; return null },
}))
vi.mock('../../../src/renderer/components/ui/IdentityChip', () => ({
  IdentityChip: () => { renders.chip++; return null },
}))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({
  useThemeController: () => {},
  getResolvedTheme: () => 'dark',
  useResolvedTheme: () => { renders.table++; return 'dark' },
}))
vi.mock('../../../src/renderer/components/PageFrame', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../../../src/renderer/components/sentinel/CompatBadge', () => ({ default: () => null }))

import TokenomicsPage from '../../../src/renderer/components/TokenomicsPage'
import { useTokenomicsStore } from '../../../src/renderer/stores/tokenomicsStore'
import { useProviderAccountsStore } from '../../../src/renderer/stores/providerAccountsStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const A_WORK = 'acct-' + 'a'.repeat(32)
const A_REVIEW = 'acct-' + 'b'.repeat(32)
const SNAPSHOT = {
  revision: 1,
  providers: [],
  identities: [
    { id: 'id-work', friendlyName: 'Work', colourKey: 'slate-blue' },
    { id: 'id-review', friendlyName: 'Reviewer', colourKey: 'pink' },
  ],
  accounts: [
    { id: A_WORK, providerId: 'claude', identityId: 'id-work', lifecycle: 'active', authMethod: 'browser', external: false },
    { id: A_REVIEW, providerId: 'codex', identityId: 'id-review', lifecycle: 'active', authMethod: 'apiKey', external: false },
  ],
} as unknown as AccountsSnapshot
const PRESENT: TkAccountPresent[] = [
  { provider: 'claude', accountKey: `claude:${A_WORK}` },
  { provider: 'codex', accountKey: `codex:${A_REVIEW}` },
]
const K = (v: number) => ({ lifeToDateCostUsd: v, last7dCostUsd: v / 10, prev7dCostUsd: v / 20, cacheEfficiencyPct: 50, cacheSavingsUsd: 1 })
const SUMMARY: TkSummary = {
  kpis: K(20),
  kpisByProvider: { claude: K(15), codex: K(5) },
  dailySeries: [{ day: '2026-09-26', costUsd: 20, byProvider: { claude: 15, codex: 5 } }],
  modelSplit: [],
  unpriced: [],
  cacheSplit: { inputUsd: 1, outputUsd: 1, cacheReadUsd: 1, cacheCreateUsd: 1 },
  costByConfig: [],
  heatmap: [],
}
const row = (sessionId: string, accountKey: string): TkSessionRow => ({
  sessionId, provider: accountKey.startsWith('codex:') ? 'codex' : 'claude', configId: null, configLabel: 'Website', model: 'gpt-5.5',
  costUsd: 1, unpricedTokens: 0, inTok: 1, outTok: 1, cacheReadTok: 1, cacheCreateTok: 0, msgCount: 1, lastTs: Date.parse('2026-09-26T10:00:00Z'), accountKey,
})
const ROWS = [row('a', `claude:${A_WORK}`), row('b', `codex:${A_REVIEW}`)]

type Progress = (p: { filesDone: number; filesTotal: number; accountReread?: { stage: 'reread' | 'rebuild'; done: number; total: number } | null }) => void
let progress: Progress = () => {}
const api = {
  indexStatus: vi.fn(async () => ({ firstIndexComplete: true, indexing: false, filesDone: 1, filesTotal: 1, eventsTotal: 1, lastIndexAt: 1 })),
  onIndexStatus: vi.fn(() => () => {}),
  onIndexProgress: vi.fn((cb: Progress) => { progress = cb; return () => {} }),
  onIndexComplete: vi.fn(() => () => {}),
  summary: vi.fn(async () => SUMMARY),
  sessions: vi.fn(async () => ({ rows: ROWS, nextCursor: null })),
  accounts: vi.fn(async () => PRESENT),
  sessionDetail: vi.fn(async () => null),
}

describe('the Tokenomics page re-renders only what changed (MP12 round 1)', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    ;(window as any).electronAPI = { ...((window as any).electronAPI ?? {}), tokenomics: api }
    useProviderAccountsStore.setState({ snapshot: SNAPSHOT, loaded: true })
    useTokenomicsStore.setState({ summary: null, accounts: [], indexStatus: null, filter: { range: 'all' }, sessions: [], selected: null, nextCursor: null, error: null, _unsubs: [] })
    renders.kpi = 0
    renders.chip = 0
    renders.table = 0
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('an index progress tick redraws the notice, not the dashboard, the table or its rows', async () => {
    await act(async () => { root.render(createElement(TokenomicsPage)) })
    await act(async () => { await Promise.resolve() })
    expect(renders.kpi).toBeGreaterThan(0)
    expect(renders.chip).toBe(2)
    const table = renders.table
    expect(table).toBeGreaterThan(0)
    // The first tick starts the sorting by account: the page learns that
    // once (the heatmap's filling line), and the table is not redrawn.
    act(() => { progress({ filesDone: 1, filesTotal: 1, accountReread: { stage: 'reread', done: 3, total: 12 } }) })
    const notice = () => [...container.querySelectorAll('[data-testid="tk-notice"]')].map((n) => n.textContent)
    expect(notice()).toEqual(['Sorting Codex history by account: 3 of 12 files. Totals are complete; the split by account fills in.'])
    expect(renders.chip).toBe(2)
    expect(renders.table).toBe(table)
    const kpi = renders.kpi
    // Later ticks change only the count in the notice and the file counters.
    act(() => { progress({ filesDone: 2, filesTotal: 5, accountReread: { stage: 'reread', done: 4, total: 12 } }) })
    act(() => { progress({ filesDone: 3, filesTotal: 5, accountReread: { stage: 'reread', done: 5, total: 12 } }) })
    expect(notice()).toEqual(['Sorting Codex history by account: 5 of 12 files. Totals are complete; the split by account fills in.'])
    expect(renders.kpi).toBe(kpi)
    expect(renders.chip).toBe(2)
    expect(renders.table).toBe(table)
  })

  it('a longer list draws only the new rows', async () => {
    await act(async () => { root.render(createElement(TokenomicsPage)) })
    await act(async () => { await Promise.resolve() })
    expect(renders.chip).toBe(2)
    act(() => { useTokenomicsStore.setState((s) => ({ sessions: [...s.sessions, row('c', `codex:${A_REVIEW}`)] })) })
    expect(container.querySelectorAll('[data-testid="tk-session-account"]')).toHaveLength(3)
    expect(renders.chip).toBe(3)
  })
})
