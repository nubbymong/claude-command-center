// #605: the three auto-retry checks are switchable PER SESSION at runtime.
// Each check gates both its detection and its send. The silence/sleep indicator
// is not covered here: it lives in WatchdogManager, is status-only and never
// sends, so it is never gated. Same mocking discipline as
// session-watchdog.test.ts -- ./patterns and ./time-parser are stubbed so these
// assert the state machine, not the detectors.
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

function makeAdapter() {
  let currentNow = 0
  let tail = ''
  const sent: string[] = []
  const stateChanges: WatchdogPublicState[] = []
  const adapter: WatchdogAdapter = {
    getTail: () => tail,
    isSessionAlive: () => true,
    send: (text: string) => sent.push(text),
    now: () => currentNow,
    log: () => {},
    onStateChange: (s) => stateChanges.push(s),
  }
  return {
    adapter, sent, stateChanges,
    advance: (ms: number) => { currentNow += ms },
    setTail: (t: string) => { tail = t },
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
  findRateLimitMessage.mockReturnValue('resets 3pm')
  parseResetTime.mockReturnValue(null)
  calculateWaitMs.mockReturnValue(60_000)
})

/** Drive a session into the waiting state. */
function intoWaiting() {
  const t = makeAdapter()
  const wd = new SessionWatchdog('s', t.adapter)
  isRateLimited.mockReturnValue(true)
  t.setTail('limit reached, resets 3pm')
  wd.feed()
  expect(wd.getState().status).toBe('waiting')
  return { t, wd }
}

describe('#605 checks are published and seeded from the config', () => {
  it('all three are on by default', () => {
    const t = makeAdapter()
    expect(new SessionWatchdog('s', t.adapter).getState().checks)
      .toEqual({ rateLimit: true, overload: true, safeguard: true })
  })

  it('a globally-disabled check starts off for the session', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, {
      rateLimitEnabled: false,
      overload: { enabled: false } as never,
    })
    expect(wd.getState().checks).toEqual({ rateLimit: false, overload: false, safeguard: true })
  })
})

describe('#605 a disabled check neither detects nor sends', () => {
  it('rate limit: no wait is entered and nothing is typed', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, { rateLimitEnabled: false })
    isRateLimited.mockReturnValue(true)
    t.setTail('limit reached, resets 3pm')
    wd.feed()
    expect(wd.getState().status).toBe('monitoring')
    t.advance(10_000_000)
    wd.tick()
    expect(t.sent, 'a muted rate-limit check must never type').toEqual([])
  })

  it('overload: no incident is opened and nothing is typed', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, { overload: { enabled: false } as never })
    detectOverload.mockReturnValue(true)
    t.setTail('API Error: 529')
    wd.feed()
    expect(wd.getState().status).toBe('monitoring')
    t.advance(10_000_000)
    wd.tick()
    expect(t.sent).toEqual([])
  })

  it('safeguard: no incident is opened and nothing is typed', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, { safeguard: { enabled: false } as never })
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.feed()
    expect(wd.getState().status).toBe('monitoring')
    t.advance(10_000_000)
    wd.tick()
    expect(t.sent).toEqual([])
  })
})

