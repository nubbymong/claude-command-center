import { describe, it, expect, vi } from 'vitest'
const handlers = new Map<string, (...a: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn), on: (ch: string, fn: any) => handlers.set(ch, fn) },
  BrowserWindow: { getAllWindows: () => [] },
}))
const sendMock = vi.fn(async () => ({ ok: true, transport: 'pty', ledgerId: 'l1' }))
vi.mock('../../src/main/channel-bus', () => ({ send: sendMock, retract: vi.fn() }))
vi.mock('../../src/main/channel-rules', () => ({ startRulesEngine: vi.fn() }))
const { registerChannelHandlers } = await import('../../src/main/ipc/channel-handlers')

describe('channel-handlers', () => {
  it('registers channels:send and routes to the bus', async () => {
    registerChannelHandlers()
    expect(handlers.has('channels:send')).toBe(true)
    const res = await handlers.get('channels:send')!({}, { targetSessionId: 's1', payload: { kind: 'rule', text: 'x' }, meta: { source: 'manual', ts: 'now' } })
    expect(sendMock).toHaveBeenCalled()
    expect(res.ok).toBe(true)
  })
})
