// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TelemetryChips } from '../../../src/renderer/components/BottomToolbar'

describe('TelemetryChips', () => {
  it('omits cost chip when costUsd is absent', () => {
    const html = renderToStaticMarkup(<TelemetryChips data={{ model:'sonnet-4-6' }} />)
    expect(html).toContain('sonnet-4-6')
    expect(html).not.toContain('$')
  })
  it('renders cost + ctx chips when present', () => {
    const html = renderToStaticMarkup(<TelemetryChips data={{ model:'sonnet-4-6', costUsd:1.23, contextPct:42 }} />)
    expect(html).toContain('1.23')
    expect(html).toContain('42')
  })
  it('renders bypassPermissions mode as loud danger', () => {
    const html = renderToStaticMarkup(<TelemetryChips data={{ mode:'bypassPermissions' }} />)
    expect(html).toContain('--status-danger')
  })
})