describe('#605 switching a check off mid-incident', () => {
  it('drops a live wait back to monitoring and never fires its retry', () => {
    const { t, wd } = intoWaiting()
    wd.setChecks({ rateLimit: false })
    expect(wd.getState().status).toBe('monitoring')
    expect(wd.getState().waitUntil).toBeNull()
    t.advance(10_000_000)
    wd.tick()
    expect(t.sent, 'the retry the wait was counting down to must not fire').toEqual([])
  })

  // ADR-009 round 1 (MAJOR): an off/on pair must not hand back a retry budget
  // for a screen that never changed -- otherwise a user could re-submit a
  // safeguard-flagged message without bound just by toggling. Round 2 (MAJOR 1):
  // and it must not go the other way either -- the check coming back ON has to
  // re-arm, or the pill reports "on" for a check that will never act again.
  it('resumes the same incident with its SPENT budget when the check comes back on', () => {
    const { t, wd } = intoWaiting()
    // Spend two of the five default rate-limit retries.
    t.advance(60_001); wd.tick()
    t.advance(60_001); wd.tick()
    expect(t.sent.length).toBe(2)
    wd.setChecks({ rateLimit: false })
    wd.setChecks({ rateLimit: true })
    // The limit banner is still on screen, unchanged: the incident resumes.
    t.setTail('limit reached, resets 3pm')
    wd.feed()
    expect(wd.getState().status, 'switching the check back on must re-arm it').toBe('waiting')
    for (let i = 0; i < 10; i++) { t.advance(60_001); wd.tick() }
    expect(t.sent.length, 'only the unspent retries are left -- no refund').toBe(5)
    expect(wd.getState().gaveUp, 'the give-up follows from the resumed counter').toBe(true)
  })

  it('a given-up wait comes back given up rather than buying a fresh budget', () => {
    const { t, wd } = intoWaiting()
    for (let i = 0; i < 10; i++) { t.advance(60_001); wd.tick() }
    expect(wd.getState().gaveUp).toBe(true)
    const spent = t.sent.length
    wd.setChecks({ rateLimit: false })
    wd.setChecks({ rateLimit: true })
    t.setTail('limit reached, resets 3pm')
    wd.feed()
    for (let i = 0; i < 10; i++) { t.advance(60_001); wd.tick() }
    expect(t.sent.length, 'toggling must not resurrect a latched give-up').toBe(spent)
  })

  it('a parked incident is discarded once its banner clears, even while the check is off', () => {
    const { t, wd } = intoWaiting()
    t.advance(60_001); wd.tick()
    expect(t.sent.length).toBe(1)
    wd.setChecks({ rateLimit: false })
    // The limit clears WHILE the check is off: the parked incident is over, so
    // its spend must not be carried into the next one.
    isRateLimited.mockReturnValue(false)
    t.setTail('all good now')
    wd.feed()
    wd.setChecks({ rateLimit: true })
    // A NEW limit later is a fresh incident with a full budget.
    isRateLimited.mockReturnValue(true)
    t.setTail('limit reached, resets 5pm')
    wd.feed()
    expect(wd.getState().status).toBe('waiting')
    const before = t.sent.length
    for (let i = 0; i < 10; i++) { t.advance(60_001); wd.tick() }
    expect(t.sent.length - before, 'a genuinely new incident gets the full budget').toBe(5)
  })

  it('a resumed overload incident keeps its backoff step and cumulative wait', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, { overload: { jitterPct: 0 } as never })
    detectOverload.mockReturnValue(true)
    t.setTail('API Error: 529')
    wd.feed()
    expect(wd.getState().status).toBe('overload')
    // Two retries: the ramp is at [30, 60, 120, 240, 300]s.
    t.advance(10_000_000); wd.tick()
    t.advance(10_000_000); wd.tick()
    expect(t.sent.length).toBe(2)
    wd.setChecks({ overload: false })
    wd.setChecks({ overload: true })
    wd.feed()
    expect(wd.getState().status).toBe('overload')
    expect(wd.getState().overloadAttempts, 'the resumed incident keeps its spend').toBe(2)
  })

  it('a safeguard give-up cannot be resurrected by toggling the check', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter)
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.feed()
    expect(wd.getState().status).toBe('safeguard')
    // Spend the whole budget (default 3) until it gives up.
    for (let i = 0; i < 10; i++) { t.advance(60_000); wd.tick() }
    const spent = t.sent.length
    expect(wd.getState().gaveUp).toBe(true)
    // Toggling off and on must not buy another round of auto-submits.
    wd.setChecks({ safeguard: false })
    wd.setChecks({ safeguard: true })
    wd.feed()
    for (let i = 0; i < 10; i++) { t.advance(60_000); wd.tick() }
    expect(t.sent.length, 'a flagged message must not be re-submitted by toggling').toBe(spent)
  })

  it('publishes the change so the session pill can follow it', () => {
    const { t, wd } = intoWaiting()
    t.stateChanges.length = 0
    wd.setChecks({ overload: false })
    expect(t.stateChanges.at(-1)?.checks).toEqual({ rateLimit: true, overload: false, safeguard: true })
  })

  it('a no-op toggle publishes nothing', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter)
    t.stateChanges.length = 0
    wd.setChecks({ overload: true })
    expect(t.stateChanges).toEqual([])
  })
})

