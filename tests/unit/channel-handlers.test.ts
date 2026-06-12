import { describe, it, expect, vi } from 'vitest'
const handlers = new Map<string, (...a: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn), on: (ch: string, fn: any) => handlers.set(ch, fn) },
  BrowserWindow: { getAllWindows: () => [] },
}))
const sendMock = vi.fn(async () => ({ ok: true, transport: 'pty', ledgerId: 'l1' }))
vi.mock('../../src/main/channel-bus', () => ({ send: sendMock, retract: vi.fn() }))
vi.mock('../../src/main/channel-rules', () => ({ startRulesEngine: vi.fn() }))
const loadRulesMock = vi.fn(() => [])
const loadApprovalsMock = vi.fn(() => [])
vi.mock('../../src/main/channel-rules-store', () => ({ loadRules: loadRulesMock, saveRule: vi.fn(), deleteRule: vi.fn() }))
vi.mock('../../src/main/standing-approvals-store', () => ({ loadApprovals: loadApprovalsMock, addApproval: vi.fn(), removeApproval: vi.fn() }))
const { registerChannelHandlers } = await import('../../src/main/ipc/channel-handlers')
import { IPC } from '../../src/shared/ipc-channels'

describe('channel-handlers', () => {
  it('registers channels:send and routes to the bus', async () => {
    registerChannelHandlers()
    expect(handlers.has('channels:send')).toBe(true)
    const res = await handlers.get('channels:send')!({}, { targetSessionId: 's1', payload: { kind: 'rule', text: 'x' }, meta: { source: 'manual', ts: 'now' } })
    expect(sendMock).toHaveBeenCalled()
    expect(res.ok).toBe(true)
  })

  it('forceTier / rule-crud / approval-crud return a structured error on malformed payload (no throw)', async () => {
    registerChannelHandlers()
    // undefined payload must NOT throw a TypeError on p.sessionId / p.op; the
    // guard returns a structured error synchronously (await tolerates both).
    expect(await handlers.get(IPC.CHANNELS_FORCE_TIER)!({}, undefined)).toEqual({ ok: false, reason: 'bad request' })
    expect(await handlers.get(IPC.CHANNELS_RULE_CRUD)!({}, undefined)).toEqual({ ok: false, reason: 'bad request' })
    expect(await handlers.get(IPC.CHANNELS_STANDING_APPROVAL_CRUD)!({}, undefined)).toEqual({ ok: false, reason: 'bad request' })
    expect(loadRulesMock).not.toHaveBeenCalled()
    expect(loadApprovalsMock).not.toHaveBeenCalled()
  })
})
