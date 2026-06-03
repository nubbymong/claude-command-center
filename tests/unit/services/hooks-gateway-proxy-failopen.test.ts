import { describe, it, expect, afterEach, vi } from 'vitest'
import { FakeChildTransport } from '../../../src/main/services/service-transport'
import { HooksGatewayProxy } from '../../../src/main/services/hooks-gateway-proxy'

describe('HooksGatewayProxy fail-open + permission bridge', () => {
  let p: HooksGatewayProxy
  afterEach(async () => { await p?.stop() })

  it('start() posts start to the child and resolves listening on bound', async () => {
    const t = new FakeChildTransport(); const sent: unknown[] = []
    t.onChild((m) => sent.push(m))
    p = new HooksGatewayProxy({ transport: t, defaultPort: 19430 })
    const startP = p.start()
    t.emitToParent({ type: 'bound', port: 19430, pid: 1 })
    const status = await startP
    expect(sent).toContainEqual({ type: 'start', port: 19430 })
    expect(status.listening).toBe(true)
  })

  it('a bound message sets listening + port AND broadcasts HOOKS_STATUS to the renderer', () => {
    const t = new FakeChildTransport()
    const emitted: Array<{ channel: string; payload: unknown }> = []
    p = new HooksGatewayProxy({
      transport: t,
      defaultPort: 19430,
      emit: (channel, payload) => emitted.push({ channel, payload }),
    })
    t.emitToParent({ type: 'bound', port: 19431, pid: 7 })
    expect(p.status().listening).toBe(true)
    expect(p.status().port).toBe(19431)
    const status = emitted.find((e) => e.channel === 'hooks:status')
    expect(status).toBeDefined()
    expect((status!.payload as { listening: boolean }).listening).toBe(true)
    expect((status!.payload as { port: number }).port).toBe(19431)
  })

  it('start() resolves via the 4s timeout fallback (no hang) when bound never arrives', async () => {
    vi.useFakeTimers()
    try {
      const t = new FakeChildTransport()
      p = new HooksGatewayProxy({ transport: t, defaultPort: 19430 })
      const startP = p.start()                 // utility mode: registers a 4s bound-waiter
      await vi.advanceTimersByTimeAsync(4000)   // no bound ever arrives -> fallback fires
      const status = await startP
      expect(status.listening).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() drains a pending start() so an awaited toggle resolves immediately (no 4s wait)', async () => {
    vi.useFakeTimers()
    try {
      const t = new FakeChildTransport()
      p = new HooksGatewayProxy({ transport: t, defaultPort: 19430 })
      const startP = p.start()   // pending, awaiting bound
      await p.stop()             // must drain the waiter synchronously
      // Without advancing timers: if stop() did NOT drain, this await would hang
      // (the 4s fallback timer never fires under fake timers) and the test times out.
      const status = await startP
      expect(status.listening).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('failOpen() resolves a pending start() with the in-process listening status', async () => {
    const t = new FakeChildTransport()
    p = new HooksGatewayProxy({ transport: t, defaultPort: 0 })
    const startP = p.start()   // utility mode: pending bound-waiter
    p.failOpen()               // swaps to in-process; drains the waiter once the gateway binds
    const status = await startP
    expect(status.listening).toBe(true)   // resolved with the real in-process bind, not a 4s fallback
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
    await p.start() // deterministically awaits the in-process bind (inProcessReady)
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

  it('a subscriber registered BEFORE failOpen still receives events after failOpen', () => {
    const t = new FakeChildTransport()
    p = new HooksGatewayProxy({ transport: t, defaultPort: 0 })
    const seen: string[] = []
    p.subscribe((e) => seen.push(e.event))
    p.failOpen() // copies current subscribers into the in-process gateway
    // After fail-open the in-process gateway owns fan-out; dispatchForTest delegates there.
    p.dispatchForTest({ sessionId: 's1', event: 'Stop', summary: 'Stop', payload: {}, ts: 1 } as never)
    expect(seen).toEqual(['Stop']) // fires exactly once, via the in-process gateway
  })

  it('a subscriber registered AFTER failOpen fires exactly once (no dormant double-add)', () => {
    const t = new FakeChildTransport()
    p = new HooksGatewayProxy({ transport: t, defaultPort: 0 })
    p.failOpen()
    const seen: string[] = []
    p.subscribe((e) => seen.push(e.event)) // registers directly on the in-process gateway
    p.dispatchForTest({ sessionId: 's1', event: 'Stop', summary: 'Stop', payload: {}, ts: 1 } as never)
    expect(seen).toEqual(['Stop'])
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
