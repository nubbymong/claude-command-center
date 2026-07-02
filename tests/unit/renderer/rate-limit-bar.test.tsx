// @vitest-environment jsdom
/**
 * RateLimitBar per-window reset display.
 *
 * Bug: the status strip showed a single standalone "resets <5h time>" after BOTH
 * the 5h and 7d bars, so the reset appeared to belong to whichever bar it sat
 * next to (usually 7d) -- misleading. The reset now renders inline in each bar
 * so 5h shows the 5h reset and 7d shows the 7d reset (gated by showResetTime).
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: RateLimitBar } = await import('../../../src/renderer/components/terminal/RateLimitBar')

describe('RateLimitBar per-window reset', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders an inline reset time when showReset and resets are provided', () => {
    act(() => root.render(<RateLimitBar label="7d" pct={40} resets="2026-07-05T00:00:00Z" showReset />))
    expect(container.textContent).toContain('resets')
  })

  it('renders no visible reset text when showReset is false', () => {
    act(() => root.render(<RateLimitBar label="7d" pct={40} resets="2026-07-05T00:00:00Z" showReset={false} />))
    expect(container.textContent).not.toContain('resets')
  })

  it('renders no reset text when resets is absent even if showReset', () => {
    act(() => root.render(<RateLimitBar label="5h" pct={40} showReset />))
    expect(container.textContent).not.toContain('resets')
  })
})
