// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stable object references prevent useEffect([..., catalogue]) from
// firing on every render (same issue the component comment describes for sessions).
const STABLE_CATALOGUE = { runs: [{ id: 'r1', status: 'complete', timestamp: 1716000000000 }] }
const noop = () => {}

// Minimal TkSummary with a claude model so the Codex-only gate never fires.
const STABLE_SUMMARY = {
  kpis: { lifeToDateCostUsd: 0, last7dCostUsd: 0, prev7dCostUsd: 0, cacheEfficiencyPct: 0, cacheSavingsUsd: 0 },
  dailySeries: [],
  modelSplit: [{ model: 'claude-3-5-sonnet', costUsd: 1, tokens: 1 }],
  cacheSplit: { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheCreateUsd: 0 },
  costByConfig: [],
  heatmap: [],
}

vi.mock('../../../src/renderer/stores/insightsStore', () => ({
  useInsightsStore: (sel: any) => sel({
    catalogue: STABLE_CATALOGUE,
    selectedRunId: 'r1',
    selectRun: noop, status: 'idle', statusMessage: '',
    startInsights: noop, loadCatalogue: noop,
  }),
}))

beforeEach(() => {
  ;(globalThis as any).window.electronAPI = {
    insights: {
      getReport: vi.fn().mockResolvedValue('<html><body><h1>R</h1></body></html>'),
      getKpis: vi.fn().mockResolvedValue(null),
    },
    tokenomics: {
      summary: vi.fn().mockResolvedValue(STABLE_SUMMARY),
    },
    shell: { openExternal: vi.fn() },
  }
})

import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InsightsPage from '../../../src/renderer/components/InsightsPage'

describe('InsightsPage native render (U3.3)', () => {
  it('does not mount an iframe', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<InsightsPage />)
    })
    // Wait a tick for the load Promise to resolve and state to settle
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(container.querySelector('iframe')).toBeNull()
    root.unmount()
    container.remove()
  })
})
