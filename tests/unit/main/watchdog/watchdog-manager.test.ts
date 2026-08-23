// tests/unit/main/watchdog/watchdog-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- SessionWatchdog: fully mocked so these tests exercise ONLY the
// manager's plumbing (lifecycle, debounce, tick fan-out, hook forwarding,
// gating) — never the real detection state machine (covered by
// session-watchdog.test.ts).
interface FakeWatchdog {
  sessionId: string
  adapter: any
  config: any
  feed: ReturnType<typeof vi.fn>
  tick: ReturnType<typeof vi.fn>
  handleHookEvent: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  getState: ReturnType<typeof vi.fn>
}
const instances: FakeWatchdog[] = []
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
      sessionId: this.sessionId,
      status: 'monitoring',
      attempts: 0,
      overloadAttempts: 0,
      safeguardAttempts: 0,
      waitUntil: null,
      gaveUp: false,
      lastAction: null,
      updatedAt: 0,
    }))
    constructor(sessionId: string, adapter: any, config?: any) {
      this.sessionId = sessionId
      this.adapter = adapter
      this.config = config
      instances.push(this as unknown as FakeWatchdog)
    }
  }
  return { SessionWatchdog }
})

let watchdogSettings: any = {}
vi.mock('../../../../src/main/config-manager', () => ({
  readConfig: vi.fn(() => ({ watchdog: watchdogSettings })),
}))

