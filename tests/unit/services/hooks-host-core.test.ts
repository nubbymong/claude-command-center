import { describe, it, expect } from 'vitest'
import { FakeChildTransport } from '../../../src/main/services/service-transport'
import { createHooksHost } from '../../../src/main/services/hooks-host-core'

describe('createHooksHost', () => {
  it('a register control message populates the gateway secret map', () => {
    const t = new FakeChildTransport()
    const host = createHooksHost(t.asHostTransport(), { healthBeat: false })
    t.post({ type: 'register', sid: 's1', secret: 'sekret' })
    expect(host._gatewayHasSecret('s1')).toBe(true)
  })

  it('posts a digested event to the parent on a real ingest', async () => {
    const t = new FakeChildTransport()
    const host = createHooksHost(t.asHostTransport(), { healthBeat: false })
    t.post({ type: 'register', sid: 's1', secret: 'sekret' })
    await host._ingestForTest('s1', 'sekret')
    expect(t.parentMessages.some((m) => m.type === 'event')).toBe(true)
  })

  it('routes a held-open permission registration to the parent (B2)', () => {
    const t = new FakeChildTransport()
    const host = createHooksHost(t.asHostTransport(), { healthBeat: false })
    host._registerResponderForTest('req-1', () => {})
    expect(t.parentMessages).toContainEqual({ type: 'permission-open', requestId: 'req-1', sid: '' })
  })

  it('a permission-respond control message invokes the local responder (B2 round-trip)', () => {
    const t = new FakeChildTransport()
    const host = createHooksHost(t.asHostTransport(), { healthBeat: false })
    let got: string | undefined
    host._registerResponderForTest('req-1', (d) => { got = d })
    t.post({ type: 'permission-respond', requestId: 'req-1', decision: 'approved' })
    expect(got).toBe('approved')
  })
})
