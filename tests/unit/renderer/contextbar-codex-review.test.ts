// @vitest-environment jsdom
/**
 * P6.7 regression: ContextBar renders a compact "Codex review" row when the
 * Claude session has opted into the feature AND has at least one recorded
 * review. Hidden when feature is off OR when reviewCount is 0.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Mock the hook so each test can drive its return value.
const mockUsage = vi.fn<[string | null], any>()
vi.mock('../../../src/renderer/hooks/useCodexReviewUsage', () => ({
  useCodexReviewUsage: (id: string | null) => mockUsage(id),
}))

// Mock settingsStore so ContextBar's sl.show* flags are predictable.
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const DEFAULT_STATUS_LINE = {
    showModel: true,
    showTokens: true,
    showContextBar: true,
    showCost: true,
    showLinesChanged: true,
    showDuration: true,
    showRateLimits: true,
    showResetTime: true,
    font: 'sans',
    fontSize: 12,
  }
  return {
    DEFAULT_STATUS_LINE,
    useSettingsStore: (selector: (s: { settings: { statusLine: typeof DEFAULT_STATUS_LINE } }) => unknown) =>
      selector({ settings: { statusLine: DEFAULT_STATUS_LINE } }),
  }
})

const { default: ContextBar } = await import('../../../src/renderer/components/terminal/ContextBar')

const baseProps = {
  modelName: 'claude-sonnet-4-6',
  inputTokens: 12000,
  contextWindowSize: 200000,
  contextPercent: 6,
  costUsd: 0.12,
  sessionId: 'sess-1',
  enableCodexReview: false,
} as any

describe('ContextBar codex_review row (P6.7)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mockUsage.mockReset()
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('hides the codex review row when feature is off', () => {
    mockUsage.mockReturnValue(null)
    act(() => { root.render(React.createElement(ContextBar, baseProps)) })
    expect(container.textContent ?? '').not.toContain('Codex review')
  })

  it('hides the codex review row when feature is on but no reviews yet', () => {
    mockUsage.mockReturnValue(null)
    act(() => { root.render(React.createElement(ContextBar, { ...baseProps, enableCodexReview: true })) })
    expect(container.textContent ?? '').not.toContain('Codex review')
  })

  it('shows the row when feature is on and reviewCount > 0', () => {
    mockUsage.mockReturnValue({
      sessionId: 'sess-1',
      reviewCount: 3,
      totalInputTokens: 4500,
      totalOutputTokens: 2400,
      lastRateLimitWindow: { usedPercent: 0.59, resetsAt: 1714850000, planType: 'plus' },
      lastReviewAt: Date.now(),
    })
    act(() => { root.render(React.createElement(ContextBar, { ...baseProps, enableCodexReview: true })) })
    const text = container.textContent ?? ''
    expect(text).toContain('Codex review')
    expect(text).toContain('3 calls')
    expect(text).toContain('59%')
  })

  it('omits the rate-limit fragment when lastRateLimitWindow is null', () => {
    mockUsage.mockReturnValue({
      sessionId: 'sess-1',
      reviewCount: 1,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      lastRateLimitWindow: null,
      lastReviewAt: Date.now(),
    })
    act(() => { root.render(React.createElement(ContextBar, { ...baseProps, enableCodexReview: true })) })
    const text = container.textContent ?? ''
    expect(text).toContain('Codex review')
    // P6.10.1 pluralization: single call uses 'call' not 'calls'.
    expect(text).toContain('1 call')
    expect(text).not.toMatch(/\b1 calls\b/)
    // No "X% in 5h window" tail when rate-limit data is null
    expect(text).not.toMatch(/\d+% in 5h window/)
  })
})
