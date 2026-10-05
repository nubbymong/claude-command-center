import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useInsightsStore } from '../../../src/renderer/stores/insightsStore'
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'

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

// [host] WP2 PR 4, P4.7 (row 68): a Codex account's report from the store.
describe('insightsStore: a Codex report (P4.7)', () => {
  const ACCT = `acct-${'a'.repeat(16)}`
  const run = vi.fn(async (_opts?: unknown): Promise<unknown> => 'run-codex')
  const runAll = vi.fn(async (_opts?: unknown): Promise<unknown> => 'run-all')
  const settings = (over: Record<string, unknown>) => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...over } as never, isLoaded: true })
  beforeEach(() => {
    ;(globalThis as any).window = { electronAPI: { insights: { run, runAll } } }
    run.mockClear()
    runAll.mockClear()
    useInsightsStore.setState({ status: 'idle', statusMessage: null, currentRunId: null, error: null, batchActive: false, batchRunId: null })
    settings({ codexEnabled: true, codexAnswered: true })
  })
  afterEach(() => { delete (globalThis as any).window })

  it('sends the S0 shape, { profileId, provider: codex }, and no confirmation unless given [host]', async () => {
    await useInsightsStore.getState().startCodexInsights(ACCT)
    expect(run).toHaveBeenCalledWith({ profileId: ACCT, provider: 'codex' })
    expect(useInsightsStore.getState().currentRunId).toBe('run-codex')
  })

  it("sends this run's confirmation with the account it names (D12) [host]", async () => {
    await useInsightsStore.getState().startCodexInsights(ACCT, true)
    expect(run).toHaveBeenCalledWith({ profileId: ACCT, provider: 'codex', acknowledgeRealmOnly: true })
  })

  it('refuses while Codex is off or not set up, and leaves the status alone; Claude Code being off does not stop it (D8) [host]', async () => {
    settings({ codexEnabled: false, codexAnswered: true })
    await useInsightsStore.getState().startCodexInsights(ACCT)
    expect(useInsightsStore.getState()).toMatchObject({ status: 'idle', error: 'Codex is off. Turn it on in Settings, Accounts.' })
    settings({ codexEnabled: undefined })
    await useInsightsStore.getState().startCodexInsights(ACCT)
    expect(useInsightsStore.getState().error).toBe('Codex is not set up yet. Set it up in Settings, Accounts.')
    expect(run).not.toHaveBeenCalled()
    settings({ codexEnabled: true, codexAnswered: true, claudeEnabled: false })
    await useInsightsStore.getState().startCodexInsights(ACCT)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("an answer main did not take, or refused, puts the status back and says why [host]", async () => {
    run.mockResolvedValueOnce({ rejected: 'That Insights request was not valid.' })
    await useInsightsStore.getState().startCodexInsights(ACCT)
    expect(useInsightsStore.getState()).toMatchObject({ status: 'idle', error: 'That Insights request was not valid.', currentRunId: null })
    run.mockResolvedValueOnce({ refused: { code: 'provider-off', providerId: 'codex', message: 'Codex is off. Turn it on in Settings, Accounts.' } })
    await useInsightsStore.getState().startCodexInsights(ACCT)
    expect(useInsightsStore.getState()).toMatchObject({ status: 'idle', error: 'Codex is off. Turn it on in Settings, Accounts.' })
    run.mockResolvedValueOnce({ rejected: 'This request did not come from the app window.' })
    await useInsightsStore.getState().startInsights()
    expect(useInsightsStore.getState()).toMatchObject({ status: 'idle', error: 'This request did not come from the app window.' })
  })

  it('Run all goes ahead with Claude Code off while Codex is on (C1 A); with neither on it is refused [host]', async () => {
    settings({ codexEnabled: true, codexAnswered: true, claudeEnabled: false })
    await useInsightsStore.getState().startCrossAccount()
    expect(runAll).toHaveBeenCalledTimes(1)
    settings({ codexEnabled: false, codexAnswered: true, claudeEnabled: false })
    await useInsightsStore.getState().startCrossAccount()
    expect(runAll).toHaveBeenCalledTimes(1)
    expect(useInsightsStore.getState().error).toBe('Claude Code is off. Turn it on in Settings, Accounts.')
    runAll.mockResolvedValueOnce({ rejected: 'That Insights request was not valid.' })
    settings({ codexEnabled: true, codexAnswered: true })
    await useInsightsStore.getState().startCrossAccount()
    expect(useInsightsStore.getState()).toMatchObject({ batchActive: false, error: 'That Insights request was not valid.' })
  })
})
