// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stable object references prevent useEffect([..., catalogue]) from
// firing on every render (same issue the component comment describes for sessions).
const STABLE_CATALOGUE = { runs: [{ id: 'r1', status: 'complete', timestamp: 1716000000000 }] }
const STABLE_SESSIONS = { x: { provider: 'claude' } }
const noop = () => {}

vi.mock('../../../src/renderer/stores/insightsStore', () => ({
  useInsightsStore: (sel: any) => sel({
    catalogue: STABLE_CATALOGUE,
    selectedRunId: 'r1',
    selectRun: noop, status: 'idle', statusMessage: '',
    startInsights: noop, loadCatalogue: noop,
  }),
}))
vi.mock('../../../src/renderer/stores/tokenomicsStore', () => ({
  useTokenomicsStore: (sel: any) => sel({ data: { sessions: STABLE_SESSIONS } }),
}))

beforeEach(() => {
  ;(globalThis as any).window.electronAPI = {
    insights: {
      getReport: vi.fn().mockResolvedValue('<html><body><h1>R</h1></body></html>'),
      getKpis: vi.fn().mockResolvedValue(null),
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
