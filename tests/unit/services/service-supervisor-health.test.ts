import { describe, it, expect } from 'vitest'
import { ServiceSupervisor } from '../../../src/main/services/service-supervisor'
import { FakeChildTransport } from '../../../src/main/services/service-transport'

function makeSup(emit: (channel: string, payload: unknown) => void = () => {}) {
  const t = new FakeChildTransport()
  const sup = new ServiceSupervisor({
    forkChild: () => ({ transport: t, kill: () => t.kill(), onExit: () => {} }),
    defaultPort: 19430,
    emit,
  })
  return { sup, t }
}

describe('ServiceSupervisor health', () => {
  it('snapshot starts with one hooks service in starting state', () => {
    const { sup } = makeSup()
    const snap = sup.getDiagnosticsSnapshot()
    expect(snap.services).toHaveLength(1)
    expect(snap.services[0].id).toBe('hooks')
    expect(snap.services[0].state).toBe('starting')
  })
  it('a child health beat updates counters and lastHeartbeat', () => {
    const { sup, t } = makeSup()
    sup.start()
    t.emitToParent({ type: 'health', inFlight: 2, eventsTotal: 10, dropsTotal: 0, stallsLastMin: 0 })
    const h = sup.getDiagnosticsSnapshot().services[0]
    expect(h.inFlight).toBe(2); expect(h.eventsTotal).toBe(10)
    expect(h.lastHeartbeatAt).toBeGreaterThan(0)
  })
  it('child stallsLastMin is recorded as childLoopStallsLastMin; throughput starts at 0', () => {
    const { sup, t } = makeSup()
    sup.start()
    t.emitToParent({ type: 'health', inFlight: 0, eventsTotal: 5, dropsTotal: 0, stallsLastMin: 3 })
    const h = sup.getDiagnosticsSnapshot().services[0]
    expect(h.childLoopStallsLastMin).toBe(3)
    // First beat has no prior sample -> honest 0, never a spike.
    expect(h.throughputPerSec).toBe(0)
  })
  it('computes throughputPerSec across successive health beats with an injected clock', () => {
    let clock = 1000
    const t = new FakeChildTransport()
    const sup = new ServiceSupervisor({
      forkChild: () => ({ transport: t, kill: () => t.kill(), onExit: () => {} }),
      defaultPort: 19430,
      emit: () => {},
      now: () => clock,
    })
    sup.start()
    t.emitToParent({ type: 'health', inFlight: 0, eventsTotal: 0, dropsTotal: 0, stallsLastMin: 0 })
    expect(sup.getDiagnosticsSnapshot().services[0].throughputPerSec).toBe(0)
    clock += 2000
    t.emitToParent({ type: 'health', inFlight: 0, eventsTotal: 10, dropsTotal: 0, stallsLastMin: 0 })
    // +10 events over 2s -> 5/s.
    expect(sup.getDiagnosticsSnapshot().services[0].throughputPerSec).toBe(5)
  })
  it('a bound message flips state to listening with a port + pid', () => {
    const { sup, t } = makeSup()
    sup.start()
    t.emitToParent({ type: 'bound', port: 19430, pid: 4242 })
    const h = sup.getDiagnosticsSnapshot().services[0]
    expect(h.state).toBe('listening'); expect(h.port).toBe(19430); expect(h.pid).toBe(4242)
    expect(h.host).toBe('utility-process')
  })
  it('forwards bound to the proxy so its status reflects listening (supervisor-driven path)', () => {
    const { sup, t } = makeSup()
    const proxy = sup.start()
    expect(proxy.status().listening).toBe(false)
    t.emitToParent({ type: 'bound', port: 19430, pid: 4242 })
    expect(proxy.status().listening).toBe(true)
    expect(proxy.status().port).toBe(19430)
  })
  it('forwarding bound emits HOOKS_STATUS to the renderer (supervisor-driven path)', () => {
    const emitted: Array<{ channel: string; payload: unknown }> = []
    const { sup, t } = makeSup((channel, payload) => emitted.push({ channel, payload }))
    sup.start()
    t.emitToParent({ type: 'bound', port: 19430, pid: 4242 })
    const status = emitted.find((e) => e.channel === 'hooks:status')
    expect(status).toBeDefined()
    expect((status!.payload as { listening: boolean }).listening).toBe(true)
    expect((status!.payload as { port: number }).port).toBe(19430)
  })
  it('start() returns a proxy and forwards child events to it (single-owner subscription)', () => {
    const { sup, t } = makeSup()
    const proxy = sup.start()
    const sid = 's1'; proxy.registerSession(sid)
    const seen: string[] = []; proxy.subscribe((e) => seen.push(e.event))
    t.emitToParent({ type: 'event', entry: { sessionId: sid, event: 'PostToolUse', summary: 'Glob', payload: {}, ts: 1 } as never })
    expect(seen).toEqual(['PostToolUse'])
    expect(proxy.getBuffer(sid)).toHaveLength(1)
  })
  it('appends a log entry from the child to the diagnostics log ring', () => {
    const { sup, t } = makeSup()
    sup.start()
    t.emitToParent({ type: 'log', entry: { ts: 1, serviceId: 'hooks', level: 'warn', code: 'x', message: 'hi' } })
    expect(sup.getDiagnosticsSnapshot().log.some((l) => l.code === 'x')).toBe(true)
  })
  it('pushes SERVICE_HEALTH_UPDATE with a snapshot on a bound transition', () => {
    const emitted: Array<{ channel: string; payload: unknown }> = []
    const { sup, t } = makeSup((c, p) => emitted.push({ channel: c, payload: p }))
    sup.start()
    emitted.length = 0   // drop the 'starting' push from spawnChild; assert the bound push
    t.emitToParent({ type: 'bound', port: 19430, pid: 4242 })
    const upd = emitted.find((e) => e.channel === 'serviceHealth:update')
    expect(upd).toBeDefined()
    const snap = upd!.payload as import('../../../src/shared/service-health').DiagnosticsSnapshot
    expect(snap.services[0].state).toBe('listening')
  })
  it('pushes SERVICE_HEALTH_UPDATE when a forwarded child log lands', () => {
    const emitted: Array<{ channel: string; payload: unknown }> = []
    const { sup, t } = makeSup((c, p) => emitted.push({ channel: c, payload: p }))
    sup.start()
    emitted.length = 0
    t.emitToParent({ type: 'log', entry: { ts: 1, serviceId: 'hooks', level: 'info', code: 'child-stop', message: 'stop' } })
    expect(emitted.some((e) => e.channel === 'serviceHealth:update')).toBe(true)
  })
  it('bind-failed marks crashed + kills the child to escalate (restart proven in the lifecycle suite)', () => {
    const { sup, t } = makeSup()
    sup.start()
    t.emitToParent({ type: 'bind-failed', error: 'bind-failed after N attempts' })
    const h = sup.getDiagnosticsSnapshot().services[0]
    expect(h.state).toBe('crashed')
    expect(h.lastError?.message).toContain('bind-failed')
    expect(sup.getDiagnosticsSnapshot().log.some((l) => l.code === 'bind-failed')).toBe(true)
    expect(t.killed).toBe(true)   // escalates by killing the child -> exit-driven restart path
  })
})
