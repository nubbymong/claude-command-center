// tests/unit/main/watchdog/watchdog-throttle-silence.test.ts
//
// Covers the #235 follow-up behaviour added on top of the ported watchdog:
//   - loop-stall-driven tick throttle (computeTickMs curve, observed via the
//     rescheduled tick delay + getMonitorSnapshot().throttle)
//   - per-session silence detection (provider stopped streaming)
//   - the services-view snapshots (getMonitorSnapshot / getDiagnosticsSnapshot)
//   - manualRestart routing
// SessionWatchdog is mocked so these exercise ONLY the manager's plumbing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const instances: any[] = []
vi.mock('../../../../src/main/watchdog/session-watchdog', () => {
  class SessionWatchdog {
    sessionId: string
    adapter: any
    config: any
    feed = vi.fn()
    tick = vi.fn()
    handleHookEvent = vi.fn()
    dispose = vi.fn()
    getState = vi.fn(() => ({
      sessionId: this.sessionId, status: 'monitoring', attempts: 0,
      overloadAttempts: 0, safeguardAttempts: 0, waitUntil: null,
      gaveUp: false, lastAction: null, updatedAt: 0,
    }))
    constructor(sessionId: string, adapter: any, config?: any) {
      this.sessionId = sessionId; this.adapter = adapter; this.config = config
      instances.push(this)
    }
  }
  return { SessionWatchdog }
})

let watchdogSettings: any = {}
vi.mock('../../../../src/main/config-manager', () => ({
  readConfig: vi.fn(() => ({ watchdog: watchdogSettings })),
}))
vi.mock('../../../../src/main/debug-logger', () => ({
  logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(),
}))
vi.mock('../../../../src/main/hooks/index', () => ({
  getGateway: () => ({ subscribe: () => vi.fn() }),
}))

const { WatchdogManager } = await import('../../../../src/main/watchdog/watchdog-manager')
const { readConfig } = await import('../../../../src/main/config-manager')

let stalls = 0
function makeHost() {
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  return {
    getWindow: () => win as any,
    isSessionAlive: () => true,
    send: vi.fn(),
    getStalls: () => stalls,
  }
}

beforeEach(() => {
  instances.length = 0
  stalls = 0
  watchdogSettings = { enabled: true }
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => { vi.useRealTimers() })

describe('watchdog throttle (loop-stall driven)', () => {
  it('keeps the base 5s tick when the main loop is calm', () => {
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    vi.advanceTimersByTime(5000) // fire one tick
    expect(m.getMonitorSnapshot().throttle.tickMs).toBe(5000)
    expect(m.getMonitorSnapshot().throttle.stallsLastMin).toBe(0)
  })

  it('widens the tick toward the 30s cap as stalls rise', () => {
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    vi.advanceTimersByTime(5000)         // tick #1 reads stalls=0
    stalls = 12                          // heavy main-loop jank
    vi.advanceTimersByTime(5000)         // tick #2 reads stalls=12
    const snap = m.getMonitorSnapshot()
    expect(snap.throttle.stallsLastMin).toBe(12)
    expect(snap.throttle.tickMs).toBe(30000) // 5000*(1+12*0.5)=35000 -> capped
  })

  it('guards a non-finite stall count so the delay stays finite (fix #6)', () => {
    const m = new WatchdogManager({ ...makeHost(), getStalls: () => NaN })
    m.startWatchdog('s1')
    vi.advanceTimersByTime(5000)
    const tickMs = m.getMonitorSnapshot().throttle.tickMs
    expect(Number.isFinite(tickMs)).toBe(true)
    expect(tickMs).toBe(5000) // NaN -> treated as 0 stalls -> base cadence
  })

  it('a throwing stall reader does not kill the shared tick (fix #5)', () => {
    watchdogSettings = { enabled: true, silenceWindowMs: 7000 }
    const m = new WatchdogManager({ ...makeHost(), getStalls: () => { throw new Error('boom') } })
    m.startWatchdog('s1')          // setup readStalls is guarded -> must not throw
    m.feedData('s1', 'x')         // lastDataAt = 0
    vi.advanceTimersByTime(5000)  // tick1: 5000<7000 not silent; readStalls throws (caught)
    vi.advanceTimersByTime(5000)  // tick2 must still fire -> silent at t=10000
    expect(m.getMonitorSnapshot().sessions[0].silent).toBe(true)
  })

  it('reads the silence window once per tick pass, not per session (fix #4)', () => {
    watchdogSettings = { enabled: true, silenceWindowMs: 1000 }
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1'); m.startWatchdog('s2'); m.startWatchdog('s3')
    ;(readConfig as unknown as { mockClear: () => void }).mockClear()
    vi.advanceTimersByTime(5000) // one tick pass over 3 sessions
    // fix: the window is read ONCE for the pass; the reverted per-session read is 3.
    expect((readConfig as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1)
  })
})

describe('watchdog silence detection', () => {
  it('marks a session silent after the silence window with no output', () => {
    watchdogSettings = { enabled: true, silenceWindowMs: 1000 }
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    m.feedData('s1', 'hello')            // lastDataAt = 0
    vi.advanceTimersByTime(5000)         // a tick fires at t=5000; 5000>1000 -> silent
    let snap = m.getMonitorSnapshot()
    expect(snap.silentSessions).toBe(1)
    expect(snap.sessions[0].silent).toBe(true)
    // Fresh output clears silence immediately.
    m.feedData('s1', 'more output')
    snap = m.getMonitorSnapshot()
    expect(snap.sessions[0].silent).toBe(false)
    expect(snap.silentSessions).toBe(0)
  })

  it('never marks silent when the window is 0 (disabled)', () => {
    watchdogSettings = { enabled: true, silenceWindowMs: 0 }
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    vi.advanceTimersByTime(60000)
    expect(m.getMonitorSnapshot().sessions[0].silent).toBe(false)
  })
})

describe('watchdog services-view snapshots', () => {
  it('reports a watchdog ServiceHealth that is listening when active, stopped when not', () => {
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    let snap = m.getDiagnosticsSnapshot()
    expect(snap.services).toHaveLength(1)
    expect(snap.services[0].id).toBe('watchdog')
    expect(snap.services[0].state).toBe('listening')
    m.disposeAll()
    snap = m.getDiagnosticsSnapshot()
    expect(snap.services[0].state).toBe('stopped')
  })

  it('counts state-change events into eventsTotal', () => {
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    // Drive a state change through the adapter the manager handed the watchdog.
    instances[0].adapter.onStateChange({ sessionId: 's1', status: 'waiting_usage', gaveUp: false, waitUntil: 1 })
    expect(m.getDiagnosticsSnapshot().services[0].eventsTotal).toBe(1)
  })

  it('routes manualRestart by id', () => {
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    expect(m.manualRestart('nope')).toEqual({ ok: false, reason: 'unknown-service' })
    expect(m.manualRestart('watchdog')).toEqual({ ok: true })
    expect(m.isActive('s1')).toBe(false) // torn down by the restart
  })
})
