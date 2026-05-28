// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PermissionToast } from '../../../src/renderer/components/channels/PermissionToast'
import type { PendingPermission } from '../../../src/shared/channel-types'

const base: PendingPermission = { requestId: 'r', sessionId: 's', sessionLabel: 'api-server', provider: 'claude',
  tool: 'Bash', payloadPreview: 'ls -la', reason: 'list files', capturedAt: 0, transport: 'hook', tierLabel: 'hooks' }

describe('PermissionToast', () => {
  it('renders tool, preview, reason, alias and Allow/Deny/Allow once', () => {
    const html = renderToStaticMarkup(<PermissionToast p={base} focused onAllow={vi.fn()} onDeny={vi.fn()} onAllowOnce={vi.fn()} />)
    expect(html).toContain('api-server'); expect(html).toContain('Bash'); expect(html).toContain('ls -la')
    expect(html).toContain('list files'); expect(html).toContain('Allow'); expect(html).toContain('Deny')
  })
  it('shows a destructive strip and does NOT render the channel-relay badge for hooks transport', () => {
    const hot = { ...base, payloadPreview: 'rm -rf x', highRisk: { matched: 'rm -rf' } }
    const html = renderToStaticMarkup(<PermissionToast p={hot} focused onAllow={vi.fn()} onDeny={vi.fn()} onAllowOnce={vi.fn()} />)
    expect(html).toContain('destructive'); expect(html).toContain('rm -rf')
    expect(html).not.toContain('via channel-relay')
  })
  it('renders the via channel-relay badge only for channel-relay tierLabel', () => {
    const html = renderToStaticMarkup(<PermissionToast p={{ ...base, tierLabel: 'channel-relay' }} focused onAllow={vi.fn()} onDeny={vi.fn()} onAllowOnce={vi.fn()} />)
    expect(html).toContain('via channel-relay')
  })
})
