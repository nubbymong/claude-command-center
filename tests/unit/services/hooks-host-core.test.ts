import { describe, it, expect, vi } from 'vitest'
import { FakeChildTransport } from '../../../src/main/services/service-transport'
import { createHooksHost } from '../../../src/main/services/hooks-host-core'
import type { HooksGatewayHostFace } from '../../../src/main/services/hooks-host-core'

/** A no-op gateway whose start() resolves to a bind failure. Lets the bind-failed
 *  path be exercised DETERMINISTICALLY (a real bind failure is not reliable — the
 *  gateway tries the port plus random offsets). */
function stubGateway(start: HooksGatewayHostFace['start']): HooksGatewayHostFace {
  return {
    registerSessionWithSecret: () => {},
    unregisterSession: () => {},
    start,
    stop: async () => {},
    setPermissionGateActive: () => {},
    metrics: () => ({ inFlight: 0, eventsTotal: 0, dropsTotal: 0 }),
    hasSecret: () => false,
    _handleRequestForTest: async () => ({ status: 200, body: '' }),
    permissionRegister: () => {},
  }
}

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

  it('a start control message binds the requested port and announces bound to the parent', async () => {
    const t = new FakeChildTransport()
    createHooksHost(t.asHostTransport(), { healthBeat: false })
    // port 0 -> ephemeral OS-assigned port; the child must announce the ACTUAL bound port
    t.post({ type: 'start', port: 0 })
    await vi.waitFor(() => {
      expect(t.parentMessages.some((m) => m.type === 'bound')).toBe(true)
    })
    const bound = t.parentMessages.find((m) => m.type === 'bound') as { type: 'bound'; port: number; pid: number }
    expect(bound.port).toBeGreaterThan(0)
    // clean up the real listening socket so the test doesn't leak a handle.
    // `stop` -> gateway.stop() closes the server asynchronously; give it a tick.
    t.post({ type: 'stop' })
    await new Promise((r) => setTimeout(r, 50))
  })

  it('posts bind-failed (not bound) when the gateway cannot bind', async () => {
    const t = new FakeChildTransport()
    const gw = stubGateway(async () => ({
      enabled: false, listening: false, port: null, error: 'bind-failed after 5 attempts',
    }))
    createHooksHost(t.asHostTransport(), {
      healthBeat: false,
      createGateway: () => gw as unknown as never,
    } as never)
    t.post({ type: 'start', port: 19430 })
    await vi.waitFor(() => {
      expect(t.parentMessages.some((m) => m.type === 'bind-failed')).toBe(true)
    })
    const bf = t.parentMessages.find((m) => m.type === 'bind-failed') as { type: 'bind-failed'; error: string }
    expect(bf.error).toContain('bind-failed')
    expect(t.parentMessages.some((m) => m.type === 'bound')).toBe(false)
  })
})
