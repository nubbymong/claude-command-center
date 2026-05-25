// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MetricChip } from '../../../src/renderer/components/ui/MetricChip'
import { StatusDot } from '../../../src/renderer/components/ui/StatusDot'

describe('ui primitives', () => {
  it('MetricChip renders label + mono value', () => {
    const html = renderToStaticMarkup(<MetricChip label="ctx" value="42%" />)
    expect(html).toContain('ctx')
    expect(html).toContain('42%')
  })
  it('StatusDot maps state to a colour var', () => {
    const html = renderToStaticMarkup(<StatusDot state="running" />)
    expect(html).toContain('--status-success')
  })
})
