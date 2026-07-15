// @vitest-environment jsdom
/**
 * Shared AI-usage chip render states (v2 unified AI-usage meter).
 * The chip now lives in its own component (components/github/AiUsageChip) so it
 * can be rendered in both the repo strip and the per-session status strip. It is
 * gated on githubAiUsageEnabled + aiUsage != null. This exercises the gate, the
 * credits/cap idiom, the billed-overage warning idiom, and the no-report
 * placeholder states (needs-auth vs loading/error) through the real Zustand
 * stores.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AiUsageReport } from '../../../src/shared/github-types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: AiUsageChip } = await import('../../../src/renderer/components/github/AiUsageChip')
const { useGitHubStore } = await import('../../../src/renderer/stores/githubStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')

const WARN = String.fromCodePoint(0x26a0)

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
  useGitHubStore.setState({ aiUsage: null, aiUsageStatus: 'pending', aiUsageCycle: null })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

async function render() {
  await act(async () => {
    root.render(React.createElement(AiUsageChip))
  })
}

describe('AI-usage chip gating', () => {
  it('does not render when the meter is disabled', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, githubAiUsageEnabled: false } }))
    useGitHubStore.setState({ aiUsage: makeReport() })
    await render()
    expect(container.querySelector('[data-ai-usage-chip]')).toBeNull()
  })

  it('enabled with NO report + scope-missing renders the actionable "Fix auth" placeholder', async () => {
    // Review nit on cd96a71: hiding the chip made the popover's "no data +
    // scope hint" state unreachable, so an enabled meter failed silently.
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, githubAiUsageEnabled: true } }))
    useGitHubStore.setState({ aiUsage: null, aiUsageStatus: 'scope-missing' })
    await render()
    const chip = container.querySelector('[data-ai-usage-chip]') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.textContent).toContain('Copilot')
    expect(chip.textContent).toContain('Fix auth')
    expect(chip.textContent).toContain(WARN)
    expect(chip.getAttribute('title')).toContain('Plan: read')
  })

  it('placeholder varies by status: no-auth shows "Fix auth" + connect-GitHub tooltip', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, githubAiUsageEnabled: true } }))
    useGitHubStore.setState({ aiUsage: null, aiUsageStatus: 'no-auth' })
    await render()
    const chip = container.querySelector('[data-ai-usage-chip]') as HTMLElement
    expect(chip.textContent).toContain('Fix auth')
    expect(chip.getAttribute('title')).toContain('Connect a GitHub account')
    expect(chip.getAttribute('title')).not.toContain('Plan: read')
  })

  it('error is a muted placeholder (not "Fix auth") with the could-not-reach tooltip', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, githubAiUsageEnabled: true } }))
    useGitHubStore.setState({ aiUsage: null, aiUsageStatus: 'error' })
    await render()
    const chip = container.querySelector('[data-ai-usage-chip]') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.textContent).not.toContain('Fix auth')
    expect(chip.textContent).toContain('Copilot')
    expect(chip.getAttribute('title')).toContain("Couldn't reach GitHub")
  })

  it('pending (loading) is a muted placeholder, not "Fix auth"', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, githubAiUsageEnabled: true } }))
    useGitHubStore.setState({ aiUsage: null, aiUsageStatus: 'pending' })
    await render()
    const chip = container.querySelector('[data-ai-usage-chip]') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.textContent).not.toContain('Fix auth')
    expect(chip.textContent).toContain('Copilot')
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
    expect(chip!.textContent).toBe('Copilot 8.1k credits')
  })

  it('shows used / cap when the cap is set', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, githubAiUsageEnabled: true, copilotIncludedCredits: 20000 },
    }))
    useGitHubStore.setState({ aiUsage: makeReport() })
    await render()
    const chip = container.querySelector('[data-ai-usage-chip]')
    expect(chip!.textContent).toBe('Copilot 8.1k/20k')
  })

  it('renders an inline progress bar when the cap is set (like the other status-line meters)', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, githubAiUsageEnabled: true, copilotIncludedCredits: 20000 },
    }))
    useGitHubStore.setState({ aiUsage: makeReport() })
    await render()
    const bar = container.querySelector('[data-copilot-bar]')
    expect(bar).not.toBeNull()
    expect(bar!.getAttribute('role')).toBe('progressbar')
  })

  it('renders NO progress bar without a cap (no denominator to fill toward)', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, githubAiUsageEnabled: true, copilotIncludedCredits: null },
    }))
    useGitHubStore.setState({ aiUsage: makeReport() })
    await render()
    expect(container.querySelector('[data-copilot-bar]')).toBeNull()
  })

  it('a billed overage under the cap no longer hijacks the headline (credit count leads)', async () => {
    // Pre-redesign this showed "Copilot +$11.69". Now usage (8.1k) is under the
    // cap (20k), so the chip stays the calm ratio -- the dollar figure lives in
    // the popover, not the strip.
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, githubAiUsageEnabled: true, copilotIncludedCredits: 20000 },
    }))
    useGitHubStore.setState({
      aiUsage: makeReport({ totals: { grossAmount: 30, coveredAmount: 18.31, billedAmount: 11.69 } }),
    })
    await render()
    const chip = container.querySelector('[data-ai-usage-chip]')
    expect(chip!.textContent).toBe('Copilot 8.1k/20k')
    expect(chip!.textContent).not.toContain('$')
  })

  it('prefers the cycle-scoped figure over the whole-month report', async () => {
    // The month report is dominated by pre-upgrade usage; the cycle (since the
    // Max upgrade) is the number the user expects to match GitHub's card.
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, githubAiUsageEnabled: true, copilotIncludedCredits: 20000 },
    }))
    useGitHubStore.setState({
      aiUsage: makeReport({ totals: { grossAmount: 120, coveredAmount: 108, billedAmount: 11.69 } }),
      aiUsageCycle: { since: '2026-06-13', through: '2026-06-14', creditsUsed: 891.29, billedUsd: 0 },
    })
    await render()
    const chip = container.querySelector('[data-ai-usage-chip]') as HTMLElement
    expect(chip.textContent).toBe('Copilot 891/20k')
    // The stale prior-plan overage must NOT leak into the strip.
    expect(chip.textContent).not.toContain('$')
  })

  it('shows a warning treatment + glyph only when cycle usage exceeds the cap', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, githubAiUsageEnabled: true, copilotIncludedCredits: 20000 },
    }))
    useGitHubStore.setState({
      aiUsage: makeReport(),
      aiUsageCycle: { since: '2026-06-13', through: '2026-06-14', creditsUsed: 21000, billedUsd: 4.2 },
    })
    await render()
    const chip = container.querySelector('[data-ai-usage-chip]') as HTMLElement
    expect(chip.textContent).toContain('Copilot 21k/20k')
    expect(chip.textContent).toContain(WARN)
  })
})