// A parked incident makes feedMonitoring run its block even while the check is
// OFF -- purely so the discard can notice the condition leaving the screen. The
// inner check gate is what stops that from also re-arming the incident, and it
// is reachable ONLY in this state.
describe('#605 a park ends on the same evidence the live incident does', () => {
  it('safeguard: a park survives a retry in flight, when the flag is out of the tail window', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter)
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.feed()
    t.advance(60_000); wd.tick()
    t.advance(60_000); wd.tick()
    expect(t.sent.length, 'two of the three safeguard retries are spent').toBe(2)
    // The user toggles the check off just after watching a retry fire. That
    // retry is in flight, so the flag has scrolled out of the tail window --
    // exactly the state feedSafeguard/tickSafeguard refuse to read as recovery.
    wd.setChecks({ safeguard: false })
    isWorking.mockReturnValue(true)
    detectSafeguard.mockReturnValue(false)
    t.setTail('... working ...')
    wd.feed()
    // The same message is flagged again and the user turns the check back on.
    isWorking.mockReturnValue(false)
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.setChecks({ safeguard: true })
    wd.feed()
    for (let i = 0; i < 10; i++) { t.advance(60_000); wd.tick() }
    expect(t.sent.length, 'a flagged message must not get a fresh budget via a mid-retry toggle').toBe(3)
  })

  it('overload: a hook-opened park is not discarded merely because no banner is on screen', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, { overload: { maxTotalWaitMinutes: 1, jitterPct: 0 } as never })
    t.setTail('no banner here')
    wd.handleHookEvent({ event: 'error', error: 'overloaded' })
    expect(wd.getState().status).toBe('overload')
    wd.setChecks({ overload: false })
    // detectOverload stays false: an event-opened incident may never have had a
    // banner at all, so absent banner text is NOT a clearing signal for it.
    wd.feed()
    wd.setChecks({ overload: true })
    wd.handleHookEvent({ event: 'error', error: 'overloaded' })
    wd.handleHookEvent({ event: 'error', error: 'overloaded' })
    expect(wd.getState().gaveUp, 'an event-opened park must not evaporate on an unchanged tail').toBe(true)
  })

  it('overload: a hook-opened park IS discarded once the tail advances past the event snapshot', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, { overload: { maxTotalWaitMinutes: 1, jitterPct: 0 } as never })
    t.setTail('no banner here')
    wd.handleHookEvent({ event: 'error', error: 'overloaded' })
    wd.setChecks({ overload: false })
    // The session moved on: a silent recovery, which is how feedOverload ends an
    // event-opened incident.
    t.setTail('the session carried on')
    wd.feed()
    wd.setChecks({ overload: true })
    wd.handleHookEvent({ event: 'error', error: 'overloaded' })
    wd.handleHookEvent({ event: 'error', error: 'overloaded' })
    expect(wd.getState().gaveUp, 'a genuinely finished incident starts the next one fresh').toBe(false)
  })

  it('overload: a self-recovered hook event ends the parked incident too', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, { overload: { maxTotalWaitMinutes: 1, jitterPct: 0 } as never })
    t.setTail('no banner here')
    wd.handleHookEvent({ event: 'error', error: 'overloaded' })
    wd.setChecks({ overload: false })
    wd.setChecks({ overload: true })
    // The session self-recovered before the next event landed. That ends the
    // incident, and its park with it -- without waiting for a monitoring feed.
    isWorking.mockReturnValue(true)
    wd.handleHookEvent({ event: 'error', error: 'overloaded' })
    expect(wd.getState().status).toBe('monitoring')
    isWorking.mockReturnValue(false)
    wd.handleHookEvent({ event: 'error', error: 'overloaded' })
    wd.handleHookEvent({ event: 'error', error: 'overloaded' })
    expect(wd.getState().gaveUp, 'a finished incident must not carry its spend into the next one').toBe(false)
  })

  it('a park skipped by an earlier branch is still discarded on the same feed', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter)
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.feed()
    for (let i = 0; i < 10; i++) { t.advance(60_000); wd.tick() }
    expect(wd.getState().gaveUp, 'the safeguard budget is spent').toBe(true)
    const spent = t.sent.length
    wd.setChecks({ safeguard: false })
    // The flag clears on a render that ALSO opens a rate-limit wait, so the
    // rate-limit branch returns before the safeguard branch is reached.
    detectSafeguard.mockReturnValue(false)
    isRateLimited.mockReturnValue(true)
    t.setTail('limit reached, resets 3pm')
    wd.feed()
    expect(wd.getState().status).toBe('waiting')
    // The limit clears; a NEW message is flagged. That is a fresh incident and
    // must get a full budget -- the stale park must not have survived.
    isRateLimited.mockReturnValue(false)
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.setChecks({ safeguard: true })
    wd.feed() // feedWaiting: the limit banner is gone, so drop back to monitoring
    expect(wd.getState().status).toBe('monitoring')
    wd.feed()
    for (let i = 0; i < 10; i++) { t.advance(60_000); wd.tick() }
    expect(t.sent.length - spent, 'a genuinely new incident gets the full budget').toBe(3)
  })
})

