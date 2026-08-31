import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock both sibling modules per the task brief — these tests must be
// independent of ./patterns and ./time-parser's actual implementations.
vi.mock('../../../../src/main/watchdog/patterns', () => ({
  isRateLimited: vi.fn(),
  findRateLimitMessage: vi.fn(),
  detectOverload: vi.fn(),
  detectSafeguard: vi.fn(),
  isWorking: vi.fn(),
  isInternalRetry: vi.fn(),
  resumedAfterLimit: vi.fn(),
  canSendNow: vi.fn(),
  hasClaudeInputChrome: vi.fn(),
}))
vi.mock('../../../../src/main/watchdog/time-parser', () => ({
  parseResetTime: vi.fn(),
  calculateWaitMs: vi.fn(),
}))

import * as patterns from '../../../../src/main/watchdog/patterns'
import * as timeParser from '../../../../src/main/watchdog/time-parser'
import { SessionWatchdog } from '../../../../src/main/watchdog/session-watchdog'
import type { WatchdogAdapter, WatchdogPublicState } from '../../../../src/main/watchdog/session-watchdog'

const isRateLimited = vi.mocked(patterns.isRateLimited)
const findRateLimitMessage = vi.mocked(patterns.findRateLimitMessage)
const detectOverload = vi.mocked(patterns.detectOverload)
const detectSafeguard = vi.mocked(patterns.detectSafeguard)
const isWorking = vi.mocked(patterns.isWorking)
const isInternalRetry = vi.mocked(patterns.isInternalRetry)
const resumedAfterLimit = vi.mocked(patterns.resumedAfterLimit)
const canSendNow = vi.mocked(patterns.canSendNow)
const hasClaudeInputChrome = vi.mocked(patterns.hasClaudeInputChrome)
const parseResetTime = vi.mocked(timeParser.parseResetTime)
const calculateWaitMs = vi.mocked(timeParser.calculateWaitMs)

function makeAdapter(opts: { requireClaudeChrome?: boolean } = {}) {
  let currentNow = 0
  let tail = ''
  let alive = true
  const sent: string[] = []
  const logs: { level: string; msg: string }[] = []
  const stateChanges: WatchdogPublicState[] = []
  const adapter: WatchdogAdapter = {
    getTail: () => tail,
    isSessionAlive: () => alive,
    requireClaudeChrome: opts.requireClaudeChrome,
    send: (text: string) => sent.push(text),
    now: () => currentNow,
    log: (level, msg) => logs.push({ level, msg }),
    onStateChange: (s) => stateChanges.push(s),
  }
  return {
    adapter,
    sent,
    logs,
    stateChanges,
    setNow: (n: number) => { currentNow = n },
    advance: (ms: number) => { currentNow += ms },
    setTail: (t: string) => { tail = t },
    setAlive: (a: boolean) => { alive = a },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  isRateLimited.mockReturnValue(false)
  detectOverload.mockReturnValue(false)
  detectSafeguard.mockReturnValue(false)
  isWorking.mockReturnValue(false)
  isInternalRetry.mockReturnValue(false)
  resumedAfterLimit.mockReturnValue(false)
  canSendNow.mockReturnValue({ ok: true })
  hasClaudeInputChrome.mockReturnValue(true)
  findRateLimitMessage.mockReturnValue(null)
  parseResetTime.mockReturnValue(null)
  calculateWaitMs.mockReturnValue(3_600_000)
})

const noJitterRand = () => 0.5 // factor = 1 + (0.5*2-1)*pct/100 = 1 -> exact backoff seconds

