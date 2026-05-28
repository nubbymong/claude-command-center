// tests/unit/channel-permissions.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
const pushed: any[][] = []
const ledger: any[] = []
vi.mock('../../src/main/ipc/channel-handlers', () => ({ pushPendingPermissions: (l: any[]) => pushed.push(l), pushLedgerEvent: vi.fn() }))
vi.mock('../../src/main/channel-ledger', () => ({ appendLedger: (r: any) => { ledger.push(r); return 'l' } }))
vi.mock('../../src/main/standing-approvals-store', () => ({ matchApproval: () => false }))
vi.mock('../../src/main/session-registry', () => ({ getSessionMeta: (id: string) => ({ id, label: id }) }))
let hookCb!: (e: any) => void
vi.mock('../../src/main/hooks/index', () => ({ getGateway: () => ({ subscribe: (cb: any) => { hookCb = cb; return () => {} } }) }))
const { startPermissionTray, getPending } = await import('../../src/main/channel-permissions')

describe('channel-permissions', () => {
  beforeEach(() => { pushed.length = 0; ledger.length = 0 })
  it('captures a PermissionRequest, pushes it to the renderer, and ledgers permission-prompt', () => {
    startPermissionTray()
    hookCb({ sessionId: 's1', event: 'PermissionRequest', payload: { tool: 'Bash', arguments: 'ls', requestId: 'r1' }, ts: 1 })
    expect(getPending()).toHaveLength(1)
    expect(pushed.at(-1)![0].requestId).toBe('r1')
    expect(ledger.some(r => r.kind === 'permission-prompt')).toBe(true)
  })
  it('auto-denies past the 50 cap and ledgers tray-overflow', () => {
    startPermissionTray()
    for (let i = 0; i < 55; i++) hookCb({ sessionId: 's', event: 'PermissionRequest', payload: { tool: 'Edit', arguments: 'x', requestId: `r${i}` }, ts: i })
    expect(getPending().length).toBeLessThanOrEqual(50)
    expect(ledger.some(r => r.kind === 'tray-overflow')).toBe(true)
  })
})
