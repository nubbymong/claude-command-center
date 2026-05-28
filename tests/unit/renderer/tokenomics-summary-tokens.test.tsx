// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SummaryCards } from '../../../src/renderer/components/TokenomicsPage'

describe('SummaryCards V2 surfaces (U2.4)', () => {
  it('uses --surface-raised on each card, not bg-surface0', () => {
    const html = renderToStaticMarkup(
      <SummaryCards today={1} week={2} fiveHour={3} allTime={4} />
    )
    expect(html).toContain('--surface-raised')
  })
  it('uses --status-danger for high-rate-limit indicator', () => {
    const html = renderToStaticMarkup(
      <SummaryCards today={0} week={0} fiveHour={0} allTime={0} rateLimitCurrent={95} />
    )
    expect(html).toContain('--status-danger')
  })
})
