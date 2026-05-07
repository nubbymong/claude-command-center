// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Mock useInsightsStore -- always return an empty catalogue so the existing
// "no completed runs" branch would fire absent the new Codex-only branch.
vi.mock('../../../src/renderer/stores/insightsStore', () => ({
  useInsightsStore: (sel: any) => sel({
    catalogue: { runs: [] },
    selectedRunId: null,
    selectRun: () => {},
    status: 'idle',
    statusMessage: '',
    startInsights: () => {},
    loadCatalogue: () => {},
  }),
}))

// tokenomicsStore exposes sessions via s.data?.sessions.
// The selector in InsightsPage is: useTokenomicsStore((s) => s.data?.sessions ?? {})
// We mock the store by passing a state object with shape { data: { sessions: mockSessions } }.
let mockSessions: Record<string, { provider: 'claude' | 'codex' }> = {}
vi.mock('../../../src/renderer/stores/tokenomicsStore', () => ({
  useTokenomicsStore: (sel: any) => sel({ data: { sessions: mockSessions } }),
}))

import InsightsPage from '../../../src/renderer/components/InsightsPage'

describe('InsightsPage Codex-only empty state', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mockSessions = {}
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('shows the Codex-only empty state when only Codex sessions exist', () => {
    mockSessions = { 's-1': { provider: 'codex' }, 's-2': { provider: 'codex' } }
    act(() => { root.render(React.createElement(InsightsPage)) })
    expect(container.textContent).toContain('Insights aggregate from your Claude sessions')
  })

  it('does NOT show the Codex-only empty state when at least one Claude session exists', () => {
    mockSessions = { 's-1': { provider: 'codex' }, 's-2': { provider: 'claude' } }
    act(() => { root.render(React.createElement(InsightsPage)) })
    expect(container.textContent ?? '').not.toContain('Insights aggregate from your Claude sessions')
  })

  it('does NOT show the Codex-only empty state for first-run users (no sessions)', () => {
    mockSessions = {}
    act(() => { root.render(React.createElement(InsightsPage)) })
    expect(container.textContent ?? '').not.toContain('Insights aggregate from your Claude sessions')
  })
})
