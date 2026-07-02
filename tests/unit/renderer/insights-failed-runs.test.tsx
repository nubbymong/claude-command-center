// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Unit 3 W4: failed runs were filtered to status==='complete' everywhere, so a
// failure showed the generic "No Insights Yet" with no hint. These tests lock in
// the surfacing: banner, picker marker, selected-failure error, empty-state hint,
// and the "report ready, KPIs unavailable" state.

const noop = () => {}
const STABLE_SUMMARY = {
  kpis: { lifeToDateCostUsd: 0, last7dCostUsd: 0, prev7dCostUsd: 0, cacheEfficiencyPct: 0, cacheSavingsUsd: 0 },
  dailySeries: [],
  modelSplit: [{ model: 'claude-3-5-sonnet', costUsd: 1, tokens: 1 }],
  cacheSplit: { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheCreateUsd: 0 },
  costByConfig: [],
  heatmap: [],
}

// Mutable store state the mocked useInsightsStore reads from (set per test).
const st = vi.hoisted(() => ({ current: {} as any }))
vi.mock('../../../src/renderer/stores/insightsStore', () => ({
  useInsightsStore: (sel: any) => sel(st.current),
}))

beforeEach(() => {
  ;(globalThis as any).window.electronAPI = {
    insights: {
      getReport: vi.fn().mockResolvedValue(null),
      getKpis: vi.fn().mockResolvedValue(null),
    },
    tokenomics: { summary: vi.fn().mockResolvedValue(STABLE_SUMMARY) },
    shell: { openExternal: vi.fn() },
  }
})

import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InsightsPage from '../../../src/renderer/components/InsightsPage'

async function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(<InsightsPage />) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return { container, root }
}

function baseState(over: Record<string, unknown>) {
  return { selectRun: noop, status: 'idle', statusMessage: '', startInsights: noop, loadCatalogue: noop, error: null, ...over }
}

describe('InsightsPage failed-run surfacing (U3 W4)', () => {
  it('shows a failure banner and a "failed" picker entry when the latest run failed', async () => {
    st.current = baseState({
      catalogue: { runs: [
        { id: 'r1', status: 'complete', timestamp: 1716000000000 },
        { id: 'r2', status: 'failed', timestamp: 1716000100000, error: 'claude /insights failed: boom' },
      ] },
      selectedRunId: 'r1',
    })
    const { container, root } = await renderPage()
    expect(container.textContent).toContain('Last Insights run failed')
    expect(container.textContent).toContain('boom')
    const opts = Array.from(container.querySelectorAll('option')).map((o) => o.textContent || '')
    expect(opts.some((t) => t.includes('failed'))).toBe(true)
    root.unmount(); container.remove()
  })

  it('selecting a failed run shows its error in the content area', async () => {
    st.current = baseState({
      catalogue: { runs: [
        { id: 'r1', status: 'complete', timestamp: 1716000000000 },
        { id: 'r2', status: 'failed', timestamp: 1716000100000, error: 'copy failed' },
      ] },
      selectedRunId: 'r2',
    })
    const { container, root } = await renderPage()
    expect(container.textContent).toContain('This run failed')
    expect(container.textContent).toContain('copy failed')
    root.unmount(); container.remove()
  })

  it('surfaces the failure in the empty state when there are no completed runs', async () => {
    st.current = baseState({
      catalogue: { runs: [
        { id: 'r1', status: 'failed', timestamp: 1716000000000, error: 'no usage data' },
      ] },
      selectedRunId: null,
    })
    const { container, root } = await renderPage()
    expect(container.textContent).toContain('Last run failed')
    expect(container.textContent).toContain('no usage data')
    root.unmount(); container.remove()
  })

  it('shows "KPI extraction failed" for a completed run with kpisUnavailable', async () => {
    st.current = baseState({
      catalogue: { runs: [
        { id: 'r1', status: 'complete', timestamp: 1716000000000, kpisUnavailable: true },
      ] },
      selectedRunId: 'r1',
    })
    ;(window as any).electronAPI.insights.getReport.mockResolvedValueOnce('<html><body><h2>Report</h2></body></html>')
    const { container, root } = await renderPage()
    expect(container.textContent).toContain('KPI extraction failed')
    root.unmount(); container.remove()
  })
})
