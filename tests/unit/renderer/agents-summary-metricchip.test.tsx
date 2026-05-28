// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { SummaryTab } from '../../../src/renderer/components/CloudAgentsPage'

const a: any = {
  id: 'x', name: 'N', description: 'D', projectPath: '/p',
  status: 'completed', createdAt: Date.now(),
  cost: 0.0123, tokenUsage: { inputTokens: 1234, outputTokens: 56 },
  output: 'hi',
}

describe('Agent SummaryTab uses MetricChip (U6.3)', () => {
  it('renders JetBrains Mono on usage cells', () => {
    const html = renderToStaticMarkup(<SummaryTab agent={a} />)
    expect(html).toContain('JetBrains Mono')
  })
  it('uses --status-success for cost when present', () => {
    const html = renderToStaticMarkup(<SummaryTab agent={a} />)
    expect(html).toContain('--status-success')
  })
})
