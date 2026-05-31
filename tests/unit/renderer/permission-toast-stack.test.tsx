import { describe, it, expect } from 'vitest'
import { visiblePermissionCards } from '../../../src/renderer/components/channels/PermissionToastStack'
import type { PendingPermission } from '../../../src/shared/channel-types'

const card = (requestId: string, sessionId: string): PendingPermission => ({
  requestId, sessionId, sessionLabel: sessionId, tool: 'Bash', payloadPreview: 'x',
  capturedAt: 0, transport: 'hook', tierLabel: 'hooks',
})

describe('visiblePermissionCards (active-session suppression)', () => {
  it('newest card is first (reversed insertion order)', () => {
    const out = visiblePermissionCards([card('a', 's1'), card('b', 's2')], null)
    expect(out.map((c) => c.requestId)).toEqual(['b', 'a'])
  })

  it('suppresses the card for the session the user is currently viewing', () => {
    const out = visiblePermissionCards([card('a', 's1'), card('b', 's2')], 's1')
    expect(out.map((c) => c.sessionId)).toEqual(['s2'])
  })

  it('reappears when the active session changes away from it', () => {
    const pending = [card('a', 's1')]
    expect(visiblePermissionCards(pending, 's1')).toHaveLength(0)   // viewing s1 -> hidden
    expect(visiblePermissionCards(pending, 's2')).toHaveLength(1)   // switched away -> shown
  })

  it('shows everything when no session is active', () => {
    expect(visiblePermissionCards([card('a', 's1'), card('b', 's2')], null)).toHaveLength(2)
  })
})
