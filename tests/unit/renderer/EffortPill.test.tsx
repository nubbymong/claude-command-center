// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EffortPill } from '../../../src/renderer/components/ui/EffortPill'
import type { EffortLevel } from '../../../src/renderer/stores/sessionStore'

describe('EffortPill', () => {
  const LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']

  it('renders the level word and the matching effort token for every level', () => {
    for (const level of LEVELS) {
      const html = renderToStaticMarkup(<EffortPill level={level} />)
      // text + tooltip carry the meaning
      expect(html).toContain(`>${level}</span>`)
      expect(html).toContain(`Effort: ${level}`)
      // colour is driven by the per-level CSS var
      expect(html).toContain(`var(--effort-${level})`)
    }
  })

  it('renders nothing for an unknown level', () => {
    // @ts-expect-error deliberately invalid to exercise the guard
    const html = renderToStaticMarkup(<EffortPill level={'bogus'} />)
    expect(html).toBe('')
  })
})
