// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatusDot } from '../../../src/renderer/components/ui/StatusDot'
describe('StatusDot permission-pending', () => {
  it('renders the warning colour for permission-pending', () => {
    expect(renderToStaticMarkup(<StatusDot state="permission-pending" />)).toContain('--status-warning')
  })
})