describe('#605 every entry into an incident consumes its park', () => {
  it('handleHookEvent resumes a parked overload incident instead of refunding the cap', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, { overload: { maxTotalWaitMinutes: 1, jitterPct: 0 } as never })
    // cap = 60s, ladder starts at 30s: three events reach it, two do not.
    wd.handleHookEvent({ event: 'error', error: 'overloaded' })
    expect(wd.getState().status).toBe('overload')
    wd.setChecks({ overload: false })
    wd.setChecks({ overload: true })
    wd.handleHookEvent({ event: 'error', error: 'overloaded' })
    wd.handleHookEvent({ event: 'error', error: 'overloaded' })
    expect(wd.getState().gaveUp, 'the maxTotalWaitMinutes cap must not be refundable by a toggle').toBe(true)
  })

  it('a resumed overload incident still hits its cumulative-wait cap', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, { overload: { maxTotalWaitMinutes: 1, jitterPct: 0 } as never })
    detectOverload.mockReturnValue(true)
    t.setTail('API Error: 529')
    wd.feed()
    t.advance(10_000_000); wd.tick()
    expect(t.sent.length, 'entry spends 30s, one retry spends another 60s').toBe(1)
    wd.setChecks({ overload: false })
    wd.setChecks({ overload: true })
    wd.feed()
    expect(wd.getState().gaveUp, 'a resumed incident past its cap reads as given up at once').toBe(true)
    t.advance(10_000_000); wd.tick()
    expect(t.sent.length, 'a capped resume must not buy another retry').toBe(1)
  })

  it('a resumed rate-limit incident past its budget reads as given up before the next tick', () => {
    const { t, wd } = intoWaiting()
    for (let i = 0; i < 10; i++) { t.advance(60_001); wd.tick() }
    expect(wd.getState().gaveUp).toBe(true)
    wd.setChecks({ rateLimit: false })
    wd.setChecks({ rateLimit: true })
    t.setTail('limit reached, resets 3pm')
    wd.feed()
    expect(wd.getState().status).toBe('waiting')
    expect(wd.getState().gaveUp, 'the pill must not advertise a retry that cannot fire').toBe(true)
  })
})

