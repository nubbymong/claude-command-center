// @vitest-environment jsdom
// injectAttentionStyles (2.1.1) is the UNION of two copies that shared one
// element id: Sidebar's had the insights-pulse rules, TabBar's did not, and
// which one landed depended on mount order. Pin the union and the once-only.
import { describe, it, expect, beforeEach } from 'vitest'
import { injectAttentionStyles, ATTENTION_PULSE_PEAK, ATTENTION_PULSE_REST } from '../../../src/renderer/utils/injectAttentionStyles'

beforeEach(() => { document.getElementById('attention-pulse-styles')?.remove() })

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

  // P3.16a (U4): the pulse overlay is the session's identity colour, painted
  // under the card or tab text. Its opacity must never be 1 -- which is what a
  // plain class rule with no opacity of its own gives it whenever the
  // animation is not running (a capture with animations disabled, reduced
  // motion), and an opaque identity colour under the text is unreadable.
  describe('the pulse never paints the identity colour opaque (P3.16a, U4)', () => {
    const css = (): string => {
      injectAttentionStyles()
      return document.querySelector('style#attention-pulse-styles')?.textContent ?? ''
    }
    const rule = (text: string, selector: string): string => {
      const at = text.indexOf(selector + ' {')
      expect(at, selector).toBeGreaterThan(-1)
      return text.slice(at, text.indexOf('}', at))
    }

    it('the resting opacity (no animation) is a low tint, and the peak is the one the contrast test reads', () => {
      const text = css()
      expect(rule(text, '.attention-pulse-bg')).toContain(`opacity: ${ATTENTION_PULSE_REST};`)
      expect(rule(text, '.attention-pulse-bg')).toContain('animation: attention-pulse 2s ease-in-out infinite;')
      const frames = text.slice(text.indexOf('@keyframes attention-pulse'), text.indexOf('.attention-pulse-bg'))
      expect(frames).toMatch(/0%, 100% \{ opacity: 0; \}/)
      expect(frames).toContain(`50% { opacity: ${ATTENTION_PULSE_PEAK}; }`)
      expect(ATTENTION_PULSE_REST).toBeLessThan(1)
    })

    it('reduced motion holds the resting tint instead of pulsing', () => {
      const text = css()
      const at = text.indexOf('@media (prefers-reduced-motion: reduce)')
      expect(at, 'a reduced-motion block').toBeGreaterThan(-1)
      const block = text.slice(at, text.indexOf('}', text.indexOf('}', at) + 1) + 1)
      expect(block).toContain('.attention-pulse-bg')
      expect(block).toContain('animation: none;')
      expect(block).toContain(`opacity: ${ATTENTION_PULSE_REST};`)
    })
  })
})
