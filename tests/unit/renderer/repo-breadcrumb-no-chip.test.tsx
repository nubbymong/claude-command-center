// @vitest-environment jsdom
/**
 * Regression: the AI-usage chip was extracted out of RepoBreadcrumb into a
 * shared component (components/github/AiUsageChip) so it can also render in the
 * per-session status strip. RepoBreadcrumb is now path + repo slug + connection
 * only, and must NOT render the chip even when the meter is enabled and a report
 * is present.
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
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useGitHubStore.setState({ aiUsage: null, aiUsageStatus: 'pending' })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('RepoBreadcrumb no longer hosts the AI-usage chip', () => {
  it('does not render the chip even when the meter is enabled and a report is present', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, githubAiUsageEnabled: true } }))
    useGitHubStore.setState({ aiUsage: makeReport(), aiUsageStatus: 'ready' as any })
    await act(async () => {
      root.render(React.createElement(RepoBreadcrumb, { session: baseSession }))
    })
    expect(container.querySelector('[data-ai-usage-chip]')).toBeNull()
  })
})