describe('SessionWatchdog — rate-limit (waiting) path', () => {
  it('full happy path: detect -> wait -> fire retry once expired', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter)

    isRateLimited.mockReturnValue(true)
    isWorking.mockReturnValue(false)
    findRateLimitMessage.mockReturnValue('resets 3pm')
    calculateWaitMs.mockReturnValue(60_000)

    t.setTail('You have hit your limit, resets 3pm')
    wd.feed()

    let s = wd.getState()
    expect(s.status).toBe('waiting')
    expect(s.waitUntil).toBe(60_000)
    expect(t.sent).toHaveLength(0)

    // Not yet expired.
    t.setNow(59_000)
    wd.tick()
    expect(t.sent).toHaveLength(0)

    // Expired, still rate-limited, not working, session alive -> fires.
    t.setNow(60_001)
    wd.tick()
    expect(t.sent).toEqual(['continue'])
    s = wd.getState()
    expect(s.status).toBe('waiting')
    expect(s.attempts).toBe(1)
    // Invariant: send is preceded by an info log line.
    const sendIdx = t.logs.findLastIndex((l) => l.msg.includes('Sending retry after rate limit reset'))
    expect(sendIdx).toBeGreaterThanOrEqual(0)
    expect(t.logs[sendIdx].level).toBe('info')
  })

  it('user-continued path: resumedAfterLimit clears waiting and resets attempts', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter)

    isRateLimited.mockReturnValue(true)
    findRateLimitMessage.mockReturnValue('resets 3pm')
    calculateWaitMs.mockReturnValue(60_000)
    t.setTail('limit banner')
    wd.feed()
    expect(wd.getState().status).toBe('waiting')

    resumedAfterLimit.mockReturnValue(true)
    t.setTail('user kept working past the banner')
    wd.feed()

    const s = wd.getState()
    expect(s.status).toBe('monitoring')
    expect(s.attempts).toBe(0)
    expect(s.gaveUp).toBe(false)
  })

  it('max-retries reached -> gaveUp, extended wait, logs the warning exactly once (no tight loop)', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, { maxRetries: 1 })

    isRateLimited.mockReturnValue(true)
    findRateLimitMessage.mockReturnValue('resets 3pm')
    calculateWaitMs.mockReturnValue(1_000)
    t.setTail('limit banner')
    wd.feed()

    t.setNow(1_001)
    wd.tick() // attempt 1 sent
    expect(t.sent).toHaveLength(1)
    expect(wd.getState().attempts).toBe(1)

    // Still rate-limited on the next expiry: attempts(1) >= maxRetries(1) -> give up.
    t.advance(31_000)
    wd.tick()
    let s = wd.getState()
    expect(s.gaveUp).toBe(true)
    expect(t.sent).toHaveLength(1) // no further send
    const warnCount1 = t.logs.filter((l) => l.level === 'warn' && l.msg.includes('Max retries')).length
    expect(warnCount1).toBe(1)

    // Advance well past the extended wait and tick again — must not re-fire the
    // warning or send again (no tight loop).
    t.advance(10 * 60_000)
    wd.tick()
    s = wd.getState()
    expect(s.gaveUp).toBe(true)
    expect(t.sent).toHaveLength(1)
    const warnCount2 = t.logs.filter((l) => l.level === 'warn' && l.msg.includes('Max retries')).length
    expect(warnCount2).toBe(1)
  })
})

