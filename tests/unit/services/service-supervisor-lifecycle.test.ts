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
    const h = sup.getDiagnosticsSnapshot().services[0]
    expect(h.host).toBe('in-process-fallback')
    expect(h.state).toBe('degraded')
  })

  it('bind-failed escalates to a restart (kill -> exit -> backoff -> re-fork)', () => {
    let exitCb: (() => void) | null = null
    let curT: FakeChildTransport | null = null
    // kill() fires the stored exit callback (as a real utilityProcess does), so the
    // bind-failed handler's child.kill() drives the exit-based restart path end-to-end.
    const fork = vi.fn(() => {
      curT = new FakeChildTransport()
      return { transport: curT, kill: () => exitCb?.(), onExit: (cb: () => void) => { exitCb = cb } }
    })
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {} })
    sup.start()
    expect(fork).toHaveBeenCalledTimes(1)
    curT!.emitToParent({ type: 'bind-failed', error: 'bind-failed after 5 attempts' })
    expect(sup.getDiagnosticsSnapshot().services[0].state).toBe('crashed')
    vi.advanceTimersByTime(300)   // first backoff (250ms)
    expect(fork).toHaveBeenCalledTimes(2)   // escalation re-forked the child
    expect(sup.getDiagnosticsSnapshot().services[0].restartCount).toBe(1)
  })

  it('ignores the self-kill exit after fail-open (single fallback log, no re-entry)', () => {
    let exitCb: (() => void) | null = null
    // kill() synchronously fires the stored exit callback — the WORST case for
    // re-entry (the real utilityProcess fires it async). The fellOpen flag (set
    // before kill in activateFallback) must suppress it either way.
    const fork = vi.fn(() => ({
      transport: new FakeChildTransport(),
      kill: () => { exitCb?.() },
      onExit: (cb: () => void) => { exitCb = cb },
    }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {}, maxRestarts: 1 })
    sup.start()
    for (let i = 0; i < 2; i++) { exitCb?.(); vi.advanceTimersByTime(5000) }
    expect(sup.getProxy()?.isInProcessFallback()).toBe(true)
    const fallbackLogs = sup.getDiagnosticsSnapshot().log.filter((l) => l.code === 'fallback')
    expect(fallbackLogs).toHaveLength(1)   // the kill-triggered re-entry was ignored
  })

  it('does NOT restart when shutting down', () => {
    let exitCb: (() => void) | null = null
    const fork = vi.fn(() => ({ transport: new FakeChildTransport(), kill: () => {}, onExit: (cb: () => void) => { exitCb = cb } }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {} })
    sup.start(); sup.shutdown(); exitCb?.(); vi.advanceTimersByTime(5000)
    expect(fork).toHaveBeenCalledTimes(1)
  })

  it('shutdown() during the backoff window cancels the pending restart (no resurrection)', () => {
    let exitCb: (() => void) | null = null
    const fork = vi.fn(() => ({ transport: new FakeChildTransport(), kill: () => {}, onExit: (cb: () => void) => { exitCb = cb } }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {} })
    sup.start()
    exitCb?.()              // crash -> schedules a backoff restart
    sup.shutdown()          // races the backoff timer
    vi.advanceTimersByTime(5000)
    expect(fork).toHaveBeenCalledTimes(1)   // the pending restart was cancelled
  })

  it('manualRestart (utility mode) kills + respawns and resets counters', () => {
    let exitCb: (() => void) | null = null
    const fork = vi.fn(() => ({ transport: new FakeChildTransport(), kill: () => {}, onExit: (cb: () => void) => { exitCb = cb } }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {} })
    sup.start()
    exitCb?.(); vi.advanceTimersByTime(300)      // one crash -> restartCount 1
    expect(sup.getDiagnosticsSnapshot().services[0].restartCount).toBe(1)
    const r = sup.manualRestart('hooks')
    expect(r.ok).toBe(true)
    expect(fork).toHaveBeenCalledTimes(3)        // initial + backoff respawn + manual respawn
    expect(sup.getDiagnosticsSnapshot().services[0].restartCount).toBe(0)  // counters reset
  })

  it('manualRestart returns {ok:false, reason:"fallback"} when in in-process fallback', () => {
    let exitCb: (() => void) | null = null
    const fork = vi.fn(() => ({ transport: new FakeChildTransport(), kill: () => {}, onExit: (cb: () => void) => { exitCb = cb } }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {}, maxRestarts: 1 })
    sup.start()
    for (let i = 0; i < 2; i++) { exitCb?.(); vi.advanceTimersByTime(5000) }   // -> fallback
    expect(sup.getProxy()?.isInProcessFallback()).toBe(true)
    const forkCalls = fork.mock.calls.length
    const r = sup.manualRestart('hooks')
    expect(r).toEqual({ ok: false, reason: 'fallback' })
    expect(fork).toHaveBeenCalledTimes(forkCalls)   // no respawn in fallback
  })

  it('manualRestart returns {ok:false, reason:"shutting-down"} after shutdown', () => {
    const fork = vi.fn(() => ({ transport: new FakeChildTransport(), kill: () => {}, onExit: () => {} }))
    sup = new ServiceSupervisor({ forkChild: fork, defaultPort: 0, emit: () => {} })
    sup.start()
    sup.shutdown()
    expect(sup.manualRestart('hooks')).toEqual({ ok: false, reason: 'shutting-down' })
  })

  it('routes a child transcript-path message to onTranscriptPath (Logs v2 T8)', () => {
    let curT: FakeChildTransport | null = null
    const fork = vi.fn(() => { curT = new FakeChildTransport(); return { transport: curT, kill: () => {}, onExit: () => {} } })
    const got: Array<{ sid: string; path: string }> = []
    sup = new ServiceSupervisor({
      forkChild: fork, defaultPort: 0, emit: () => {},
      onTranscriptPath: (sid, path) => got.push({ sid, path }),
    })
    sup.start()
    curT!.emitToParent({ type: 'transcript-path', sid: 's1', path: '/home/.claude/projects/p/conv.jsonl' })
    expect(got).toEqual([{ sid: 's1', path: '/home/.claude/projects/p/conv.jsonl' }])
  })
})
