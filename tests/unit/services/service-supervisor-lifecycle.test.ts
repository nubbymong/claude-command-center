import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ServiceSupervisor } from '../../../src/main/services/service-supervisor'
import { FakeChildTransport } from '../../../src/main/services/service-transport'

describe('ServiceSupervisor lifecycle', () => {
  let sup: ServiceSupervisor | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(async () => {
    vi.useRealTimers()
    await sup?.getProxy()?.stop()   // close any in-process socket from fail-open
    sup = undefined
  })

  it('restarts the child on unexpected exit (forkChild called again after backoff)', () => {
    let exitCb: (() => void) | null = null
    const fork = vi.fn(() => ({ transport: new FakeChildTransport(), kill: () => {}, onExit: (cb: () => void) => { exitCb = cb } }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {} })
    sup.start()
    expect(fork).toHaveBeenCalledTimes(1)
    exitCb?.()                       // simulate crash
    vi.advanceTimersByTime(300)      // first backoff (250ms)
    expect(fork).toHaveBeenCalledTimes(2)
    expect(sup.getDiagnosticsSnapshot().services[0].restartCount).toBe(1)
  })

  it('fails open to in-process after N failed restarts', () => {
    let exitCb: (() => void) | null = null
    const fork = vi.fn(() => ({ transport: new FakeChildTransport(), kill: () => {}, onExit: (cb: () => void) => { exitCb = cb } }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {}, maxRestarts: 2 })
    sup.start()
    for (let i = 0; i < 3; i++) { exitCb?.(); vi.advanceTimersByTime(5000) }
    expect(sup.getProxy()?.isInProcessFallback()).toBe(true)
    expect(sup.getDiagnosticsSnapshot().services[0].host).toBe('in-process-fallback')
  })

  it('does NOT restart when shutting down', () => {
    let exitCb: (() => void) | null = null
    const fork = vi.fn(() => ({ transport: new FakeChildTransport(), kill: () => {}, onExit: (cb: () => void) => { exitCb = cb } }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {} })
    sup.start(); sup.shutdown(); exitCb?.(); vi.advanceTimersByTime(5000)
    expect(fork).toHaveBeenCalledTimes(1)
  })
})
