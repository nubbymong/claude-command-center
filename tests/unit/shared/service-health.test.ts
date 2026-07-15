import { describe, it, expect } from 'vitest'
import { createInitialHealth, computeThroughput } from '../../../src/shared/service-health'
import type { ThroughputSample } from '../../../src/shared/service-health'
import { IPC } from '../../../src/shared/ipc-channels'

describe('service-health', () => {
  it('createInitialHealth returns a starting, in-process record', () => {
    const h = createInitialHealth('hooks', 'Hooks gateway')
    expect(h.id).toBe('hooks')
    expect(h.state).toBe('starting')
    expect(h.host).toBe('in-process-fallback')
    expect(h.inFlight).toBe(0)
    expect(h.restartCount).toBe(0)
    expect(h.throughputPerSec).toBe(0)
    expect(h.mainLoopStallsLastMin).toBe(0)
  })
  it('defines the service-health IPC channels', () => {
    expect(IPC.SERVICE_HEALTH_GET).toBe('serviceHealth:get')
    expect(IPC.SERVICE_HEALTH_UPDATE).toBe('serviceHealth:update')
    expect(IPC.SERVICE_RESTART).toBe('serviceHealth:restart')
  })
})

describe('computeThroughput', () => {
  const s = (eventsTotal: number, ts: number): ThroughputSample => ({ eventsTotal, ts })
  const cases: Array<{ name: string; prev: ThroughputSample | null; next: ThroughputSample; want: number }> = [
    { name: 'no prior sample -> 0 (cannot know a rate on the first beat)', prev: null, next: s(10, 1000), want: 0 },
    { name: '10 events over 1s -> 10/s', prev: s(0, 0), next: s(10, 1000), want: 10 },
    { name: '5 events over 2s -> 2.5/s', prev: s(0, 0), next: s(5, 2000), want: 2.5 },
    { name: '1 event over 3s -> 0.3/s (rounded 1dp)', prev: s(0, 0), next: s(1, 3000), want: 0.3 },
    { name: 'idle (counter unchanged) -> 0', prev: s(42, 1000), next: s(42, 2000), want: 0 },
    { name: 'same ts (div-by-0 guard) -> 0', prev: s(0, 1000), next: s(10, 1000), want: 0 },
    { name: 'ts went backwards -> 0', prev: s(0, 2000), next: s(10, 1000), want: 0 },
    { name: 'counter reset (restart) -> 0, never negative', prev: s(100, 0), next: s(5, 1000), want: 0 },
    { name: 'sub-second interval scales up: 3 events over 500ms -> 6/s', prev: s(0, 0), next: s(3, 500), want: 6 },
  ]
  for (const c of cases) {
    it(c.name, () => { expect(computeThroughput(c.prev, c.next)).toBe(c.want) })
  }
})