describe('SessionWatchdog — overload path', () => {
  it('backoff progression follows backoffSeconds then steady state, with jitter bounds respected', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, undefined, noJitterRand)

    detectOverload.mockReturnValue(true)
    isInternalRetry.mockReturnValue(false)
    t.setTail('API Error: 529 Overloaded')
    wd.feed()

    let s = wd.getState()
    expect(s.status).toBe('overload')
    expect(s.waitUntil).toBe(30_000) // backoffSeconds[0]

    const expected = [60_000, 120_000, 240_000, 300_000, 300_000] // [1..4] then steady state
    let cumulative = 30_000
    for (const nextWait of expected) {
      t.setNow((s.waitUntil as number) + 1)
      wd.tick()
      s = wd.getState()
      cumulative += nextWait
      expect(s.waitUntil).toBe(t.adapter.now() + nextWait)
    }
    expect(s.overloadAttempts).toBe(5)
  })

  it('jitter stays within +/-jitterPct of the base backoff', () => {
    const t = makeAdapter()
    const highRand = () => 1 // factor = 1 + jitterPct/100 (max up)
    const lowRand = () => 0 // factor = 1 - jitterPct/100 (max down)

    for (const rand of [highRand, lowRand]) {
      const wd = new SessionWatchdog('s1', t.adapter, undefined, rand)
      detectOverload.mockReturnValue(true)
      t.setTail('API Error: 529 Overloaded')
      t.setNow(0)
      wd.feed()
      const w = wd.getState().waitUntil as number
      // base 30_000, jitterPct 15 -> bounds [25_500, 34_500]
      expect(w).toBeGreaterThanOrEqual(25_500)
      expect(w).toBeLessThanOrEqual(34_500)
    }
  })

  it('cumulative wait is capped by maxTotalWaitMinutes; gives up loudly exactly once', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog(
      's1',
      t.adapter,
      { overload: { maxTotalWaitMinutes: 1 } }, // 60_000ms cap; first backoff (30s) alone won't trip it
      noJitterRand,
    )
    detectOverload.mockReturnValue(true)
    t.setTail('API Error: 529 Overloaded')
    wd.feed()
    expect(wd.getState().waitUntil).toBe(30_000) // under the cap, entered normally

    // Fire once (overloadTotalWaitMs becomes 30_000 + 60_000 = 90_000 >= 60_000 cap next check)
    t.setNow(30_001)
    wd.tick()
    expect(t.sent).toHaveLength(1)

    // Next expiry: cumulative wait already exceeds the cap -> give up, no send.
    t.setNow((wd.getState().waitUntil as number) + 1)
    wd.tick()
    let s = wd.getState()
    expect(s.gaveUp).toBe(true)
    expect(t.sent).toHaveLength(1)
    expect(t.logs.filter((l) => l.level === 'warn' && l.msg.includes('cap reached')).length).toBe(1)

    // Ticking again after the give-up cooldown must not re-log or re-send.
    t.advance(10 * 60_000)
    wd.tick()
    s = wd.getState()
    expect(t.sent).toHaveLength(1)
    expect(t.logs.filter((l) => l.level === 'warn' && l.msg.includes('cap reached')).length).toBe(1)
  })

  it('recovery (isWorking without isInternalRetry) resets the overload budget', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, undefined, noJitterRand)
    detectOverload.mockReturnValue(true)
    t.setTail('API Error: 529 Overloaded')
    wd.feed()
    t.setNow(30_001)
    wd.tick()
    expect(wd.getState().overloadAttempts).toBe(1)

    isWorking.mockReturnValue(true)
    isInternalRetry.mockReturnValue(false)
    t.setTail('some fresh streaming output')
    wd.feed()

    const s = wd.getState()
    expect(s.status).toBe('monitoring')
    expect(s.overloadAttempts).toBe(0)
    expect(s.gaveUp).toBe(false)
  })

  it('does not double-fire on the same still-visible banner (memo)', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, undefined, noJitterRand)
    detectOverload.mockReturnValue(true)
    const banner = 'API Error: 529 Overloaded'
    t.setTail(banner)
    wd.feed()
    t.setNow(30_001)
    wd.tick() // sends once, memoizes `banner` as handled
    expect(t.sent).toHaveLength(1)

    // Simulate recovery back to monitoring while the exact same banner text is
    // still technically present (isWorking flips true, non-internal-retry).
    isWorking.mockReturnValue(true)
    wd.feed() // -> monitoring, memo preserved
    expect(wd.getState().status).toBe('monitoring')

    // Same tail re-observed: must NOT re-enter overload (memo match).
    isWorking.mockReturnValue(false)
    wd.feed()
    expect(wd.getState().status).toBe('monitoring')
    expect(t.sent).toHaveLength(1)

    // A genuinely different render (banner text changed) is a fresh incident.
    t.setTail('API Error: 500 Internal server error')
    wd.feed()
    expect(wd.getState().status).toBe('overload')
  })
})

