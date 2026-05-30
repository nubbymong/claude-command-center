// tests/unit/channel-permissions.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
const pushed: any[][] = []
const ledger: any[] = []
vi.mock('../../src/main/ipc/channel-handlers', () => ({ pushPendingPermissions: (l: any[]) => pushed.push(l), pushLedgerEvent: vi.fn() }))
vi.mock('../../src/main/channel-ledger', () => ({ appendLedger: (r: any) => { ledger.push(r); return 'l' } }))
const matchApproval = vi.fn<(tool: string) => boolean>(() => false)
vi.mock('../../src/main/standing-approvals-store', () => ({ matchApproval: (tool: string) => matchApproval(tool) }))
vi.mock('../../src/main/session-registry', () => ({ getSessionMeta: (id: string) => ({ id, label: id }) }))
let hookCb!: (e: any) => void
vi.mock('../../src/main/hooks/index', () => ({ getGateway: () => ({ subscribe: (cb: any) => { hookCb = cb; return () => {} } }) }))
const { startPermissionTray, getPending, resolvePending } = await import('../../src/main/channel-permissions')

describe('channel-permissions', () => {
  beforeEach(() => {
    // pending is a module-level map; drain it so each test starts clean (the
    // overflow case otherwise leaves 50 entries behind for later tests).
    for (const p of getPending()) resolvePending(p.requestId, 'denied')
    pushed.length = 0; ledger.length = 0; matchApproval.mockReset(); matchApproval.mockReturnValue(false)
  })
  it('captures a high-risk PermissionRequest, pushes it to the renderer, and ledgers permission-prompt', () => {
    startPermissionTray()
    // v2.0.0: non-high-risk now auto-allows, so the test uses a destructive
    // payload (rm -rf) to exercise the show path.
    hookCb({ sessionId: 's1', event: 'PermissionRequest', payload: { tool: 'Bash', arguments: 'rm -rf node_modules', requestId: 'r1' }, ts: 1 })
    expect(getPending()).toHaveLength(1)
    expect(pushed.at(-1)![0].requestId).toBe('r1')
    expect(ledger.some(r => r.kind === 'permission-prompt')).toBe(true)
  })
  it('auto-denies past the 50 cap and ledgers tray-overflow', () => {
    startPermissionTray()
    // v2.0.0: needs high-risk Bash payloads to actually enter the pending
    // map; non-Bash and non-high-risk auto-allow.
    for (let i = 0; i < 55; i++) hookCb({ sessionId: 's', event: 'PermissionRequest', payload: { tool: 'Bash', arguments: `rm -rf path-${i}`, requestId: `r${i}` }, ts: i })
    expect(getPending().length).toBeLessThanOrEqual(50)
    expect(ledger.some(r => r.kind === 'tray-overflow')).toBe(true)
  })
  it('read-only safelist tools auto-allow WITHOUT a ledger entry', () => {
    startPermissionTray()
    hookCb({ sessionId: 's1', event: 'PreToolUse', payload: { tool: 'Read', requestId: 'ro1' }, ts: 1 })
    expect(getPending()).toHaveLength(0)
    expect(ledger).toHaveLength(0)
  })
  it('a standing-approval auto-allow DOES ledger', () => {
    startPermissionTray()
    matchApproval.mockReturnValue(true)
    hookCb({ sessionId: 's1', event: 'PreToolUse', payload: { tool: 'Edit', requestId: 'sa1' }, ts: 1 })
    expect(getPending()).toHaveLength(0)
    expect(ledger.some(r => r.kind === 'permission-auto-allow')).toBe(true)
  })
  it('an acting tool (Edit) is surfaced as pending', () => {
    startPermissionTray()
    hookCb({ sessionId: 's1', event: 'PreToolUse', payload: { tool: 'Edit', requestId: 'edit-surface-1' }, ts: 1 })
    expect(getPending()).toHaveLength(1)
  })
})