describe('#605 a park does not re-arm a check that is still off', () => {
  it('rate limit: a parked wait is not re-opened while the check is off', () => {
    const { t, wd } = intoWaiting()
    t.advance(60_001); wd.tick()
    expect(t.sent.length).toBe(1)
    wd.setChecks({ rateLimit: false })
    // The banner is still up, and the park is held.
    t.setTail('limit reached, resets 3pm')
    wd.feed()
    expect(wd.getState().status, 'a park must not re-arm a check the user turned off').toBe('monitoring')
    t.advance(10_000_000); wd.tick()
    expect(t.sent.length, 'nothing more is typed while the check is off').toBe(1)
  })

  it('rate limit: a parked wait does not swallow the overload branch either', () => {
    const { t, wd } = intoWaiting()
    wd.setChecks({ rateLimit: false })
    // Both banners on screen, rate-limit check off but its park still held.
    detectOverload.mockReturnValue(true)
    t.setTail('limit reached, resets 3pm / API Error: 529')
    wd.feed()
    expect(wd.getState().status, 'the parked block must fall through to overload').toBe('overload')
  })

  it('overload: a parked incident is not re-opened while the check is off', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter)
    detectOverload.mockReturnValue(true)
    t.setTail('API Error: 529')
    wd.feed()
    expect(wd.getState().status).toBe('overload')
    wd.setChecks({ overload: false })
    wd.feed()
    expect(wd.getState().status, 'a park must not re-arm a check the user turned off').toBe('monitoring')
    t.advance(10_000_000); wd.tick()
    expect(t.sent).toEqual([])
  })

  it('safeguard: a parked incident is not re-opened while the check is off', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter)
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.feed()
    expect(wd.getState().status).toBe('safeguard')
    wd.setChecks({ safeguard: false })
    wd.feed()
    expect(wd.getState().status, 'a park must not re-arm a check the user turned off').toBe('monitoring')
    t.advance(10_000_000); wd.tick()
    expect(t.sent).toEqual([])
  })
})

describe('#605 a muted rate-limit check does not swallow the other two', () => {
  // The gate on the rate-limit block in feedMonitoring is BEHAVIOUR, not
  // defence in depth: without it a tail carrying both banners runs the
  // rate-limit branch, which returns early and never reaches overload.
  it('a tail carrying BOTH a usage limit and an overload banner still opens the overload incident', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, { rateLimitEnabled: false })
    isRateLimited.mockReturnValue(true)
    detectOverload.mockReturnValue(true)
    t.setTail('limit reached, resets 3pm / API Error: 529')
    wd.feed()
    expect(wd.getState().status, 'the muted check must not consume the feed').toBe('overload')
  })

  it('a tail carrying BOTH a usage limit and a safeguard flag still opens the safeguard incident', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, { rateLimitEnabled: false })
    isRateLimited.mockReturnValue(true)
    detectSafeguard.mockReturnValue(true)
    t.setTail('limit reached, resets 3pm / safeguards flagged this message')
    wd.feed()
    expect(wd.getState().status, 'the muted check must not consume the feed').toBe('safeguard')
  })
})

