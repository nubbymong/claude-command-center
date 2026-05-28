// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import KpiSidebar from '../../../src/renderer/components/KpiSidebar'

const current: any = { sessionsCount: 12, totalCostUsd: 1.5, daysCovered: 7 }

describe('KpiSidebar uses MetricChip (U3.4)', () => {
  it('renders the metric value font (JetBrains Mono) for at least one chip', () => {
    const html = renderToStaticMarkup(<KpiSidebar current={current} previous={null} />)
    expect(html).toContain('JetBrains Mono')
  })
  it('uses --surface-raised on cards', () => {
    const html = renderToStaticMarkup(<KpiSidebar current={current} previous={null} />)
    expect(html).toContain('--surface-raised')
  })
})
