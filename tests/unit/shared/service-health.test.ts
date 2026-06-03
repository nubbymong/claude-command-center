import { describe, it, expect } from 'vitest'
import { createInitialHealth } from '../../../src/shared/service-health'
import { IPC } from '../../../src/shared/ipc-channels'

describe('service-health', () => {
  it('createInitialHealth returns a starting, in-process record', () => {
    const h = createInitialHealth('hooks', 'Hooks gateway')
    expect(h.id).toBe('hooks')
    expect(h.state).toBe('starting')
    expect(h.host).toBe('in-process-fallback')
    expect(h.inFlight).toBe(0)
    expect(h.restartCount).toBe(0)
  })
  it('defines the service-health IPC channels', () => {
    expect(IPC.SERVICE_HEALTH_GET).toBe('serviceHealth:get')
    expect(IPC.SERVICE_HEALTH_UPDATE).toBe('serviceHealth:update')
    expect(IPC.SERVICE_RESTART).toBe('serviceHealth:restart')
  })
})