describe('SessionWatchdog — safeguard path', () => {
  it('retries up to maxRetries at the fixed delay, then latches give-up (logged once)', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, { safeguard: { maxRetries: 2, retryDelaySeconds: 8 } })
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.feed()
    expect(wd.getState().status).toBe('safeguard')
    expect(wd.getState().waitUntil).toBe(8_000)

    t.setNow(8_001)
    wd.tick()
    expect(t.sent).toEqual(['continue'])
    expect(wd.getState().safeguardAttempts).toBe(1)

    t.setNow(16_002)
    wd.tick()
    expect(t.sent).toHaveLength(2)
    expect(wd.getState().safeguardAttempts).toBe(2)

    // Third expiry: attempts(2) >= maxRetries(2) -> give up, no further send.
    t.setNow(24_003)
    wd.tick()
    let s = wd.getState()
    expect(s.gaveUp).toBe(true)
    expect(t.sent).toHaveLength(2)
    expect(t.logs.filter((l) => l.msg.includes('Giving up until it clears')).length).toBe(1)

    t.advance(10 * 60_000)
    wd.tick()
    s = wd.getState()
    expect(t.sent).toHaveLength(2)
    expect(t.logs.filter((l) => l.msg.includes('Giving up until it clears')).length).toBe(1)
  })

  it('clears when the flag disappears from the tail', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter)
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.feed()
    expect(wd.getState().status).toBe('safeguard')

    detectSafeguard.mockReturnValue(false)
    t.setTail('normal output now')
    wd.feed()
    expect(wd.getState().status).toBe('monitoring')
  })
})

describe('SessionWatchdog — safety invariants', () => {
  it('never sends when isSessionAlive() is false (waiting)', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter)
    isRateLimited.mockReturnValue(true)
    calculateWaitMs.mockReturnValue(1_000)
    t.setTail('limit')
    wd.feed()
    t.setAlive(false)
    t.setNow(1_001)
    wd.tick()
    expect(t.sent).toHaveLength(0)
  })

  it('never sends when isSessionAlive() is false (overload)', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, undefined, noJitterRand)
    detectOverload.mockReturnValue(true)
    t.setTail('API Error: 529 Overloaded')
    wd.feed()
    t.setAlive(false)
    t.setNow(30_001)
    wd.tick()
    expect(t.sent).toHaveLength(0)
  })

  it('never sends when isSessionAlive() is false (safeguard)', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter)
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.feed()
    t.setAlive(false)
    t.setNow(8_001)
    wd.tick()
    expect(t.sent).toHaveLength(0)
  })

  it('never sends when the triggering condition is no longer present at fire time (waiting)', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter)
    isRateLimited.mockReturnValue(true)
    calculateWaitMs.mockReturnValue(1_000)
    t.setTail('limit')
    wd.feed()

    isRateLimited.mockReturnValue(false) // cleared before the wait elapsed
    t.setNow(1_001)
    wd.tick()
    expect(t.sent).toHaveLength(0)
    expect(wd.getState().status).toBe('monitoring')
  })

  it('never sends while isWorking indicates activity (waiting)', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter)
    isRateLimited.mockReturnValue(true)
    calculateWaitMs.mockReturnValue(1_000)
    t.setTail('limit')
    wd.feed()

    isWorking.mockReturnValue(true)
    t.setNow(1_001)
    wd.tick()
    expect(t.sent).toHaveLength(0)
    expect(wd.getState().status).toBe('waiting') // deferred, not cleared
  })

  it('never sends while isInternalRetry indicates activity (overload)', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, undefined, noJitterRand)
    detectOverload.mockReturnValue(true)
    t.setTail('API Error: 529 Overloaded')
    wd.feed()

    isInternalRetry.mockReturnValue(true)
    t.setNow(30_001)
    wd.tick()
    expect(t.sent).toHaveLength(0)
    expect(wd.getState().status).toBe('overload')
  })

  it('every send() is preceded by an adapter.log info line (overload)', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, undefined, noJitterRand)
    detectOverload.mockReturnValue(true)
    t.setTail('API Error: 529 Overloaded')
    wd.feed()
    t.setNow(30_001)
    wd.tick()
    const sendLogIdx = t.logs.findIndex((l) => l.msg.includes('Sending overload retry'))
    expect(sendLogIdx).toBeGreaterThanOrEqual(0)
    expect(t.logs[sendLogIdx].level).toBe('info')
  })

  it('every state transition calls onStateChange', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter)
    expect(t.stateChanges).toHaveLength(0)

    isRateLimited.mockReturnValue(true)
    calculateWaitMs.mockReturnValue(1_000)
    t.setTail('limit')
    wd.feed()
    expect(t.stateChanges.length).toBeGreaterThan(0)
    expect(t.stateChanges.at(-1)?.status).toBe('waiting')
  })
})

