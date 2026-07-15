import { describe, it, expect } from 'vitest'
import { ServiceSupervisor } from '../../../src/main/services/service-supervisor'
import { FakeChildTransport } from '../../../src/main/services/service-transport'

describe('hooks backbone smoke (headless)', () => {
  it('a child event flows to a subscriber and the session buffer', () => {
    const t = new FakeChildTransport()
    const sup = new ServiceSupervisor({
      forkChild: () => ({ transport: t, kill: () => {}, onExit: () => {} }),
      defaultPort: 19430,
      emit: () => {},
    })
    const proxy = sup.start()
    const sid = 's1'
    proxy.registerSession(sid)
    const seen: string[] = []
    proxy.subscribe((e) => seen.push(e.event))
    t.emitToParent({ type: 'event', entry: { sessionId: sid, event: 'PostToolUse', toolName: 'Glob', summary: 'Glob', payload: {}, ts: 1 } as never })
    expect(seen).toEqual(['PostToolUse'])
    expect(proxy.getBuffer(sid)).toHaveLength(1)
    expect(sup.getDiagnosticsSnapshot().services[0].id).toBe('hooks')
  })
})
