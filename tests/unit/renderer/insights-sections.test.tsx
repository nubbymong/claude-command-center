// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { InsightsSections } from '../../../src/renderer/components/insights/InsightsSections'

describe('InsightsSections (U3.2)', () => {
  it('renders big-wins with titles + descs from structured input', () => {
    const html = renderToStaticMarkup(
      <InsightsSections sections={[
        { kind: 'big-wins', items: [{ title: 'W', desc: 'D' }] },
      ]} />
    )
    expect(html).toContain('W')
    expect(html).toContain('D')
  })
  it('uses --surface-raised on each section card', () => {
    const html = renderToStaticMarkup(
      <InsightsSections sections={[
        { kind: 'narrative', title: 'N', paragraphs: ['p1'] },
      ]} />
    )
    expect(html).toContain('--surface-raised')
  })
})
