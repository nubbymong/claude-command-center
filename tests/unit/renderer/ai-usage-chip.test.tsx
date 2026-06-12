// @vitest-environment jsdom
/**
 * Repo-strip AI-usage chip render states (v2 unified AI-usage meter).
 * The chip lives in RepoBreadcrumb and is gated on githubAiUsageEnabled +
 * aiUsage != null. This exercises the gate, the credits/cap idiom, and the
 * billed-overage warning idiom end to end through the real Zustand stores.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AiUsageReport } from '../../../src/shared/github-types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: RepoBreadcrumb } = await import('../../../src/renderer/components/RepoBreadcrumb')
const { useGitHubStore } = await import('../../../src/renderer/stores/githubStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')

let container: HTMLDivElement
let root: Root

const baseSession = {
  id: 'sess-1',
  label: 'web',
  workingDirectory: '/home/me/projects/web',
  model: 'sonnet',
  color: '#ff0000',
  configId: 'cfg-1',
  shellOnly: false,
  sessionType: 'local' as const,
  githubIntegration: { enabled: true, repoSlug: 'nubbymong/web', autoDetected: true },
}

function makeReport(over: Partial<AiUsageReport> = {}): AiUsageReport {
  return {
    fetchedAt: 1_700_000_000_000,
    source: 'ai_credit',
    timePeriod: { year: 2026, month: 6 },
    items: [
      {
        product: 'copilot',
        sku: 'sku',
        model: 'gpt-5',
        unitType: 'request',
        grossQuantity: 8120,
        grossAmount: 10,
        coveredQuantity: 8120,
        coveredAmount: 10,
        billedQuantity: 0,
        billedAmount: 0,
      },
    ],
    totals: { grossAmount: 10, coveredAmount: 10, billedAmount: 0 },
    ...over,
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Reset stores to a known baseline.
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useGitHubStore.setState({ aiUsage: null })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

async function render() {
  await act(async () => {
    root.render(React.createElement(RepoBreadcrumb, { session: baseSession }))
  })
}

describe('AI-usage chip gating', () => {
  it('does not render when the meter is disabled', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, githubAiUsageEnabled: false } }))
    useGitHubStore.setState({ aiUsage: makeReport() })
    await render()
    expect(container.querySelector('[data-ai-usage-chip]')).toBeNull()
  })

  it('does not render when enabled but no report has arrived', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, githubAiUsageEnabled: true } }))
    useGitHubStore.setState({ aiUsage: null })
    await render()
    expect(container.querySelector('[data-ai-usage-chip]')).toBeNull()
  })
})

describe('AI-usage chip content', () => {
  it('shows credits with no cap', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, githubAiUsageEnabled: true, copilotIncludedCredits: null },
    }))
    useGitHubStore.setState({ aiUsage: makeReport() })
    await render()
    const chip = container.querySelector('[data-ai-usage-chip]')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe('AI 8.1k')
  })

  it('shows used / cap when the cap is set', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, githubAiUsageEnabled: true, copilotIncludedCredits: 20000 },
    }))
    useGitHubStore.setState({ aiUsage: makeReport() })
    await render()
    const chip = container.querySelector('[data-ai-usage-chip]')
    expect(chip!.textContent).toBe('AI 8.1k/20k')
  })

  it('switches to the billed warning idiom when billedAmount > 0', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, githubAiUsageEnabled: true, copilotIncludedCredits: 20000 },
    }))
    useGitHubStore.setState({
      aiUsage: makeReport({ totals: { grossAmount: 30, coveredAmount: 18.31, billedAmount: 11.69 } }),
    })
    await render()
    const chip = container.querySelector('[data-ai-usage-chip]')
    expect(chip!.textContent).toBe('AI +$11.69')
  })
})
