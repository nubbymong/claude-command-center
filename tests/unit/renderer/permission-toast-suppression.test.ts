import { describe, it, expect } from 'vitest'
import { visiblePermissionCards } from '../../../src/renderer/components/channels/PermissionToastStack'
import type { PendingPermission } from '../../../src/shared/channel-types'

function card(sessionId: string, requestId: string): PendingPermission {
  return {
    requestId,
    sessionId,
    sessionLabel: sessionId,
    tool: 'Bash',
    payloadPreview: 'echo hi',
    capturedAt: 0,
    transport: 'hook',
    tierLabel: 'hooks',
  }
}

describe('visiblePermissionCards (active-session suppression)', () => {
  it('hides the card for the session the user is currently viewing', () => {
    const out = visiblePermissionCards([card('a', '1'), card('b', '2')], 'a')
    expect(out.map((c) => c.sessionId)).toEqual(['b'])
  })

  it('shows every card when no session is active', () => {
    const out = visiblePermissionCards([card('a', '1'), card('b', '2')], null)
    expect(out).toHaveLength(2)
  })

  it('reappears when the active session switches away (pure recompute, no polling)', () => {
    const cards = [card('a', '1')]
    expect(visiblePermissionCards(cards, 'a')).toHaveLength(0) // hidden while viewing a
    expect(visiblePermissionCards(cards, 'b')).toHaveLength(1) // visible after switching to b
  })

  it('orders newest-first (reverse of insertion order)', () => {
    const out = visiblePermissionCards([card('a', '1'), card('a', '2')], 'b')
    expect(out.map((c) => c.requestId)).toEqual(['2', '1'])
  })

  it('suppresses ALL cards of the active session, not just one', () => {
    const out = visiblePermissionCards([card('a', '1'), card('a', '2'), card('b', '3')], 'a')
    expect(out.map((c) => c.sessionId)).toEqual(['b'])
  })
})