describe('#605 the rate-limit check also guards the escalation path', () => {
  it('an overload incident meeting a usage limit opens no wait when the check is off', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, { rateLimitEnabled: false })
    detectOverload.mockReturnValue(true)
    t.setTail('API Error: 529')
    wd.feed()
    expect(wd.getState().status).toBe('overload')
    // tickOverload escalates into enterWaiting when a usage limit shows up.
    isRateLimited.mockReturnValue(true)
    t.setTail('limit reached, resets 3pm')
    t.advance(10_000_000)
    wd.tick()
    expect(wd.getState().status, 'escalation must not reach a muted check').toBe('monitoring')
    expect(t.sent).toEqual([])
  })

  // ADR-009 round 2 (MAJOR 2): enterWaiting can DECLINE, and every escalation
  // caller has already zeroed its own incident by the time it calls. A decline
  // that made no transition left the session pinned in overload/safeguard with a
  // zeroed budget and a waitUntil already in the past, so the next tick resumed
  // sending on a full refunded allowance. Each caller settles the machine itself.
  it('feedOverload: a declined escalation settles in monitoring, not pinned in overload', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, { rateLimitEnabled: false })
    detectOverload.mockReturnValue(true)
    t.setTail('API Error: 529')
    wd.feed()
    expect(wd.getState().status).toBe('overload')
    isRateLimited.mockReturnValue(true)
    t.setTail('limit reached, resets 3pm / API Error: 529')
    wd.feed()
    expect(wd.getState().status, 'a declined enterWaiting must not leave the session in overload').toBe('monitoring')
    expect(wd.getState().waitUntil, 'a pinned incident keeps a stale waitUntil').toBeNull()
    t.advance(10_000_000)
    wd.tick()
    expect(t.sent).toEqual([])
  })

  it('feedSafeguard: a declined escalation settles in monitoring, not pinned in safeguard', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, { rateLimitEnabled: false })
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.feed()
    expect(wd.getState().status).toBe('safeguard')
    isRateLimited.mockReturnValue(true)
    t.setTail('limit reached, resets 3pm / safeguards flagged this message')
    wd.feed()
    expect(wd.getState().status, 'a declined enterWaiting must not leave the session in safeguard').toBe('monitoring')
    expect(wd.getState().waitUntil).toBeNull()
    t.advance(10_000_000)
    wd.tick()
    expect(t.sent).toEqual([])
  })

  it('tickSafeguard: a declined escalation settles in monitoring, not pinned in safeguard', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter, { rateLimitEnabled: false })
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.feed()
    expect(wd.getState().status).toBe('safeguard')
    isRateLimited.mockReturnValue(true)
    t.setTail('limit reached, resets 3pm / safeguards flagged this message')
    t.advance(10_000_000)
    wd.tick()
    expect(wd.getState().status, 'a declined enterWaiting must not leave the session in safeguard').toBe('monitoring')
    expect(wd.getState().waitUntil).toBeNull()
    t.advance(10_000_000)
    wd.tick()
    expect(t.sent).toEqual([])
  })
})

// The runtime cases: the check is switched off AFTER construction, so the
// config flag still says ON. Only the live `checks` triple can suppress these
// -- reverting any gate to `this.config.*.enabled` makes them fire again.
describe('#605 a check switched off at runtime stops a FRESH incident', () => {
  it('rate limit: a new usage-limit banner opens no wait', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter)
    wd.setChecks({ rateLimit: false })
    isRateLimited.mockReturnValue(true)
    t.setTail('limit reached, resets 3pm')
    wd.feed()
    expect(wd.getState().status, 'the live check, not the config, decides').toBe('monitoring')
    t.advance(10_000_000)
    wd.tick()
    expect(t.sent).toEqual([])
  })

  it('overload: a new API error opens no incident', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter)
    wd.setChecks({ overload: false })
    detectOverload.mockReturnValue(true)
    t.setTail('API Error: 529')
    wd.feed()
    expect(wd.getState().status).toBe('monitoring')
    t.advance(10_000_000)
    wd.tick()
    expect(t.sent).toEqual([])
  })

  it('safeguard: a new flagged message opens no incident', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter)
    wd.setChecks({ safeguard: false })
    detectSafeguard.mockReturnValue(true)
    t.setTail('safeguards flagged this message')
    wd.feed()
    expect(wd.getState().status).toBe('monitoring')
    t.advance(10_000_000)
    wd.tick()
    expect(t.sent).toEqual([])
  })

  it('overload: the hook-event path is muted too, not just the tail scraper', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter)
    wd.setChecks({ overload: false })
    wd.handleHookEvent({ event: 'error', error: 'overloaded' })
    expect(wd.getState().status, 'an edge-triggered overload must respect the live check').toBe('monitoring')
    t.advance(10_000_000)
    wd.tick()
    expect(t.sent).toEqual([])
  })

  it('the other two checks keep working when one is muted', () => {
    const t = makeAdapter()
    const wd = new SessionWatchdog('s', t.adapter)
    wd.setChecks({ overload: false })
    isRateLimited.mockReturnValue(true)
    t.setTail('limit reached, resets 3pm')
    wd.feed()
    expect(wd.getState().status).toBe('waiting')
    t.advance(60_001)
    wd.tick()
    expect(t.sent, 'muting one check must not mute the others').toEqual(['continue'])
  })
})
