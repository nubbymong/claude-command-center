import { describe, it, expect, beforeEach } from 'vitest'
import { useInsightsStore } from '../../../src/renderer/stores/insightsStore'

describe('insightsStore', () => {
  beforeEach(() => {
    useInsightsStore.setState({
      status: 'idle',
      statusMessage: null,
      currentRunId: null,
      catalogue: null,
      selectedRunId: null,
      error: null,
    })
  })

  describe('handleStatusChanged', () => {
    it('updates status from run event', () => {
      useInsightsStore.getState().handleStatusChanged({
        id: 'run-1',
        timestamp: Date.now(),
        status: 'running',
        statusMessage: 'Analyzing...',
      })
      const state = useInsightsStore.getState()
      expect(state.status).toBe('running')
      expect(state.statusMessage).toBe('Analyzing...')
      expect(state.currentRunId).toBe('run-1')
    })

    it('auto-selects completed run', () => {
      useInsightsStore.getState().handleStatusChanged({
        id: 'run-1',
        timestamp: Date.now(),
        status: 'complete',
      })
      expect(useInsightsStore.getState().selectedRunId).toBe('run-1')
    })

    it('captures error from failed run', () => {
      useInsightsStore.getState().handleStatusChanged({
        id: 'run-1',
        timestamp: Date.now(),
        status: 'failed',
        error: 'Something broke',
      })
      expect(useInsightsStore.getState().status).toBe('failed')
      expect(useInsightsStore.getState().error).toBe('Something broke')
    })

    it('updates existing run in catalogue', () => {
      useInsightsStore.setState({
        catalogue: {
          runs: [{ id: 'run-1', timestamp: 1000, status: 'running' }],
        },
      })
      useInsightsStore.getState().handleStatusChanged({
        id: 'run-1',
        timestamp: 1000,
        status: 'complete',
      })
      expect(useInsightsStore.getState().catalogue!.runs[0].status).toBe('complete')
    })

    it('adds new run to catalogue if not found', () => {
      useInsightsStore.setState({
        catalogue: { runs: [] },
      })
      useInsightsStore.getState().handleStatusChanged({
        id: 'run-2',
        timestamp: 2000,
        status: 'running',
      })
      expect(useInsightsStore.getState().catalogue!.runs).toHaveLength(1)
      expect(useInsightsStore.getState().catalogue!.runs[0].id).toBe('run-2')
    })
  })

  describe('selectRun', () => {
    it('sets selectedRunId', () => {
      useInsightsStore.getState().selectRun('run-5')
      expect(useInsightsStore.getState().selectedRunId).toBe('run-5')
    })
  })
})
