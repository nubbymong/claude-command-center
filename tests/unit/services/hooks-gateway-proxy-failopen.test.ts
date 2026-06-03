import { describe, it, expect, afterEach } from 'vitest'
import { FakeChildTransport } from '../../../src/main/services/service-transport'
import { HooksGatewayProxy } from '../../../src/main/services/hooks-gateway-proxy'

describe('HooksGatewayProxy fail-open + permission bridge', () => {
  let p: HooksGatewayProxy
  afterEach(async () => { await p?.stop() })

  it('start() posts start to the child (utility-process mode)', async () => {
    const t = new FakeChildTransport(); const sent: unknown[] = []
    t.onChild((m) => sent.push(m))
    p = new HooksGatewayProxy({ transport: t, defaultPort: 19430 })
    await p.start()
    expect(sent).toContainEqual({ type: 'start', port: 19430 })
  })

  it('stop() posts stop to the child (utility-process mode)', async () => {
    const t = new FakeChildTransport(); const sent: unknown[] = []
    t.onChild((m) => sent.push(m))
    p = new HooksGatewayProxy({ transport: t, defaultPort: 19430 })
    await p.stop()
    expect(sent).toContainEqual({ type: 'stop' })
  })

  it('setPermissionGateActive posts setGate (utility-process mode)', () => {
    const t = new FakeChildTransport(); const sent: unknown[] = []
    t.onChild((m) => sent.push(m))
    p = new HooksGatewayProxy({ transport: t, defaultPort: 19430 })
    p.setPermissionGateActive(true)
    expect(sent).toContainEqual({ type: 'setGate', active: true })
  })

  it('failOpen() swaps to an in-process gateway; isInProcessFallback() true; registerSession still sync', () => {
    const t = new FakeChildTransport()
    p = new HooksGatewayProxy({ transport: t, defaultPort: 0 })
    p.failOpen()
    expect(p.isInProcessFallback()).toBe(true)
    expect(typeof p.registerSession('s1')).toBe('string')
  })

  it('after failOpen, registerSession does NOT post to the dead child and status reflects the in-process gateway', async () => {
    const t = new FakeChildTransport(); const sent: unknown[] = []
    t.onChild((m) => sent.push(m))
    p = new HooksGatewayProxy({ transport: t, defaultPort: 0 })
    p.failOpen()
    await new Promise((r) => setTimeout(r, 0)) // let the in-process gateway finish binding
    p.registerSession('s1')
    expect(sent.some((m: any) => m.type === 'register')).toBe(false) // went to in-process, not the child
    expect(p.status().listening).toBe(true)                          // in-process gateway is listening
  })

  it('failOpen replays known secrets into the in-process gateway', () => {
    const t = new FakeChildTransport()
    p = new HooksGatewayProxy({ transport: t, defaultPort: 0 })
    const secret = p.registerSession('s1') // minted while in utility-process mode
    p.failOpen()
    // the in-process gateway must know this session's secret so the live session keeps working
    expect(p.hasSecretForTest('s1')).toBe(true)
    expect(secret.length).toBeGreaterThan(0)
  })

  it('a child permission-open lets resolvePermission route the decision back to the child', () => {
    const t = new FakeChildTransport(); const sent: unknown[] = []
    t.onChild((m) => sent.push(m))
    p = new HooksGatewayProxy({ transport: t, defaultPort: 19430 })
    t.emitToParent({ type: 'permission-open', requestId: 'r1', sid: 's1' })
    p.resolvePermission('r1', 'approved')
    expect(sent).toContainEqual({ type: 'permission-respond', requestId: 'r1', decision: 'approved' })
  })
})
