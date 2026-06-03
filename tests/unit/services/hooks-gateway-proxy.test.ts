import { describe, it, expect } from 'vitest'
import { FakeChildTransport } from '../../../src/main/services/service-transport'
import { HooksGatewayProxy } from '../../../src/main/services/hooks-gateway-proxy'

describe('HooksGatewayProxy (core)', () => {
  it('registerSession returns a secret SYNCHRONOUSLY and posts register to the child', () => {
    const t = new FakeChildTransport(); const sent: unknown[] = []
    t.onChild((m) => sent.push(m))
    const p = new HooksGatewayProxy({ transport: t, defaultPort: 19430 })
    const secret = p.registerSession('s1')
    expect(typeof secret).toBe('string')
    expect(secret.length).toBeGreaterThan(0)
    expect(sent).toContainEqual({ type: 'register', sid: 's1', secret })
  })

  it('buffers digested events from the child and serves them via getBuffer', () => {
    const t = new FakeChildTransport()
    const p = new HooksGatewayProxy({ transport: t, defaultPort: 19430 })
    p.registerSession('s1')
    t.emitToParent({ type: 'event', entry: { sessionId: 's1', event: 'PostToolUse', toolName: 'Glob', summary: 'Glob', payload: {}, ts: 1 } as never })
    expect(p.getBuffer('s1')).toHaveLength(1)
  })

  it('fans a child event out to subscribers', () => {
    const t = new FakeChildTransport()
    const p = new HooksGatewayProxy({ transport: t, defaultPort: 19430 })
    const seen: unknown[] = []; p.subscribe((e) => seen.push(e))
    t.emitToParent({ type: 'event', entry: { sessionId: 's1', event: 'Stop', summary: 'Stop', payload: {}, ts: 2 } as never })
    expect(seen).toHaveLength(1)
  })

  it('unregisterSession clears the buffer and posts unregister to the child', () => {
    const t = new FakeChildTransport(); const sent: unknown[] = []
    t.onChild((m) => sent.push(m))
    const p = new HooksGatewayProxy({ transport: t, defaultPort: 19430 })
    p.registerSession('s1')
    t.emitToParent({ type: 'event', entry: { sessionId: 's1', event: 'Stop', summary: 'Stop', payload: {}, ts: 2 } as never })
    p.unregisterSession('s1')
    expect(p.getBuffer('s1')).toHaveLength(0)
    expect(sent).toContainEqual({ type: 'unregister', sid: 's1' })
  })

  it('respects RING_BUFFER_CAP (oldest dropped)', () => {
    const t = new FakeChildTransport()
    const p = new HooksGatewayProxy({ transport: t, defaultPort: 19430 })
    for (let i = 0; i < 250; i++) {
      t.emitToParent({ type: 'event', entry: { sessionId: 's1', event: 'PostToolUse', summary: String(i), payload: {}, ts: i } as never })
    }
    expect(p.getBuffer('s1')).toHaveLength(200)
    expect(p.getBuffer('s1')[0].summary).toBe('50') // first 50 dropped
  })

  // The supervisor (Task 9) owns the transport subscription, so the proxy must be
  // able to NOT self-subscribe and instead receive messages via handleChildMessage.
  it('with selfSubscribe:false it ignores direct transport emits but processes handleChildMessage', () => {
    const t = new FakeChildTransport()
    const p = new HooksGatewayProxy({ transport: t, defaultPort: 19430, selfSubscribe: false })
    t.emitToParent({ type: 'event', entry: { sessionId: 's1', event: 'Stop', summary: 'x', payload: {}, ts: 1 } as never })
    expect(p.getBuffer('s1')).toHaveLength(0) // not self-subscribed
    p.handleChildMessage({ type: 'event', entry: { sessionId: 's1', event: 'Stop', summary: 'x', payload: {}, ts: 1 } as never })
    expect(p.getBuffer('s1')).toHaveLength(1)
  })
})