describe('SessionWatchdog — handleHookEvent fast path', () => {
  it('treats error="overloaded" as an overload incident', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, undefined, noJitterRand)
    t.setTail('')
    wd.handleHookEvent({ event: 'StopFailure', error: 'overloaded' })
    expect(wd.getState().status).toBe('overload')
  })

  it('treats error="server_error" as an overload incident', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, undefined, noJitterRand)
    t.setTail('')
    wd.handleHookEvent({ event: 'StopFailure', error: 'server_error' })
    expect(wd.getState().status).toBe('overload')
  })

  it('ignores other error types', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter)
    t.setTail('')
    wd.handleHookEvent({ event: 'StopFailure', error: 'rate_limit' })
    expect(wd.getState().status).toBe('monitoring')
    expect(t.stateChanges).toHaveLength(0)

    wd.handleHookEvent({ event: 'StopFailure' })
    expect(wd.getState().status).toBe('monitoring')
    expect(t.stateChanges).toHaveLength(0)
  })

  it('does not start an incident if the session already self-recovered', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter)
    isWorking.mockReturnValue(true)
    isInternalRetry.mockReturnValue(false)
    t.setTail('fresh streaming output')
    wd.handleHookEvent({ event: 'StopFailure', error: 'overloaded' })
    expect(wd.getState().status).toBe('monitoring')
  })

  it('fires exactly once per hook event, then tick() sends after the scheduled backoff', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, undefined, noJitterRand)
    wd.handleHookEvent({ event: 'StopFailure', error: 'overloaded' })
    expect(t.sent).toHaveLength(0) // no send yet, only scheduled

    t.setNow((wd.getState().waitUntil as number) + 1)
    wd.tick()
    expect(t.sent).toEqual(['continue'])
  })

  // FINDING 3 (MAJOR): the event path skipped the fire-time re-verify, so a
  // session that recovered SILENTLY during the backoff (no banner, no working
  // marker) still got a spurious `continue`. Re-verify against the tail snapshot.
  it('event path does NOT send when the tail advanced during the backoff (fix #3)', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, undefined, noJitterRand)
    t.setTail('turn failed — overload')
    wd.handleHookEvent({ event: 'StopFailure', error: 'overloaded' })
    expect(t.sent).toHaveLength(0)
    // Silent recovery: tail moved on, but no working/limit/overload signal.
    t.setTail('a different idle prompt now')
    t.setNow((wd.getState().waitUntil as number) + 1)
    wd.tick()
    expect(t.sent).toHaveLength(0)
    expect(wd.getState().status).toBe('monitoring')
  })

  it('event path still sends when the tail is unchanged at fire time (fix #3 guard)', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, undefined, noJitterRand)
    t.setTail('turn failed — overload')
    wd.handleHookEvent({ event: 'StopFailure', error: 'overloaded' })
    t.setNow((wd.getState().waitUntil as number) + 1)
    wd.tick() // tail unchanged since the event
    expect(t.sent).toEqual(['continue'])
  })

  // FINDING 4 (MAJOR — handleHookEvent clobbers a latched gaveUp / active
  // waiting): a StopFailure hook must never override an active usage-limit
  // wait, nor resurrect a latched give-up. Only 'monitoring', or an existing
  // non-given-up 'overload', may (re)enter/escalate overload from the hook.
  it('ignores a StopFailure while status=waiting with gaveUp=true (a real usage-limit wait outranks a transient overload)', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, { maxRetries: 1 })
    isRateLimited.mockReturnValue(true)
    findRateLimitMessage.mockReturnValue('resets 3pm')
    calculateWaitMs.mockReturnValue(1_000)
    t.setTail('limit banner')
    wd.feed() // -> waiting

    t.setNow(1_001)
    wd.tick() // attempt 1 sent (attempts 0 < maxRetries 1)
    t.advance(31_000)
    wd.tick() // attempts(1) >= maxRetries(1) -> gives up: waiting + gaveUp=true
    const before = wd.getState()
    expect(before.status).toBe('waiting')
    expect(before.gaveUp).toBe(true)

    const stateChangesBefore = t.stateChanges.length
    wd.handleHookEvent({ event: 'StopFailure', error: 'overloaded' })

    const after = wd.getState()
    expect(after.status).toBe('waiting') // NOT hijacked into 'overload'
    expect(after.gaveUp).toBe(true)
    expect(after.waitUntil).toBe(before.waitUntil) // untouched
    expect(t.stateChanges.length).toBe(stateChangesBefore) // no state change emitted
    expect(t.logs.some((l) => l.msg.includes('ignored'))).toBe(true)
  })

  it('ignores a StopFailure while status=safeguard with gaveUp=true (does not resurrect a given-up safeguard into fresh overload)', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, { safeguard: { maxRetries: 1, retryDelaySeconds: 8 } })
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.feed() // -> safeguard

    t.setNow(8_001)
    wd.tick() // attempt 1 sent (attempts 0 < maxRetries 1)
    t.advance(9_000)
    wd.tick() // attempts(1) >= maxRetries(1) -> gives up
    const before = wd.getState()
    expect(before.status).toBe('safeguard')
    expect(before.gaveUp).toBe(true)

    wd.handleHookEvent({ event: 'StopFailure', error: 'server_error' })

    const after = wd.getState()
    expect(after.status).toBe('safeguard') // NOT hijacked into 'overload'
    expect(after.gaveUp).toBe(true)
    expect(after.overloadAttempts).toBe(0) // no overload incident started
  })

  it('still enters overload from monitoring (existing behavior preserved)', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, undefined, noJitterRand)
    expect(wd.getState().status).toBe('monitoring')

    wd.handleHookEvent({ event: 'StopFailure', error: 'overloaded' })

    expect(wd.getState().status).toBe('overload')
  })
})

