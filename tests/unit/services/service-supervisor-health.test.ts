import { describe, it, expect } from 'vitest'
import { ServiceSupervisor } from '../../../src/main/services/service-supervisor'
import { FakeChildTransport } from '../../../src/main/services/service-transport'

function makeSup() {
  const t = new FakeChildTransport()
  const sup = new ServiceSupervisor({
    forkChild: () => ({ transport: t, kill: () => t.kill(), onExit: () => {} }),
    defaultPort: 19430,
    emit: () => {},
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
  it('a bound message flips state to listening with a port + pid', () => {
    const { sup, t } = makeSup()
    sup.start()
    t.emitToParent({ type: 'bound', port: 19430, pid: 4242 })
    const h = sup.getDiagnosticsSnapshot().services[0]
    expect(h.state).toBe('listening'); expect(h.port).toBe(19430); expect(h.pid).toBe(4242)
    expect(h.host).toBe('utility-process')
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
})
