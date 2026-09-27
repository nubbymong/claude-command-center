/**
 * Usage track MP12: the Tokenomics store's provider and account filters, the
 * accounts the stored usage has, and the one-off attribution's progress.
 * window.electronAPI.tokenomics is faked, as in tokenomicsStore.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const progressCbs: Array<(p: unknown) => void> = []
const PRESENT = [{ provider: 'claude', accountKey: '' }, { provider: 'codex', accountKey: 'codex:external' }]
const tk = {
  indexStatus: vi.fn(async () => ({ firstIndexComplete: true, indexing: false, filesDone: 1, filesTotal: 1, eventsTotal: 5, lastIndexAt: 1 })),
  summary: vi.fn(async () => ({ kpis: {}, kpisByProvider: {}, dailySeries: [], modelSplit: [], unpriced: [], cacheSplit: {}, costByConfig: [], heatmap: [] })),
  sessions: vi.fn(async () => ({ rows: [], nextCursor: null })),
  accounts: vi.fn(async () => PRESENT as unknown[]),
  sessionDetail: vi.fn(async () => null),
  onIndexStatus: vi.fn(() => () => {}),
  onIndexProgress: vi.fn((cb: (p: unknown) => void) => { progressCbs.push(cb); return () => {} }),
  onIndexComplete: vi.fn(() => () => {}),
}
const existingWindow = (globalThis as any).window
if (existingWindow) existingWindow.electronAPI = { ...(existingWindow.electronAPI ?? {}), tokenomics: tk }
else (globalThis as any).window = { electronAPI: { tokenomics: tk } }

import { useTokenomicsStore, tkQueryFilter } from '../../src/renderer/stores/tokenomicsStore'

describe('the Tokenomics store with providers and accounts (MP12)', () => {
  beforeEach(() => {
    for (const f of [tk.summary, tk.sessions, tk.accounts]) f.mockClear()
    useTokenomicsStore.setState({ summary: null, accounts: [], sessions: [], nextCursor: null, indexStatus: null, filter: { range: 'all' }, error: null, _unsubs: [] })
  })

  it('a filter makes its query: the provider, else the chosen account\'s, and the account key', () => {
    expect(tkQueryFilter({ range: 'all' }, 0)).toEqual({})
    expect(tkQueryFilter({ range: 'all', provider: 'codex' }, 0)).toEqual({ provider: 'codex' })
    expect(tkQueryFilter({ range: 'all', account: { provider: 'codex', key: '' } }, 0)).toEqual({ provider: 'codex', accountKey: '' })
    expect(tkQueryFilter({ range: 'all', account: { provider: 'claude', key: 'claude:acct-x' } }, 0)).toEqual({ provider: 'claude', accountKey: 'claude:acct-x' })
    expect(tkQueryFilter({ range: '7d', configId: null }, 8 * 86_400_000)).toEqual({ configId: null, from: 86_400_000 })
  })

  it('refreshing loads the accounts the usage has; an answer lost keeps the last ones', async () => {
    await useTokenomicsStore.getState().refresh()
    expect(useTokenomicsStore.getState().accounts).toEqual(PRESENT)
    tk.accounts.mockRejectedValueOnce(new Error('worker restarting'))
    await useTokenomicsStore.getState().refresh()
    expect(useTokenomicsStore.getState().accounts).toEqual(PRESENT)
    expect(useTokenomicsStore.getState().error).toBeNull()
  })

  it('choosing an account asks for it under its provider; choosing the other provider lets it go, the same keeps it', async () => {
    useTokenomicsStore.getState().setAccount({ provider: 'codex', key: '' })
    await vi.waitFor(() => expect(tk.summary).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'codex', accountKey: '' })))
    expect(tk.sessions).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'codex', accountKey: '' }))
    useTokenomicsStore.getState().setProvider('codex')
    expect(useTokenomicsStore.getState().filter.account).toEqual({ provider: 'codex', key: '' })
    useTokenomicsStore.getState().setProvider('claude')
    expect(useTokenomicsStore.getState().filter.account).toBeUndefined()
    await vi.waitFor(() => expect(tk.summary).toHaveBeenLastCalledWith({ provider: 'claude' }))
    useTokenomicsStore.getState().setProvider(undefined)
    await vi.waitFor(() => expect(tk.summary).toHaveBeenLastCalledWith({}))
  })

  it('the one-off attribution\'s progress rides the progress events into the index status', async () => {
    await useTokenomicsStore.getState().init()
    const cb = progressCbs.at(-1)!
    cb({ filesDone: 3, filesTotal: 9, eventsIngested: 0, phase: 'incremental', accountReread: { stage: 'reread', done: 1, total: 4 } })
    expect(useTokenomicsStore.getState().indexStatus?.accountReread).toEqual({ stage: 'reread', done: 1, total: 4 })
    cb({ filesDone: 9, filesTotal: 9, eventsIngested: 0, phase: 'incremental', accountReread: null })
    expect(useTokenomicsStore.getState().indexStatus?.accountReread).toBeNull()
    useTokenomicsStore.getState().dispose()
  })
})