vi.mock('../../../../src/main/debug-logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}))

let gatewaySubscribeImpl: ((e: any) => void) | null = null
let gatewayUnsub = vi.fn()
let gatewayReturn: any = {
  subscribe: (cb: (e: any) => void) => { gatewaySubscribeImpl = cb; return gatewayUnsub },
}
vi.mock('../../../../src/main/hooks/index', () => ({
  getGateway: () => gatewayReturn,
}))

const { WatchdogManager } = await import('../../../../src/main/watchdog/watchdog-manager')
const { IPC } = await import('../../../../src/shared/ipc-channels')

function makeHost() {
  const send = vi.fn()
  const isSessionAlive = vi.fn(() => true)
  const webContentsSend = vi.fn()
  const win = { isDestroyed: () => false, webContents: { send: webContentsSend } }
  const getWindow = vi.fn(() => win as any)
  return { host: { getWindow, isSessionAlive, send }, send, isSessionAlive, webContentsSend, getWindow }
}

beforeEach(() => {
  instances.length = 0
  watchdogSettings = { enabled: true }
  gatewaySubscribeImpl = null
  gatewayUnsub = vi.fn()
  gatewayReturn = { subscribe: (cb: (e: any) => void) => { gatewaySubscribeImpl = cb; return gatewayUnsub } }
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('WatchdogManager — default-off / gating', () => {
  it('is a no-op when watchdog.enabled is not explicitly true', () => {
    watchdogSettings = {}
    const { host } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('s1')
    expect(instances).toHaveLength(0)
    expect(mgr.isActive('s1')).toBe(false)
    expect(mgr.getStates()).toEqual([])
  })

  it('gates on session type: ssh, shellOnly, and non-claude providers never start a watchdog', () => {
    const { host } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('ssh1', { provider: 'claude', ssh: true, shellOnly: false })
    mgr.startWatchdog('shell1', { provider: 'claude', ssh: false, shellOnly: true })
    mgr.startWatchdog('codex1', { provider: 'codex', ssh: false, shellOnly: false })
    expect(instances).toHaveLength(0)
    mgr.startWatchdog('local1', { provider: 'claude', ssh: false, shellOnly: false })
    expect(instances).toHaveLength(1)
  })
})

describe('WatchdogManager — start/stop lifecycle', () => {
  it('starts exactly one SessionWatchdog per session, and stop disposes + removes it', () => {
    const { host } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('s1', { provider: 'claude' })
    expect(instances).toHaveLength(1)
    expect(mgr.isActive('s1')).toBe(true)
    expect(mgr.getStates()).toHaveLength(1)

    mgr.stopWatchdog('s1')
    expect(instances[0].dispose).toHaveBeenCalledTimes(1)
    expect(mgr.isActive('s1')).toBe(false)
    expect(mgr.getStates()).toEqual([])

    // stopping again is a safe no-op
    mgr.stopWatchdog('s1')
    expect(instances[0].dispose).toHaveBeenCalledTimes(1)
  })

  // FINDING 2 (MAJOR — stale watchdog survives same-sessionId restart): a
  // session restart kills+respawns the PTY under the SAME sessionId (see the
  // restart-race comment on pty-manager.ts's onExit). startWatchdog used to
  // early-return on `entries.has(sessionId)`, leaving the OLD SessionWatchdog
  // (with stale state/config) running and able to send() into the fresh
  // session. It must instead dispose the stale entry and build a fresh one.
  it('a second startWatchdog for an already-tracked sessionId disposes the stale instance and builds a fresh one', () => {
    const { host } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('s1', { provider: 'claude' })
    expect(instances).toHaveLength(1)
    const stale = instances[0]

    // Simulate the stale watchdog having drifted into a non-fresh state.
    stale.getState.mockReturnValue({
      sessionId: 's1',
      status: 'overload',
      attempts: 0,
      overloadAttempts: 3,
      safeguardAttempts: 0,
      waitUntil: 999,
      gaveUp: false,
      lastAction: 'stale',
      updatedAt: 0,
    })

    mgr.startWatchdog('s1', { provider: 'claude' }) // same sessionId — restart under the same id

    expect(stale.dispose).toHaveBeenCalledTimes(1) // old instance torn down
    expect(instances).toHaveLength(2) // a genuinely new instance was constructed
    const fresh = instances[1]
    expect(fresh).not.toBe(stale)
    expect(mgr.isActive('s1')).toBe(true)
    expect(mgr.getStates()).toEqual([fresh.getState()]) // manager now tracks only the fresh one

    // The old instance must not still receive ticks — the manager fans tick()
    // out over `entries`, which now only holds the fresh instance.
    vi.advanceTimersByTime(5000)
    expect(stale.tick).not.toHaveBeenCalled()
    expect(fresh.tick).toHaveBeenCalledTimes(1)
  })

  it('a restart with the feature since-disabled TEARS DOWN the stale entry (does not re-arm) (fix #1)', () => {
    const { host } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('s1', { provider: 'claude' })
    expect(instances).toHaveLength(1)

    // Feature disabled between the two starts. The teardown now runs BEFORE the
    // enabled gate, so the stale watcher is disposed and no new one is armed —
    // it must NOT be left running able to send() into the respawned session.
    watchdogSettings = {}
    mgr.startWatchdog('s1', { provider: 'claude' })
    expect(instances).toHaveLength(1)               // no fresh instance (gate fails)
    expect(instances[0].dispose).toHaveBeenCalledTimes(1) // stale one torn down
    expect(mgr.isActive('s1')).toBe(false)
  })

  it('a restart into a shell-only session tears down the claude watchdog and never sends (fix #1)', () => {
    const { host, send } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('s1', { provider: 'claude' })
    expect(mgr.isActive('s1')).toBe(true)

    // Same sessionId respawned as shell-only: ineligible -> not armed, and the
    // prior claude watchdog is torn down rather than left able to send() a retry
    // (shell-only + a custom retryMessage would be command execution).
    mgr.startWatchdog('s1', { shellOnly: true })
    expect(mgr.isActive('s1')).toBe(false)
    expect(instances[0].dispose).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5000)
    expect(send).not.toHaveBeenCalled()
  })

  it('disposeAll tears down every active watchdog and the hook subscription', () => {
    const { host } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('a', { provider: 'claude' })
    mgr.startWatchdog('b', { provider: 'claude' })
    expect(instances).toHaveLength(2)
    mgr.disposeAll()
    expect(instances[0].dispose).toHaveBeenCalledTimes(1)
    expect(instances[1].dispose).toHaveBeenCalledTimes(1)
    expect(mgr.getStates()).toEqual([])
    expect(gatewayUnsub).toHaveBeenCalledTimes(1)
  })
})

describe('WatchdogManager — feedData debounce', () => {
  it('coalesces a burst of feedData calls into exactly one feed() ~250ms after the last chunk', () => {
    const { host } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('s1', { provider: 'claude' })
    const wd = instances[0]

    mgr.feedData('s1', 'chunk1')
    vi.advanceTimersByTime(100)
    mgr.feedData('s1', 'chunk2') // resets the debounce window — feed() must not fire yet
    vi.advanceTimersByTime(100)
    expect(wd.feed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150) // 250ms since chunk2
    expect(wd.feed).toHaveBeenCalledTimes(1)
  })

  it('feedData is a no-op for a session with no running watchdog', () => {
    const { host } = makeHost()
    const mgr = new WatchdogManager(host)
    expect(() => mgr.feedData('nope', 'data')).not.toThrow()
    vi.advanceTimersByTime(1000)
    expect(instances).toHaveLength(0)
  })

  // #266 BLOCKER-1: the tail is a RENDERED PANE now, not an append-only strip
  // log. The headless terminal's write queue drains on the event loop, so
  // these tests flush timers before reading.
  it('renders ANSI instead of appending it, and caps how far back getTail reads', () => {
    const { host } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('s1', { provider: 'claude' })
    const wd = instances[0]
    mgr.feedData('s1', '\x1b[31mred\x1b[0m\r\n')
    vi.advanceTimersByTime(50)
    expect(wd.adapter.getTail()).toContain('red')
    expect(wd.adapter.getTail()).not.toContain('\x1b')

    for (let i = 0; i < 400; i++) mgr.feedData('s1', `line${i}\r\n`)
    vi.advanceTimersByTime(200)
    const tail = wd.adapter.getTail() as string
    const lines = tail.split('\n')
    // Bounded read: the 200-line window plus at most a viewport of rows.
    expect(lines.length).toBeLessThanOrEqual(260)
    expect(tail).not.toContain('line0\n')
    expect(tail).toContain('line399')
  })

  // The defect BLOCKER-1 names: Claude's TUI redraws IN PLACE (cursor moves +
  // erases, lone-\r spinner frames). The old append-only strip log kept every
  // overwritten frame — a stale "esc to interrupt" pinned isWorking() true and
  // the primary retry never fired. The rendered pane keeps only what is ON
  // SCREEN: an overwritten row is gone the moment the TUI erased it.
  it('text a redraw overwrote leaves the tail — a stale working footer cannot pin detection', () => {
    const { host } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('s1', { provider: 'claude' })
    const wd = instances[0]

    mgr.feedData('s1', 'Cogitating… (esc to interrupt)')
    vi.advanceTimersByTime(50)
    expect(wd.adapter.getTail()).toContain('esc to interrupt')

    // The turn ends: the TUI returns to column 0, erases the row, and renders
    // the limit banner in its place — exactly Ink's in-place redraw shape.
    mgr.feedData('s1', '\r\x1b[2KClaude usage limit reached. Your limit resets at 4:30pm.')
    vi.advanceTimersByTime(50)
    const tail = wd.adapter.getTail() as string
    expect(tail).toContain('usage limit reached')
    expect(tail).not.toContain('esc to interrupt')
  })

  it('lone-\\r spinner redraws overwrite one row instead of growing without bound', () => {
    const { host } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('s1', { provider: 'claude' })
    const wd = instances[0]

    for (let i = 0; i < 2_000; i++) mgr.feedData('s1', `\r\x1b[2Kspinner frame ${i}`)
    vi.advanceTimersByTime(500)

    const tail = wd.adapter.getTail() as string
    // One row of pane, not 2,000 appended frames.
    expect(tail.length).toBeLessThan(10_000)
    expect(tail).toContain('spinner frame 1999')
    expect(tail).not.toContain('spinner frame 0\r')
  })
})

describe('WatchdogManager — shared tick interval', () => {
  it('drives tick() on every active watchdog every 5s, and stops once none remain', () => {
    const { host } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('a', { provider: 'claude' })
    mgr.startWatchdog('b', { provider: 'claude' })
    const [wdA, wdB] = instances

    vi.advanceTimersByTime(5000)
    expect(wdA.tick).toHaveBeenCalledTimes(1)
    expect(wdB.tick).toHaveBeenCalledTimes(1)

    mgr.stopWatchdog('a')
    vi.advanceTimersByTime(5000)
    expect(wdA.tick).toHaveBeenCalledTimes(1) // stopped — no further ticks
    expect(wdB.tick).toHaveBeenCalledTimes(2)

    mgr.stopWatchdog('b')
    vi.advanceTimersByTime(20000)
    expect(wdB.tick).toHaveBeenCalledTimes(2) // interval cleared once the last watchdog stopped
  })
})

describe('WatchdogManager — StopFailure hook forwarding', () => {
  it('forwards a StopFailure event to the matching session, ignores unknown sessions and other events', () => {
    const { host } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('s1', { provider: 'claude' })
    const wd = instances[0]
    expect(gatewaySubscribeImpl).toBeTruthy()

    gatewaySubscribeImpl!({ sessionId: 's1', event: 'Stop', payload: {}, ts: 0 })
    expect(wd.handleHookEvent).not.toHaveBeenCalled()

    gatewaySubscribeImpl!({ sessionId: 'unknown', event: 'StopFailure', payload: { error: 'overloaded_error' }, ts: 0 })
    expect(wd.handleHookEvent).not.toHaveBeenCalled()

    gatewaySubscribeImpl!({ sessionId: 's1', event: 'StopFailure', payload: { error: 'overloaded_error' }, ts: 0 })
    expect(wd.handleHookEvent).toHaveBeenCalledWith({ event: 'StopFailure', error: 'overloaded' })
  })

  it('maps a 5xx-flavoured error to server_error and an unrecognised one to undefined', () => {
    const { host } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('s1', { provider: 'claude' })
    const wd = instances[0]

    gatewaySubscribeImpl!({ sessionId: 's1', event: 'StopFailure', payload: { error: 'API Error: 529' }, ts: 0 })
    expect(wd.handleHookEvent).toHaveBeenLastCalledWith({ event: 'StopFailure', error: 'server_error' })

    gatewaySubscribeImpl!({ sessionId: 's1', event: 'StopFailure', payload: { reason: 'auth_failed' }, ts: 0 })
    expect(wd.handleHookEvent).toHaveBeenLastCalledWith({ event: 'StopFailure', error: undefined })
  })
})

describe('WatchdogManager — adapter wiring', () => {
  it('adapter.send/isSessionAlive delegate to the host, scoped to the session id', () => {
    const { host, send, isSessionAlive } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('s1', { provider: 'claude' })
    const wd = instances[0]

    wd.adapter.send('continue')
    expect(send).toHaveBeenCalledWith('s1', 'continue')

    wd.adapter.isSessionAlive()
    expect(isSessionAlive).toHaveBeenCalledWith('s1')
  })

  it('adapter.onStateChange pushes IPC.WATCHDOG_STATE to the current window', () => {
    const { host, webContentsSend } = makeHost()
    const mgr = new WatchdogManager(host)
    mgr.startWatchdog('s1', { provider: 'claude' })
    const wd = instances[0]

    const state = { sessionId: 's1', status: 'waiting', attempts: 1, overloadAttempts: 0, safeguardAttempts: 0, waitUntil: 123, gaveUp: false, lastAction: 'x', updatedAt: 1 }
    wd.adapter.onStateChange(state)
    expect(webContentsSend).toHaveBeenCalledWith(IPC.WATCHDOG_STATE, state)
  })

  it('never touches the window when it is destroyed', () => {
    const send = vi.fn()
    const isSessionAlive = vi.fn(() => true)
    const webContentsSend = vi.fn()
    const win = { isDestroyed: () => true, webContents: { send: webContentsSend } }
    const getWindow = vi.fn(() => win as any)
    const mgr = new WatchdogManager({ getWindow, isSessionAlive, send })
    mgr.startWatchdog('s1', { provider: 'claude' })
    const wd = instances[0]
    wd.adapter.onStateChange({ sessionId: 's1' } as any)
    expect(webContentsSend).not.toHaveBeenCalled()
  })
})
