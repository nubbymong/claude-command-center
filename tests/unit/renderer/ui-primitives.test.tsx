// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatusDot } from '../../../src/renderer/components/ui/StatusDot'

describe('ui primitives', () => {
  it('StatusDot maps state to a colour var', () => {
    const html = renderToStaticMarkup(<StatusDot state="running" />)
    expect(html).toContain('--status-success')
  })
})