// FINDING 5 (coverage — overload/safeguard fire-time re-verify untested): the
// tick*() methods already re-check the triggering condition at fire time
// (tickOverload/tickSafeguard) before sending; these tests exercise that path
// explicitly for both sub-states.
describe('SessionWatchdog — fire-time re-verification (overload/safeguard)', () => {
  it('overload: banner detected at feed(), gone by tick() fire time -> returns to monitoring, no send', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, undefined, noJitterRand)
    detectOverload.mockReturnValue(true)
    t.setTail('API Error: 529 Overloaded')
    wd.feed()
    expect(wd.getState().status).toBe('overload')

    // Banner cleared before the backoff expired; not working, no internal retry.
    detectOverload.mockReturnValue(false)
    isWorking.mockReturnValue(false)
    isInternalRetry.mockReturnValue(false)
    t.setTail('normal output now')
    t.setNow((wd.getState().waitUntil as number) + 1)
    wd.tick()

    const s = wd.getState()
    expect(s.status).toBe('monitoring')
    expect(t.sent).toHaveLength(0)
  })

  it('safeguard: flag detected at feed(), gone by tick() fire time -> returns to monitoring, no send', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter)
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.feed()
    expect(wd.getState().status).toBe('safeguard')

    detectSafeguard.mockReturnValue(false)
    isWorking.mockReturnValue(false)
    t.setTail('normal output now')
    t.setNow((wd.getState().waitUntil as number) + 1)
    wd.tick()

    const s = wd.getState()
    expect(s.status).toBe('monitoring')
    expect(t.sent).toHaveLength(0)
  })

  it('safeguard: isWorking mid-retry defer does NOT reset/consume safeguardAttempts', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, { safeguard: { maxRetries: 3, retryDelaySeconds: 8 } })
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.feed()

    t.setNow(8_001)
    wd.tick() // attempt 1 fires
    expect(t.sent).toHaveLength(1)
    expect(wd.getState().safeguardAttempts).toBe(1)

    // Next expiry lands while the retry is in flight (isWorking true) — must
    // defer WITHOUT touching safeguardAttempts (neither reset nor incremented).
    isWorking.mockReturnValue(true)
    t.setNow(16_002)
    wd.tick()
    expect(t.sent).toHaveLength(1) // no second send while deferred
    expect(wd.getState().safeguardAttempts).toBe(1) // untouched, not reset to 0

    // Work finishes, flag still present -> next expiry actually fires attempt 2.
    isWorking.mockReturnValue(false)
    t.setNow((wd.getState().waitUntil as number) + 1)
    wd.tick()
    expect(t.sent).toHaveLength(2)
    expect(wd.getState().safeguardAttempts).toBe(2) // incremented from 1, not from a reset 0
  })
})

