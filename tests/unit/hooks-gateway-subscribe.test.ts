// tests/unit/hooks-gateway-subscribe.test.ts
import { describe, it, expect, vi } from 'vitest'
import { HooksGateway } from '../../src/main/hooks/hooks-gateway'

describe('HooksGateway.subscribe', () => {
  it('synchronously forwards a dispatched event and unsubscribes', () => {
    // Real constructor requires { emit } -- pass a stub so the gateway constructs cleanly.
    const gw = new HooksGateway({ emit: vi.fn() })
    const cb = vi.fn()
    const off = gw.subscribe(cb)
    // dispatchForTest is a thin seam that runs the same path ingest uses after redaction.
    gw.dispatchForTest({ sessionId: 's1', event: 'PermissionRequest', payload: { tool: 'Bash' }, ts: 1 })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0].event).toBe('PermissionRequest')
    off()
    gw.dispatchForTest({ sessionId: 's1', event: 'Stop', payload: {}, ts: 2 })
    expect(cb).toHaveBeenCalledTimes(1)
  })
  it('a throwing subscriber does not break other subscribers', () => {
    const gw = new HooksGateway({ emit: vi.fn() })
    const good = vi.fn()
    gw.subscribe(() => { throw new Error('boom') })
    gw.subscribe(good)
    expect(() => gw.dispatchForTest({ sessionId: 's2', event: 'Stop', payload: {}, ts: 3 })).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
  })
})
