// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MetricChip } from '../../../src/renderer/components/ui/MetricChip'

describe('MetricChip', () => {
  it('renders label + value with semantic tokens', () => {
    const html = renderToStaticMarkup(<MetricChip label="Cost" value="$1.23" />)
    expect(html).toContain('Cost')
    expect(html).toContain('$1.23')
    expect(html).toContain('--text-muted')
  })

  it('renders tone="success" using status-success token', () => {
    const html = renderToStaticMarkup(<MetricChip label="OK" value="42" tone="success" />)
    expect(html).toContain('--status-success')
  })

  it('renders tone="danger" using status-danger token', () => {
    const html = renderToStaticMarkup(<MetricChip label="High" value="99%" tone="danger" />)
    expect(html).toContain('--status-danger')
  })

  it('renders tone="warning" using status-warning token', () => {
    const html = renderToStaticMarkup(<MetricChip label="Mid" value="60%" tone="warning" />)
    expect(html).toContain('--status-warning')
  })

  it('uses JetBrains Mono on the value (tabular numerics)', () => {
    const html = renderToStaticMarkup(<MetricChip label="Tokens" value="84K" />)
    expect(html).toContain('JetBrains Mono')
  })
})
