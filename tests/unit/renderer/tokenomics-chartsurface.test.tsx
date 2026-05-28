// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/renderer/stores/tokenomicsStore', () => ({
  useTokenomicsStore: (sel: any) => sel({ data: { dailyAggregates: {} } }),
}))

import { renderToStaticMarkup } from 'react-dom/server'
import { DailyChart } from '../../../src/renderer/components/TokenomicsPage'

describe('DailyChart V2 surface (U2.5)', () => {
  it('uses --surface-raised, not bg-surface0', () => {
    const html = renderToStaticMarkup(<DailyChart selectedDate={null} onSelectDate={() => {}} />)
    expect(html).toContain('--surface-raised')
  })
})