describe('the send gate (#266 BLOCKER-2 / MAJOR-3) — no automated line into a menu or a draft', () => {
  function armWaiting(t: ReturnType<typeof makeAdapter>) {
    const wd = new SessionWatchdog('s1', t.adapter)
    isRateLimited.mockReturnValue(true)
    findRateLimitMessage.mockReturnValue('resets 3pm')
    calculateWaitMs.mockReturnValue(60_000)
    t.setTail('You have hit your limit, resets 3pm')
    wd.feed()
    return wd
  }

  it('waiting: an open menu defers the retry — nothing sent, NO attempt consumed', () => {
    const t = makeAdapter()
    const wd = armWaiting(t)
    canSendNow.mockReturnValue({ ok: false, reason: 'menu' })

    t.setNow(60_001)
    wd.tick()
    expect(t.sent).toHaveLength(0)
    expect(wd.getState().attempts).toBe(0)
    // Deferred, not dead: the wait was pushed out and the deferral logged.
    expect(wd.getState().waitUntil).toBe(60_001 + 30_000)
    expect(t.logs.some((l) => l.level === 'info' && /deferred/i.test(l.msg) && /menu/i.test(l.msg))).toBe(true)

    // The menu resolves; the next expiry fires normally.
    canSendNow.mockReturnValue({ ok: true })
    t.setNow(60_001 + 30_001)
    wd.tick()
    expect(t.sent).toEqual(['continue'])
    expect(wd.getState().attempts).toBe(1)
  })

  it("waiting: the user's draft defers the retry the same way", () => {
    const t = makeAdapter()
    const wd = armWaiting(t)
    canSendNow.mockReturnValue({ ok: false, reason: 'draft' })
    t.setNow(60_001)
    wd.tick()
    expect(t.sent).toHaveLength(0)
    expect(wd.getState().attempts).toBe(0)
    expect(t.logs.some((l) => /draft/i.test(l.msg))).toBe(true)
  })

  it('overload: a refused send consumes neither an attempt nor cumulative budget', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter, undefined, noJitterRand)
    detectOverload.mockReturnValue(true)
    t.setTail('API Error: overloaded')
    wd.feed()
    const armed = wd.getState()
    expect(armed.status).toBe('overload')

    canSendNow.mockReturnValue({ ok: false, reason: 'menu' })
    t.setNow((armed.waitUntil as number) + 1)
    wd.tick()
    expect(t.sent).toHaveLength(0)
    expect(wd.getState().overloadAttempts).toBe(0)

    canSendNow.mockReturnValue({ ok: true })
    t.setNow((wd.getState().waitUntil as number) + 1)
    wd.tick()
    expect(t.sent).toHaveLength(1)
    expect(wd.getState().overloadAttempts).toBe(1)
  })

  it('safeguard: a refused send consumes no attempt', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s1', t.adapter)
    detectSafeguard.mockReturnValue(true)
    t.setTail('flagged for potential policy violation')
    wd.feed()

    canSendNow.mockReturnValue({ ok: false, reason: 'draft' })
    t.setNow((wd.getState().waitUntil as number) + 1)
    wd.tick()
    expect(t.sent).toHaveLength(0)
    expect(wd.getState().safeguardAttempts).toBe(0)
  })
})

