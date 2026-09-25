// @vitest-environment jsdom
/**
 * WP2 commit 6e review fix: headless Claude Code runs are gated too. With
 * Claude Code switched off in Settings, Accounts, a cloud agent (a `claude -p`
 * run) and an insights run never start: each entry point is disabled with a
 * reason naming Claude Code being off and where to turn it on, and the store
 * action behind it refuses on its own (the backstop for any way in the UI
 * misses).
 *
 * Verifies:
 *   - New agent: Dispatch disabled with the reason, even with every field
 *     filled; live again once Claude Code is back on;
 *   - cloudAgentStore.dispatch / retry: nothing reaches main, the page's
 *     banner (the store's error) says why;
 *   - Insights: every Run button on the empty page disabled with the reason;
 *   - insightsStore.startInsights / startCrossAccount: nothing reaches main,
 *     no "failed" status for a run that never started.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn(), retryFailedConfigSaves: vi.fn() }))

const OFF = 'Claude Code is off. Turn it on in Settings, Accounts.'

const api = {
  cloudAgent: {
    dispatch: vi.fn(async () => ({ id: 'agent-1' })),
    retry: vi.fn(async () => ({ id: 'agent-2' })),
  },
  insights: {
    run: vi.fn(async () => 'run-1'),
    runAll: vi.fn(async () => 'run-all-1'),
    getReport: vi.fn(async () => null),
    getKpis: vi.fn(async () => null),
  },
  tokenomics: { summary: vi.fn(async () => null) },
  accountProfiles: { authInfo: vi.fn(async () => []) },
  dialog: { openFolder: vi.fn(async () => null) },
}
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, ...api }

const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useCloudAgentStore } = await import('../../../src/renderer/stores/cloudAgentStore')
const { useInsightsStore } = await import('../../../src/renderer/stores/insightsStore')
const { useConfigStore } = await import('../../../src/renderer/stores/configStore')
const { useAccountProfilesStore } = await import('../../../src/renderer/stores/accountProfilesStore')
const { default: NewAgentDialog } = await import('../../../src/renderer/components/NewAgentDialog')
const { default: InsightsPage } = await import('../../../src/renderer/components/InsightsPage')

let container: HTMLDivElement
let root: Root

const claude = (claudeEnabled: boolean | undefined) =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled }, isLoaded: true })

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  for (const group of [api.cloudAgent, api.insights]) for (const f of Object.values(group)) f.mockClear()
  useCloudAgentStore.setState({ error: null, selectedAgentId: null })
  useInsightsStore.setState({ status: 'idle', error: null, batchActive: false, catalogue: { runs: [] } as any, loadCatalogue: vi.fn(async () => {}) })
  useAccountProfilesStore.setState({ profiles: [] } as any)
  claude(false)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  claude(undefined)
})

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() })
}

const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null

function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

describe('cloud agents', () => {
  function fillDialog() {
    useConfigStore.setState({ configs: [{ id: 'cfg-1', label: 'App', workingDirectory: 'C:/proj', sessionType: 'local', color: '' } as any] })
    act(() => { root.render(<NewAgentDialog onClose={() => {}} />) })
    setValue(container.querySelector('input') as HTMLInputElement, 'Tidy')
    setValue(container.querySelector('textarea') as HTMLTextAreaElement, 'Tidy the imports')
    setValue(container.querySelector('select') as HTMLSelectElement, 'cfg-1')
  }

  it('New agent: Dispatch is disabled with the reason, even with every field filled, and dispatches nothing', async () => {
    fillDialog()
    const dispatch = byTest('new-agent-dispatch')!
    expect(dispatch.disabled).toBe(true)
    expect(dispatch.title).toBe(OFF)
    expect(container.querySelector('[data-testid="new-agent-claude-off"]')!.textContent).toBe(OFF)
    await act(async () => { dispatch.click() })
    expect(api.cloudAgent.dispatch).not.toHaveBeenCalled()
  })

  it('with Claude Code on, the same filled dialog dispatches', async () => {
    claude(true)
    fillDialog()
    const dispatch = byTest('new-agent-dispatch')!
    expect(dispatch.disabled).toBe(false)
    expect(container.querySelector('[data-testid="new-agent-claude-off"]')).toBeNull()
    await act(async () => { dispatch.click() })
    await flush()
    expect(api.cloudAgent.dispatch).toHaveBeenCalledTimes(1)
  })

  it('the store refuses a dispatch and a retry while Claude Code is off, and says why', async () => {
    await useCloudAgentStore.getState().dispatch({ name: 'n', description: 'd', projectPath: 'C:/p' })
    await useCloudAgentStore.getState().retry('agent-0')
    expect(api.cloudAgent.dispatch).not.toHaveBeenCalled()
    expect(api.cloudAgent.retry).not.toHaveBeenCalled()
    expect(useCloudAgentStore.getState().error).toBe(OFF)
    claude(true)
    await useCloudAgentStore.getState().dispatch({ name: 'n', description: 'd', projectPath: 'C:/p' })
    await useCloudAgentStore.getState().retry('agent-0')
    expect(api.cloudAgent.dispatch).toHaveBeenCalledTimes(1)
    expect(api.cloudAgent.retry).toHaveBeenCalledTimes(1)
  })
})

describe('insights', () => {
  it('the empty page: Run Insights Now is disabled with the reason, and runs nothing', async () => {
    await act(async () => { root.render(<InsightsPage />) })
    await flush()
    const run = byTest('insights-run-now')!
    expect(run.disabled).toBe(true)
    expect(run.title).toBe(OFF)
    expect(container.querySelector('[data-testid="insights-claude-off"]')!.textContent).toBe(OFF)
    await act(async () => { run.click() })
    expect(api.insights.run).not.toHaveBeenCalled()
  })

  it('with Claude Code on, the same button is live and says nothing about it', async () => {
    claude(true)
    await act(async () => { root.render(<InsightsPage />) })
    await flush()
    expect(byTest('insights-run-now')!.disabled).toBe(false)
    expect(container.querySelector('[data-testid="insights-claude-off"]')).toBeNull()
  })

  it('the store refuses a run and a cross-account run while Claude Code is off, and leaves the status alone', async () => {
    await useInsightsStore.getState().startInsights()
    await useInsightsStore.getState().startCrossAccount()
    expect(api.insights.run).not.toHaveBeenCalled()
    expect(api.insights.runAll).not.toHaveBeenCalled()
    expect(useInsightsStore.getState().status).toBe('idle')
    expect(useInsightsStore.getState().batchActive).toBe(false)
    expect(useInsightsStore.getState().error).toBe(OFF)
    claude(true)
    await useInsightsStore.getState().startInsights()
    expect(api.insights.run).toHaveBeenCalledTimes(1)
  })
})

// WP2: main refuses on its own too (src/main/provider-launch-gate.ts) -- a
// switch flipped after this page last read the setting, or a renderer bug.
// Its answer is shown the same way as the renderer's own refusal: in the
// page's banner, with no "failed" status for a run that never started.
describe("main's own refusal, shown the same way", () => {
  const refused = { refused: { code: 'provider-off', providerId: 'claude', message: OFF } }
  beforeEach(() => { claude(true) })

  it('a cloud agent dispatch and a retry main refused: the banner says why, nothing is selected', async () => {
    api.cloudAgent.dispatch.mockResolvedValueOnce(refused as any)
    api.cloudAgent.retry.mockResolvedValueOnce(refused as any)
    await useCloudAgentStore.getState().dispatch({ name: 'n', description: 'd', projectPath: 'C:/p' })
    expect(useCloudAgentStore.getState().error).toBe(OFF)
    useCloudAgentStore.setState({ error: null })
    await useCloudAgentStore.getState().retry('agent-0')
    expect(useCloudAgentStore.getState().error).toBe(OFF)
    expect(useCloudAgentStore.getState().selectedAgentId).toBeNull()
  })

  it('an insights run and a cross-account run main refused: the status is left as it was, the page says why', async () => {
    api.insights.run.mockResolvedValueOnce(refused as any)
    await useInsightsStore.getState().startInsights()
    expect(useInsightsStore.getState()).toMatchObject({ status: 'idle', error: OFF })
    expect(useInsightsStore.getState().currentRunId).not.toEqual(refused)
    api.insights.runAll.mockResolvedValueOnce(refused as any)
    await useInsightsStore.getState().startCrossAccount()
    expect(useInsightsStore.getState()).toMatchObject({ status: 'idle', error: OFF, batchActive: false })
  })
})
