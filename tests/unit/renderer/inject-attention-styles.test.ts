// @vitest-environment jsdom
// injectAttentionStyles (2.1.1) is the UNION of two copies that shared one
// element id: Sidebar's had the insights-pulse rules, TabBar's did not, and
// which one landed depended on mount order. Pin the union and the once-only.
import { describe, it, expect } from 'vitest'
import { injectAttentionStyles } from '../../../src/renderer/utils/injectAttentionStyles'

describe('injectAttentionStyles', () => {
  it('injects once under the shared id, with BOTH pulse rule sets', () => {
    injectAttentionStyles()
    injectAttentionStyles()
    const nodes = document.querySelectorAll('style#attention-pulse-styles')
    expect(nodes).toHaveLength(1)
    const css = nodes[0].textContent ?? ''
    expect(css).toContain('@keyframes attention-pulse')
    expect(css).toContain('.attention-pulse-bg')
    expect(css).toContain('@keyframes insights-pulse')
    expect(css).toContain('.insights-pulse-dot')
  })
})