// Adversarial pass (2026-08-31): over SSH the pane is drawn by a REMOTE host and
// may be a shell, pager, REPL, or auth/confirm prompt — none of which canSendNow
// (a denylist of Claude chrome) refuses. An SSH watchdog (requireClaudeChrome)
// must require positive Claude input chrome before it types, and must read the
// gate RAW (the dim companion is remote-controlled). These pin BLOCKER-2 and
// MAJOR-2 (claude-exited-to-shell).
describe('SessionWatchdog — SSH send hardening (requireClaudeChrome)', () => {
  function drivenToDue(t: ReturnType<typeof makeAdapter>, wd: SessionWatchdog) {
    isRateLimited.mockReturnValue(true)
    isWorking.mockReturnValue(false)
    findRateLimitMessage.mockReturnValue('resets 3pm')
    calculateWaitMs.mockReturnValue(60_000)
    t.setTail('You have hit your limit, resets 3pm')
    wd.feed()
    t.setNow(60_001)
  }

  it('does NOT send when the remote pane shows no Claude chrome (a bare shell / auth prompt), even though the retry is due', () => {
    const t = makeAdapter({ requireClaudeChrome: true })
    const wd = new SessionWatchdog('ssh1', t.adapter)
    hasClaudeInputChrome.mockReturnValue(false) // e.g. "nicholas@rocky:~$ "
    drivenToDue(t, wd)
    wd.tick()
    expect(t.sent).toHaveLength(0)
    expect(wd.getState().attempts).toBe(0) // deferred, no attempt consumed
    expect(t.logs.some((l) => l.msg.includes('not showing Claude'))).toBe(true)
  })

  it('DOES send when Claude chrome is present and the pane is sendable', () => {
    const t = makeAdapter({ requireClaudeChrome: true })
    const wd = new SessionWatchdog('ssh1', t.adapter)
    hasClaudeInputChrome.mockReturnValue(true)
    canSendNow.mockReturnValue({ ok: true })
    drivenToDue(t, wd)
    wd.tick()
    expect(t.sent).toEqual(['continue'])
    // The SSH precondition was actually consulted (not sent via the local path).
    expect(hasClaudeInputChrome).toHaveBeenCalled()
  })

  it('reads the gate RAW over SSH — canSendNow is called WITHOUT the remote-controlled non-dim companion', () => {
    const t = makeAdapter({ requireClaudeChrome: true })
    const wd = new SessionWatchdog('ssh1', t.adapter)
    hasClaudeInputChrome.mockReturnValue(true)
    drivenToDue(t, wd)
    wd.tick()
    // Every canSendNow call in the SSH path passes exactly one argument.
    expect(canSendNow.mock.calls.every((c) => c.length === 1)).toBe(true)
  })

  it('a local session is unchanged: no chrome precondition, non-dim companion still used', () => {
    const t = makeAdapter() // requireClaudeChrome undefined
    const wd = new SessionWatchdog('local1', t.adapter)
    hasClaudeInputChrome.mockReturnValue(false) // must be IGNORED for local
    drivenToDue(t, wd)
    wd.tick()
    expect(t.sent).toEqual(['continue'])
    expect(hasClaudeInputChrome).not.toHaveBeenCalled()
  })
})
