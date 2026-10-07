// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Mock useInsightsStore -- always return an empty catalogue so the existing
// "no completed runs" branch would fire absent the new Codex-only branch.
vi.mock('../../../src/renderer/stores/insightsStore', () => ({
  useInsightsStore: (sel: any) => sel({
    catalogue: { runs: [] },
    selectedRunId: null,
    selectRun: () => {},
    status: 'idle',
    statusMessage: '',
    startInsights: () => {},
    loadCatalogue: () => {},
  }),
}))

// Minimal TkSummary shape used by the mock.
const minimalSummary = (modelSplit: Array<{ model: string; costUsd: number; tokens: number }>) => ({
  kpis: { lifeToDateCostUsd: 0, last7dCostUsd: 0, prev7dCostUsd: 0, cacheEfficiencyPct: 0, cacheSavingsUsd: 0 },
  dailySeries: [],
  modelSplit,
  cacheSplit: { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheCreateUsd: 0 },
  costByConfig: [],
  heatmap: [],
})

// mockSummary is mutated per-test before rendering.
let mockModelSplit: Array<{ model: string; costUsd: number; tokens: number }> = []

import InsightsPage from '../../../src/renderer/components/InsightsPage'

// WP2 PR 4, P4.7 (row 68), mockup D9 (approved 2026-10-05): the Claude-only
// message ("Insights aggregate from your Claude sessions") is gone. A user whose
// sessions are all Codex's sees the page's own empty state, with Run Insights
// Now, as everyone else does. [host]
describe('InsightsPage empty state for a Codex-only user (P4.7, D9)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mockModelSplit = []

    // Set up window.electronAPI with tokenomics.summary resolving from mockModelSplit.
    ;(globalThis as any).window = (globalThis as any).window ?? {}
    ;(globalThis as any).window.electronAPI = {
      tokenomics: {
        summary: vi.fn().mockImplementation(() => Promise.resolve(minimalSummary(mockModelSplit))),
      },
      insights: {
        getReport: vi.fn().mockResolvedValue(null),
        getKpis: vi.fn().mockResolvedValue(null),
      },
      shell: { openExternal: vi.fn() },
    }
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('a user with only Codex sessions sees the normal empty state, never the Claude-only message [host]', async () => {
    mockModelSplit = [{ model: 'gpt-5.5', costUsd: 1, tokens: 1 }]
    ;(globalThis as any).window.electronAPI.tokenomics.summary = vi.fn().mockResolvedValue(minimalSummary(mockModelSplit))

    await act(async () => { root.render(React.createElement(InsightsPage)) })
    // Allow the summary promise microtask to settle and trigger a re-render.
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(container.textContent ?? '').not.toContain('Insights aggregate from your Claude sessions')
    expect(container.textContent).toContain('No Insights Yet')
    expect(container.textContent).toContain('Run Insights Now')
  })

  it('a user with Claude sessions sees the same empty state [host]', async () => {
    mockModelSplit = [{ model: 'gpt-5.5', costUsd: 1, tokens: 1 }, { model: 'claude-3-5-sonnet', costUsd: 1, tokens: 1 }]
    ;(globalThis as any).window.electronAPI.tokenomics.summary = vi.fn().mockResolvedValue(minimalSummary(mockModelSplit))

    await act(async () => { root.render(React.createElement(InsightsPage)) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(container.textContent ?? '').not.toContain('Insights aggregate from your Claude sessions')
  })

  it('a first-run user (no sessions) sees the same empty state [host]', async () => {
    mockModelSplit = []
    ;(globalThis as any).window.electronAPI.tokenomics.summary = vi.fn().mockResolvedValue(minimalSummary(mockModelSplit))

    await act(async () => { root.render(React.createElement(InsightsPage)) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(container.textContent ?? '').not.toContain('Insights aggregate from your Claude sessions')
  })
})
