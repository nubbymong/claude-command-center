// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PermissionToast } from '../../../src/renderer/components/channels/PermissionToast'
import type { PendingPermission } from '../../../src/shared/channel-types'

const base: PendingPermission = { requestId: 'r', sessionId: 's', sessionLabel: 'api-server', provider: 'claude',
  tool: 'Bash', payloadPreview: 'ls -la', capturedAt: 0, transport: 'hook', tierLabel: 'hooks' }

describe('PermissionToast', () => {
  it('renders label, tool, preview, and the Go to session / Ignore actions', () => {
    const html = renderToStaticMarkup(<PermissionToast p={base} onGoToSession={vi.fn()} onIgnore={vi.fn()} />)
    expect(html).toContain('api-server'); expect(html).toContain('Bash'); expect(html).toContain('ls -la')
    expect(html).toContain('needs your permission')
    expect(html).toContain('Go to session'); expect(html).toContain('Ignore')
  })
  it('shows a destructive strip for high-risk and never offers an allow/deny action', () => {
    const hot = { ...base, payloadPreview: 'rm -rf x', highRisk: { matched: 'rm -rf' } }
    const html = renderToStaticMarkup(<PermissionToast p={hot} onGoToSession={vi.fn()} onIgnore={vi.fn()} />)
    expect(html).toContain('destructive'); expect(html).toContain('rm -rf')
    expect(html).not.toContain('Allow'); expect(html).not.toContain('Deny')
  })
  it('renders the generic message (no tool block) when the card was not enriched', () => {
    const generic = { ...base, tool: 'Permission', payloadPreview: 'Claude needs your permission' }
    const html = renderToStaticMarkup(<PermissionToast p={generic} onGoToSession={vi.fn()} onIgnore={vi.fn()} />)
    expect(html).toContain('Claude needs your permission')
  })
  it('is mouse-only: both action buttons are out of the keyboard tab order (tabIndex -1)', () => {
    // Guards against a card stealing focus from the terminal or a stray key
    // activating an action while the user is typing. Click only.
    const html = renderToStaticMarkup(<PermissionToast p={base} onGoToSession={vi.fn()} onIgnore={vi.fn()} />)
    expect(html.split('tabindex="-1"').length - 1).toBe(2)
  })
})
