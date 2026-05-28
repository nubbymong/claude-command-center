import { describe, it, expect, vi } from 'vitest'
const ended: any[] = []
vi.mock('../../src/main/ipc/channel-handlers', () => ({ pushPendingPermissions: vi.fn(), pushLedgerEvent: vi.fn() }))
vi.mock('../../src/main/channel-ledger', () => ({ appendLedger: () => 'l' }))
vi.mock('../../src/main/standing-approvals-store', () => ({ matchApproval: () => false }))
vi.mock('../../src/main/session-registry', () => ({ getSessionMeta: () => undefined }))
let hookCb!: (e: any) => void
vi.mock('../../src/main/hooks/index', () => ({ getGateway: () => ({ subscribe: (cb: any) => { hookCb = cb; return () => {} } }) }))
const mod = await import('../../src/main/channel-permissions')

describe('respondPermission', () => {
  it('invokes the registered responder with the mapped decision', () => {
    mod.startPermissionTray()
    // v2.0.0: non-high-risk now auto-allows, so use a destructive Bash
    // payload to land an entry in the pending map that respondPermission
    // can actually resolve.
    hookCb({ sessionId: 's', event: 'PermissionRequest', payload: { tool: 'Bash', arguments: 'rm -rf x', requestId: 'r1' }, ts: 1 })
    mod.registerResponder('r1', (d) => ended.push(d))
    mod.respondPermission({ requestId: 'r1', decision: 'allow' })
    expect(ended).toEqual(['approved'])
  })
})
