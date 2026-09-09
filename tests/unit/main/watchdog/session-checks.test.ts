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

  // ADR-009 round 1 (MAJOR): switching a check off SUSPENDS its incident. An
  // off/on pair must not hand back a retry budget for a screen that never
  // changed -- otherwise a user could re-submit a safeguard-flagged message
  // without bound just by toggling.
  it('does not re-open the same unchanged incident when the check comes back on', () => {
    const { t, wd } = intoWaiting()
    wd.setChecks({ rateLimit: false })
    wd.setChecks({ rateLimit: true })
    expect(wd.getState().status).toBe('monitoring')
    // The limit banner is still on screen, unchanged.
    t.setTail('limit reached, resets 3pm')
    wd.feed()
    expect(wd.getState().status, 'a suspended incident stays suspended').toBe('monitoring')
    t.advance(10_000_000)
    wd.tick()
    expect(t.sent, 'no budget is refunded for an unchanged screen').toEqual([])
  })

  it('re-opens only once the condition has genuinely cleared', () => {
    const { t, wd } = intoWaiting()
    wd.setChecks({ rateLimit: false })
    wd.setChecks({ rateLimit: true })
    // The limit clears: the suspended incident is genuinely over.
    isRateLimited.mockReturnValue(false)
    t.setTail('all good now')
    wd.feed()
    // A NEW limit later is a fresh incident with a full budget.
    isRateLimited.mockReturnValue(true)
    t.setTail('limit reached, resets 5pm')
    wd.feed()
    expect(wd.getState().status).toBe('waiting')
    t.advance(60_001)
    wd.tick()
    expect(t.sent).toEqual(['continue'])
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
