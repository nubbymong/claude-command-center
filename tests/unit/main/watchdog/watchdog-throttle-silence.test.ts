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

describe('watchdog activation grace (RC8 — a click must not wake a sleeping session)', () => {
  it('output within the grace neither clears silence nor resets the idle clock', () => {
    watchdogSettings = { enabled: true, silenceWindowMs: 1000 }
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    m.feedData('s1', 'x')                        // lastDataAt = 0
    vi.advanceTimersByTime(5000)                 // tick: silent at t=5000
    expect(m.getMonitorSnapshot().sessions[0].silent).toBe(true)
    m.noteRedrawTrigger('s1')                    // click: focus-report seen at t=5000
    m.feedData('s1', 'focus redraw bytes')       // the TUI's click response
    const s = m.getMonitorSnapshot().sessions[0]
    expect(s.silent).toBe(true)                  // moon stays
    expect(s.idleMs).toBe(5000)                  // idle clock untouched
  })

  it('output after the grace expires wakes the session normally', () => {
    watchdogSettings = { enabled: true, silenceWindowMs: 1000 }
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    m.feedData('s1', 'x')
    vi.advanceTimersByTime(5000)                 // silent
    m.noteRedrawTrigger('s1')                    // grace until t=6000
    vi.advanceTimersByTime(1500)                 // t=6500, past the grace
    m.feedData('s1', 'real work resuming')
    expect(m.getMonitorSnapshot().sessions[0].silent).toBe(false)
  })

  it('a resize arms the grace too (ConPTY repaints on resize)', () => {
    watchdogSettings = { enabled: true, silenceWindowMs: 1000 }
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    m.feedData('s1', 'x')
    vi.advanceTimersByTime(5000)                 // silent
    m.noteResize('s1', 100, 30)                  // activation resize
    m.feedData('s1', 'conpty repaint burst')
    expect(m.getMonitorSnapshot().sessions[0].silent).toBe(true)
  })

  it('a click on a not-yet-silent session does not push its moon back', () => {
    watchdogSettings = { enabled: true, silenceWindowMs: 6000 }
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    m.feedData('s1', 'x')                        // lastDataAt = 0
    vi.advanceTimersByTime(5000)                 // not yet silent (5000 < 6000)
    m.noteRedrawTrigger('s1')
    m.feedData('s1', 'click redraw')             // graced: must NOT re-stamp
    vi.advanceTimersByTime(5000)                 // t=10000: idle 10000 > 6000
    expect(m.getMonitorSnapshot().sessions[0].silent).toBe(true)
  })

  it('noteRedrawTrigger on an untracked session is a no-op', () => {
    const m = new WatchdogManager(makeHost())
    expect(() => m.noteRedrawTrigger('ghost')).not.toThrow()
  })
})

describe('watchdog monitor-mode detection (RC8 — monitor sessions never show the moon)', () => {
  it('a silent session whose footer advertises monitors reports hasMonitors', async () => {
    watchdogSettings = { enabled: true, silenceWindowMs: 1000 }
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    m.feedData('s1', 'some output\r\n⏵⏵ auto mode on · 2 monitors · ← for agents')
    // Async advance: the headless pane's write queue drains on the event loop,
    // so the sync advance would read an empty pane.
    await vi.advanceTimersByTimeAsync(5000)      // flush the pane write + flip silent
    const s = m.getMonitorSnapshot().sessions[0]
    expect(s.silent).toBe(true)
    expect(s.hasMonitors).toBe(true)
  })

  it('a silent session without the monitors footer reports hasMonitors false', async () => {
    watchdogSettings = { enabled: true, silenceWindowMs: 1000 }
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    m.feedData('s1', 'some output\r\n⏵⏵ auto mode on (shift+tab to cycle)')
    await vi.advanceTimersByTimeAsync(5000)
    const s = m.getMonitorSnapshot().sessions[0]
    expect(s.silent).toBe(true)
    expect(s.hasMonitors).toBe(false)
  })

  it('a non-silent session skips the pane read (hasMonitors false)', () => {
    watchdogSettings = { enabled: true, silenceWindowMs: 60_000 }
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    m.feedData('s1', '⏵⏵ auto mode on · 2 monitors · ← for agents')
    vi.advanceTimersByTime(5000)                 // idle 5000 < 60000: not silent
    const s = m.getMonitorSnapshot().sessions[0]
    expect(s.silent).toBe(false)
    expect(s.hasMonitors).toBe(false)
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

  it('counts state-change events into eventsTotal (the arm-time push included)', () => {
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    // startWatchdog pushes the fresh 'monitoring' state immediately (#266
    // MAJOR-4: a restart must not leave the previous run's badge painted), so
    // one event is already counted before anything is driven.
    expect(m.getDiagnosticsSnapshot().services[0].eventsTotal).toBe(1)
    // Drive a state change through the adapter the manager handed the watchdog.
    instances[0].adapter.onStateChange({ sessionId: 's1', status: 'waiting_usage', gaveUp: false, waitUntil: 1 })
    expect(m.getDiagnosticsSnapshot().services[0].eventsTotal).toBe(2)
  })

  it('routes manualRestart by id', () => {
    const m = new WatchdogManager(makeHost())
    m.startWatchdog('s1')
    expect(m.manualRestart('nope')).toEqual({ ok: false, reason: 'unknown-service' })
    expect(m.manualRestart('watchdog')).toEqual({ ok: true })
    expect(m.isActive('s1')).toBe(false) // torn down by the restart
  })
})
