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

describe('InsightsPage Codex-only empty state', () => {
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

  it('shows the Codex-only empty state when only Codex sessions exist', async () => {
    mockModelSplit = [{ model: 'gpt-5.5', costUsd: 1, tokens: 1 }]
    ;(globalThis as any).window.electronAPI.tokenomics.summary = vi.fn().mockResolvedValue(minimalSummary(mockModelSplit))

    await act(async () => { root.render(React.createElement(InsightsPage)) })
    // Allow the summary promise microtask to settle and trigger a re-render.
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(container.textContent).toContain('Insights aggregate from your Claude sessions')
  })

  it('does NOT show the Codex-only empty state when at least one Claude session exists', async () => {
    mockModelSplit = [{ model: 'gpt-5.5', costUsd: 1, tokens: 1 }, { model: 'claude-3-5-sonnet', costUsd: 1, tokens: 1 }]
    ;(globalThis as any).window.electronAPI.tokenomics.summary = vi.fn().mockResolvedValue(minimalSummary(mockModelSplit))

    await act(async () => { root.render(React.createElement(InsightsPage)) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(container.textContent ?? '').not.toContain('Insights aggregate from your Claude sessions')
  })

  it('does NOT show the Codex-only empty state for first-run users (no sessions)', async () => {
    mockModelSplit = []
    ;(globalThis as any).window.electronAPI.tokenomics.summary = vi.fn().mockResolvedValue(minimalSummary(mockModelSplit))

    await act(async () => { root.render(React.createElement(InsightsPage)) })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })

    expect(container.textContent ?? '').not.toContain('Insights aggregate from your Claude sessions')
  })
})
