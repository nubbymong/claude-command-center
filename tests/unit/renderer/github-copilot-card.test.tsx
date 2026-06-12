// @vitest-environment jsdom
/**
 * Render-state tests for the Tokenomics GitHub Copilot billing card.
 * Exercises the report, scope-missing, and cap-bar states through the real
 * Zustand stores (mirrors ai-usage-chip.test.tsx). The card is the renderer's
 * "ACTUAL billing credits" surface, distinct from the page's estimates, so the
 * "billing data from GitHub" qualifier is asserted explicitly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AiUsageReport } from '../../../src/shared/github-types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { GitHubCopilotCard } = await import(
  '../../../src/renderer/components/tokenomics/GitHubCopilotCard'
)
const { useGitHubStore } = await import('../../../src/renderer/stores/githubStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import(
  '../../../src/renderer/stores/settingsStore'
)

let container: HTMLDivElement
let root: Root

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
        grossAmount: 20,
        coveredQuantity: 8000,
        coveredAmount: 18.31,
        billedQuantity: 120,
        billedAmount: 11.69,
      },
    ],
    totals: { grossAmount: 20, coveredAmount: 18.31, billedAmount: 11.69 },
    ...over,
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useGitHubStore.setState({ aiUsage: null, aiUsageStatus: 'pending' })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

async function render() {
  await act(async () => {
    root.render(React.createElement(GitHubCopilotCard))
  })
}

describe('GitHubCopilotCard', () => {
  it('labels itself as actual billing data (distinct from estimates)', async () => {
    useGitHubStore.setState({ aiUsage: makeReport(), aiUsageStatus: 'ok' })
    await render()
    expect(container.textContent).toContain('GitHub Copilot')
    expect(container.textContent).toContain('billing data from GitHub')
  })

  it('renders per-model rows and the billed total', async () => {
    useGitHubStore.setState({ aiUsage: makeReport(), aiUsageStatus: 'ok' })
    await render()
    expect(container.textContent).toContain('gpt-5')
    // Billed total appears as $11.69 (per-row and totals row).
    expect(container.textContent).toContain('$11.69')
  })

  it('shows the cap bar only when an included-credit cap is set', async () => {
    useGitHubStore.setState({ aiUsage: makeReport(), aiUsageStatus: 'ok' })
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, copilotIncludedCredits: 20000 },
    }))
    await render()
    expect(container.textContent).toContain('included')
    expect(container.textContent).toContain('20k')
  })

  it('does not show the cap bar without a cap', async () => {
    // A fully covered report (no billed overage) so the "billed beyond included
    // credits" note can't be confused with the cap-bar denominator text.
    useGitHubStore.setState({
      aiUsage: makeReport({
        items: [
          {
            product: 'copilot',
            sku: 'sku',
            model: 'gpt-5',
            unitType: 'request',
            grossQuantity: 8120,
            grossAmount: 20,
            coveredQuantity: 8120,
            coveredAmount: 20,
            billedQuantity: 0,
            billedAmount: 0,
          },
        ],
        totals: { grossAmount: 20, coveredAmount: 20, billedAmount: 0 },
      }),
      aiUsageStatus: 'ok',
    })
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, copilotIncludedCredits: null },
    }))
    await render()
    // The cap-bar denominator reads "X / Y included credits"; absent without a cap.
    expect(container.textContent).not.toContain('/ 20k included')
    expect(container.textContent).not.toContain('included credits')
  })

  it('scope-missing (no report) shows action guidance and a Settings button', async () => {
    useGitHubStore.setState({ aiUsage: null, aiUsageStatus: 'scope-missing' })
    await render()
    expect(container.textContent).toContain('Plan: read')
    expect(container.textContent).toContain('Fix in Settings')
  })

  it('renders an empty-period note when there are no usage rows', async () => {
    useGitHubStore.setState({
      aiUsage: makeReport({ items: [], totals: { grossAmount: 0, coveredAmount: 0, billedAmount: 0 } }),
      aiUsageStatus: 'ok',
    })
    await render()
    expect(container.textContent).toContain('No billed AI-credit usage this period')
  })
})
