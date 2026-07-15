// @vitest-environment jsdom
// CopilotMeterSettings: the inline Copilot AI-credits config that lives in the
// Status Line settings tab (next to the "Copilot Usage" toggle). It owns the
// three values GitHub does not expose via API for personal accounts -- plan
// label, included-credit allowance, and plan-cycle start -- plus a live preview
// of the chip. Replaces the old GitHub-tab AiUsageSettings (cap-only).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: CopilotMeterSettings } = await import(
  '../../../src/renderer/components/settings/CopilotMeterSettings'
)
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useGitHubStore } = await import('../../../src/renderer/stores/githubStore')

let container: HTMLDivElement
let root: Root
let updateSettingsSpy: ReturnType<typeof vi.spyOn>
let loadAiUsageSpy: ReturnType<typeof vi.spyOn>

// Drive a controlled <input> the way React expects: native value setter, then a
// bubbling 'input' event so React's onChange fires.
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function enableMeter(extra: Record<string, unknown> = {}) {
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, githubAiUsageEnabled: true, ...extra },
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useGitHubStore.setState({ aiUsage: null, aiUsageStatus: 'pending', aiUsageCycle: null })
  updateSettingsSpy = vi
    .spyOn(useSettingsStore.getState(), 'updateSettings')
    .mockResolvedValue(undefined as never)
  loadAiUsageSpy = vi
    .spyOn(useGitHubStore.getState(), 'loadAiUsage')
    .mockResolvedValue(undefined as never)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function render() {
  act(() => root.render(React.createElement(CopilotMeterSettings)))
}

describe('CopilotMeterSettings', () => {
  it('renders nothing when the meter is disabled', () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, githubAiUsageEnabled: false } }))
    render()
    expect(container.textContent).toBe('')
  })

  it('relabels the cap as a CREDIT count, not USD', () => {
    enableMeter()
    render()
    expect(container.textContent).toContain('Included AI credits')
    expect(container.textContent).not.toContain('Included credits (USD)')
  })

  it('exposes plan label, included-credit, and cycle-start inputs', () => {
    enableMeter()
    render()
    expect(container.querySelector('input[type="text"]')).not.toBeNull() // plan label
    expect(container.querySelector('input[type="number"]')).not.toBeNull() // included credits
    expect(container.querySelector('input[type="date"]')).not.toBeNull() // cycle start
  })

  it('persists the plan label', () => {
    enableMeter()
    render()
    const text = container.querySelector('input[type="text"]') as HTMLInputElement
    typeInto(text, 'Max')
    expect(updateSettingsSpy).toHaveBeenCalledWith({ copilotPlanName: 'Max' })
  })

  it('persists a numeric included-credit allowance', () => {
    enableMeter()
    render()
    const number = container.querySelector('input[type="number"]') as HTMLInputElement
    typeInto(number, '20000')
    expect(updateSettingsSpy).toHaveBeenCalledWith({ copilotIncludedCredits: 20000 })
  })

  it('clears the allowance to null on an empty input', () => {
    enableMeter({ copilotIncludedCredits: 20000 })
    render()
    const number = container.querySelector('input[type="number"]') as HTMLInputElement
    typeInto(number, '')
    expect(updateSettingsSpy).toHaveBeenCalledWith({ copilotIncludedCredits: null })
  })

  it('persists the cycle start AND forces a usage refresh so the figure recomputes now', async () => {
    enableMeter()
    render()
    const date = container.querySelector('input[type="date"]') as HTMLInputElement
    typeInto(date, '2026-06-13')
    expect(updateSettingsSpy).toHaveBeenCalledWith({ copilotCreditsCycleStart: '2026-06-13' })
    // The force-refresh is chained after the persist resolves (so main re-reads
    // the new cycle start), which lands a microtask later -- flush it.
    await act(async () => { await Promise.resolve() })
    expect(loadAiUsageSpy).toHaveBeenCalledWith(true)
  })

  it('shows a live preview of the chip', () => {
    enableMeter({ copilotIncludedCredits: 20000, copilotCreditsCycleStart: '2026-06-13' })
    useGitHubStore.setState({
      aiUsage: {
        fetchedAt: 0,
        source: 'ai_credit',
        timePeriod: { year: 2026, month: 6 },
        items: [],
        totals: { grossAmount: 0, coveredAmount: 0, billedAmount: 0 },
      },
      aiUsageCycle: { since: '2026-06-13', through: '2026-06-14', creditsUsed: 891.29, billedUsd: 0 },
      aiUsageStatus: 'ok',
    })
    render()
    expect(container.textContent).toContain('Preview')
    expect(container.textContent).toContain('Copilot 891/20k')
  })
})
