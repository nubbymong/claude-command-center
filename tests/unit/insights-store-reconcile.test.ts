import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useInsightsStore } from '../../src/renderer/stores/insightsStore'

// Unit 3 W4: loadCatalogue must NOT persistently mark a historical failure as the
// store status — that would redden the Insights nav dot on every boot for a past
// failure (the Sentinel calibration lesson: a dot means "needs attention now").
// Failures are surfaced on the page from the catalogue instead. loadCatalogue
// should only clear a stale mid-run status, never invent a 'failed'.

describe('insightsStore.loadCatalogue reconciliation', () => {
  beforeEach(() => {
    useInsightsStore.setState({ status: 'idle', error: null, catalogue: null, selectedRunId: null })
  })

  it('keeps the nav dot calm: a historical failed run does NOT set status=failed', async () => {
    ;(window as any).electronAPI.insights = {
      getCatalogue: vi.fn().mockResolvedValue({ runs: [{ id: 'r1', status: 'failed', timestamp: 1, error: 'boom' }] }),
      isRunning: vi.fn().mockResolvedValue(false),
    }
    // Simulate a stale mid-run status left over from a previous session.
    useInsightsStore.setState({ status: 'running' })
    await useInsightsStore.getState().loadCatalogue()
    expect(useInsightsStore.getState().status).toBe('idle')
    // The catalogue (which the page reads to surface the failure) is still loaded.
    expect(useInsightsStore.getState().catalogue?.runs[0].status).toBe('failed')
  })

  it('reflects an in-flight run as running', async () => {
    ;(window as any).electronAPI.insights = {
      getCatalogue: vi.fn().mockResolvedValue({ runs: [] }),
      isRunning: vi.fn().mockResolvedValue(true),
    }
    await useInsightsStore.getState().loadCatalogue()
    expect(useInsightsStore.getState().status).toBe('running')
  })

  it('leaves a completed status untouched when nothing is in flight', async () => {
    ;(window as any).electronAPI.insights = {
      getCatalogue: vi.fn().mockResolvedValue({ runs: [{ id: 'r1', status: 'complete', timestamp: 1 }] }),
      isRunning: vi.fn().mockResolvedValue(false),
    }
    useInsightsStore.setState({ status: 'complete' })
    await useInsightsStore.getState().loadCatalogue()
    expect(useInsightsStore.getState().status).toBe('complete')
  })
})
