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

// P3.16 final-head VM finding D2 (row 14, ADR-022): the chip sits in the
// session status strip's overflow-hidden telemetry zone at the bottom of the
// window, where a popover placed below it inside the zone is never seen. The
// popover is portalled onto document.body, fixed at the chip's on-screen rect
// and opening upward, so no clipping ancestor and no region zoom applies to it.
describe('AI-usage popover placement (P3.16 final-head VM finding D2)', () => {
  const CHIP_RECT = { left: 352, top: 898, right: 406, bottom: 920, width: 54, height: 22, x: 352, y: 898 }
  const saved: Array<[string, PropertyDescriptor | undefined]> = []

  beforeEach(() => {
    for (const [key, value] of [['innerWidth', 1600], ['innerHeight', 1000]] as const) {
      saved.push([key, Object.getOwnPropertyDescriptor(window, key)])
      Object.defineProperty(window, key, { configurable: true, value })
    }
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, githubAiUsageEnabled: true } }))
    useGitHubStore.setState({ aiUsage: makeReport() })
  })

  afterEach(() => {
    for (const [key, desc] of saved.splice(0)) {
      if (desc) Object.defineProperty(window, key, desc)
      else delete (window as unknown as Record<string, unknown>)[key]
    }
  })

  /** The chip as the strip holds it: inside an overflow-hidden zone, under
   *  the strip root (zoomed when the Status bars scale is not 1). */
  async function renderInStrip(zoom?: number): Promise<HTMLElement> {
    await act(async () => {
      root.render(
        React.createElement('div', { 'data-strip-root': '', style: zoom ? { zoom } : undefined },
          React.createElement('div', { className: 'flex items-center gap-3 flex-1 min-w-0 overflow-hidden' },
            React.createElement(AiUsageChip))),
      )
    })
    const chip = container.querySelector('[data-ai-usage-chip]') as HTMLElement
    chip.getBoundingClientRect = () => ({ ...CHIP_RECT, toJSON: () => ({}) }) as DOMRect
    return chip
  }
  const dialog = () => document.querySelector('[role="dialog"][aria-label="AI usage"]') as HTMLElement | null

  it('the open popover has no clipping ancestor: it is not inside the strip', async () => {
    const chip = await renderInStrip()
    await act(async () => { chip.click() })
    const d = dialog()
    expect(d).not.toBeNull()
    expect(d!.closest('.overflow-hidden')).toBeNull()
    expect(container.contains(d)).toBe(false)
    expect(d!.parentElement).toBe(document.body)
  })

  it('it opens upward from the chip, right-aligned to it', async () => {
    const chip = await renderInStrip()
    await act(async () => { chip.click() })
    const d = dialog()!
    expect(d.className).not.toContain('top-full')
    expect(d.className).toContain('fixed')
    expect(d.style.bottom).toBe('108px') // 1000 - 898 + 6
    expect(d.style.right).toBe('1194px') // 1600 - 406
  })

  it('under a Status bars scale (the strip zoomed) it is placed outside the zoom, from the chip\'s on-screen rect', async () => {
    const chip = await renderInStrip(1.25)
    await act(async () => { chip.click() })
    const d = dialog()!
    expect(d.closest('[data-strip-root]')).toBeNull()
    expect(d.style.bottom).toBe('108px')
    expect(d.style.right).toBe('1194px')
  })

  it('a click inside keeps it open; an outside mousedown closes it; Escape closes it; the chip toggles it', async () => {
    const chip = await renderInStrip()
    await act(async () => { chip.click() })
    await act(async () => { dialog()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(dialog()).not.toBeNull()
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(dialog()).toBeNull()
    await act(async () => { chip.click() })
    expect(dialog()).not.toBeNull()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(dialog()).toBeNull()
    await act(async () => { chip.click() })
    expect(dialog()).not.toBeNull()
    await act(async () => { chip.click() })
    expect(dialog()).toBeNull()
  })
})
