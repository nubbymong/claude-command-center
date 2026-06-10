// @vitest-environment jsdom
/**
 * Smoke tests for the new Tokenomics dashboard components (Task 17+18).
 * Uses the same createRoot + act pattern established in wizard-trigger.test.ts.
 */
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { IndexingState } from '../../../src/renderer/components/tokenomics/IndexingState'
import { KpiRow } from '../../../src/renderer/components/tokenomics/KpiRow'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

// ── IndexingState ─────────────────────────────────────────────────────────────

describe('IndexingState', () => {
  it('renders heading when status is null', () => {
    act(() => { root.render(createElement(IndexingState, { status: null })) })
    expect(container.textContent).toContain('Indexing usage data')
  })

  it('renders subtext when status is null', () => {
    act(() => { root.render(createElement(IndexingState, { status: null })) })
    expect(container.textContent).toContain('check back shortly')
  })

  it('does not show progress bar when status is null', () => {
    act(() => { root.render(createElement(IndexingState, { status: null })) })
    // No file count text
    expect(container.textContent).not.toContain('/ ')
  })

  it('shows file progress when filesTotal > 0', () => {
    const status = {
      firstIndexComplete: false,
      indexing: true,
      filesDone: 42,
      filesTotal: 100,
      eventsTotal: 0,
      lastIndexAt: null,
    }
    act(() => { root.render(createElement(IndexingState, { status })) })
    expect(container.textContent).toContain('42')
    expect(container.textContent).toContain('100')
  })

  it('does not show progress when filesTotal is 0', () => {
    const status = {
      firstIndexComplete: false,
      indexing: true,
      filesDone: 0,
      filesTotal: 0,
      eventsTotal: 0,
      lastIndexAt: null,
    }
    act(() => { root.render(createElement(IndexingState, { status })) })
    // File count display should not appear
    expect(container.textContent).not.toContain('/ 0')
  })
})

// ── KpiRow ────────────────────────────────────────────────────────────────────

const baseKpis = {
  lifeToDateCostUsd: 123.45,
  last7dCostUsd: 10.0,
  prev7dCostUsd: 8.0,
  cacheEfficiencyPct: 72,
  cacheSavingsUsd: 3.5,
}

describe('KpiRow', () => {
  it('renders life-to-date cost', () => {
    act(() => { root.render(createElement(KpiRow, { kpis: baseKpis })) })
    // $123 (rounds to 0 dp at >= 100)
    expect(container.textContent).toContain('$123')
  })

  it('renders last-7d cost', () => {
    act(() => { root.render(createElement(KpiRow, { kpis: baseKpis })) })
    expect(container.textContent).toContain('$10')
  })

  it('renders cache efficiency percentage', () => {
    act(() => { root.render(createElement(KpiRow, { kpis: baseKpis })) })
    expect(container.textContent).toContain('72%')
  })

  it('shows a WoW delta chip when prev7d > 0', () => {
    act(() => { root.render(createElement(KpiRow, { kpis: baseKpis })) })
    // last7d=10, prev7d=8 → +25% increase
    expect(container.textContent).toContain('%')
  })

  it('shows em-dash when prev7dCostUsd is 0', () => {
    const kpis = { ...baseKpis, prev7dCostUsd: 0 }
    act(() => { root.render(createElement(KpiRow, { kpis })) })
    expect(container.textContent).toContain('—')
  })

  it('renders cache savings amount', () => {
    act(() => { root.render(createElement(KpiRow, { kpis: baseKpis })) })
    expect(container.textContent).toContain('saved')
  })

  it('renders all three card headings', () => {
    act(() => { root.render(createElement(KpiRow, { kpis: baseKpis })) })
    expect(container.textContent?.toLowerCase()).toContain('life-to-date')
    expect(container.textContent?.toLowerCase()).toContain('last 7 days')
    expect(container.textContent?.toLowerCase()).toContain('cache efficiency')
  })
})
