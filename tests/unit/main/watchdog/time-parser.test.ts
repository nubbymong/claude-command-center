import { describe, it, expect } from 'vitest'
import { parseResetTime, calculateWaitMs, calculateWaitMsUpstream } from '../../../../src/main/watchdog/time-parser'

describe('parseResetTime', () => {
  it('parses "resets 3pm (Europe/Dublin)"', () => {
    const r = parseResetTime('5-hour limit reached - resets 3pm (Europe/Dublin)')
    expect(r).toMatchObject({ hour: 15, minute: 0, timezone: 'Europe/Dublin' })
  })

  it('parses "resets at 2pm (America/New_York)"', () => {
    const r = parseResetTime('Usage limit. Resets at 2pm (America/New_York)')
    expect(r).toMatchObject({ hour: 14, timezone: 'America/New_York' })
  })

  it('parses "resets 15:30 (Asia/Kolkata)"', () => {
    const r = parseResetTime('resets 15:30 (Asia/Kolkata)')
    expect(r).toMatchObject({ hour: 15, minute: 30 })
  })

  it('parses 12pm as noon', () => {
    const r = parseResetTime('resets 12pm (UTC)')
    expect(r).toMatchObject({ hour: 12 })
  })

  it('parses 12am as midnight', () => {
    const r = parseResetTime('resets 12am (UTC)')
    expect(r).toMatchObject({ hour: 0 })
  })

  it('handles no timezone', () => {
    const r = parseResetTime('resets 3pm')
    expect(r).toMatchObject({ hour: 15, timezone: null })
  })

  it('returns null for unparseable text', () => {
    expect(parseResetTime('some random text')).toBeNull()
  })

  // An out-of-range clock ("resets 30") must not parse a bad hour that later makes
  // calculateWaitMs build an Invalid Date and throw (crashing the monitor).
  it('returns null for an out-of-range hour ("resets 30")', () => {
    expect(parseResetTime('resets 30')).toBeNull()
  })

  it('parses a 24h-style "resets 12:30" without an am/pm as ambiguous noon/midnight', () => {
    const r = parseResetTime('resets 12:30')
    expect(r).toMatchObject({ hour: 12, minute: 30, ambiguous: true })
  })

  it('parses "try again in 5 minutes" as relative time', () => {
    const r = parseResetTime('try again in 5 minutes')
    expect(r).toMatchObject({ relative: true, waitMs: 5 * 60_000 })
  })

  it('parses "try again in 2 hours" as relative time', () => {
    const r = parseResetTime('try again in 2 hours')
    expect(r).toMatchObject({ relative: true, waitMs: 2 * 3_600_000 })
  })

  it('parses "wait 30 mins" as relative time', () => {
    const r = parseResetTime('wait 30 mins')
    expect(r).toMatchObject({ relative: true, waitMs: 30 * 60_000 })
  })

  it('parses "resets in: 3 hours" as relative time', () => {
    const r = parseResetTime('usage limit · resets in: 3 hours')
    expect(r).toMatchObject({ relative: true, waitMs: 3 * 3_600_000 })
  })

  it('parses "resets in 2 hours" as relative time', () => {
    const r = parseResetTime('resets in 2 hours')
    expect(r).toMatchObject({ relative: true, waitMs: 2 * 3_600_000 })
  })
})

describe('calculateWaitMs', () => {
  it('returns positive wait for future time', () => {
    const now = new Date('2026-07-07T09:00:00Z')
    const futureHour = (now.getUTCHours() + 2) % 24
    const wait = calculateWaitMsUpstream({ hour: futureHour, minute: 0, timezone: 'UTC', ambiguous: false }, 60, 5, now)
    expect(wait).toBeGreaterThan(0)
    expect(wait).toBeLessThanOrEqual(3 * 3_600_000)
  })

  it('adds margin seconds', () => {
    const now = new Date('2026-07-07T09:00:00Z')
    const futureHour = (now.getUTCHours() + 1) % 24
    const w0 = calculateWaitMsUpstream({ hour: futureHour, minute: 0, timezone: 'UTC', ambiguous: false }, 0, 5, now)
    const w120 = calculateWaitMsUpstream({ hour: futureHour, minute: 0, timezone: 'UTC', ambiguous: false }, 120, 5, now)
    expect(w120 - w0).toBeGreaterThanOrEqual(119_000)
    expect(w120 - w0).toBeLessThanOrEqual(121_000)
  })

  it('returns fallback when parsed is null', () => {
    const wait = calculateWaitMsUpstream(null, 60, 5)
    expect(Math.abs(wait - (5 * 3600 + 60) * 1000)).toBeLessThan(2000)
  })

  it('typed-options wrapper matches the upstream positional signature', () => {
    const now = new Date('2026-07-07T09:00:00Z')
    const wait = calculateWaitMs(
      { hour: 12, minute: 30, timezone: 'UTC', ambiguous: true },
      { marginSeconds: 60, fallbackWaitHours: 5, now },
    )
    const upstream = calculateWaitMsUpstream({ hour: 12, minute: 30, timezone: 'UTC', ambiguous: true }, 60, 5, now)
    expect(wait).toBe(upstream)
  })

  // An ambiguous hour of 12 -> the pm interpretation is (12+12)%24 = 0 (midnight), NOT hour
  // 24 (which makes `new Date("...T24:...Z")` Invalid -> throw -> monitor crash-loop). Must
  // return a finite wait, never throw.
  it('does not throw on an ambiguous 12:30 (12+12 -> midnight, not hour 24)', () => {
    const now = new Date('2026-07-07T09:00:00Z')
    const wait = calculateWaitMsUpstream({ hour: 12, minute: 30, timezone: 'UTC', ambiguous: true }, 60, 5, now)
    expect(Number.isFinite(wait)).toBe(true)
    expect(wait).toBeGreaterThan(0)
  })

  it('handles ambiguous hour by picking soonest future', () => {
    const now = new Date('2026-03-18T13:00:00Z')
    const wait = calculateWaitMsUpstream({ hour: 3, minute: 0, timezone: 'UTC', ambiguous: true }, 0, 5, now)
    expect(wait).toBeGreaterThan(0)
    expect(wait).toBeLessThanOrEqual(3 * 3_600_000)
  })

  // Ambiguous, BOTH interpretations past & outside grace: roll to the EARLIEST next
  // occurrence (tomorrow's am), not the pm one. "resets 10" at 23:30 Zurich -- 10pm passed
  // 1.5h ago (outside grace), 10am passed 13.5h ago -> target 10am tomorrow (~10.5h), not
  // 10pm tomorrow (~22.5h). The grace check uses the most-recent interpretation, but the
  // roll must use the earliest.
  it('ambiguous both-past outside grace rolls to the earliest occurrence (am), not pm', () => {
    const now = new Date('2026-07-07T21:30:00Z') // 23:30 Zurich
    const wait = calculateWaitMsUpstream(
      { hour: 10, minute: 0, timezone: 'Europe/Zurich', ambiguous: true },
      60,
      5,
      now,
    )
    const hours = wait / 3_600_000
    expect(hours).toBeGreaterThan(10)
    expect(hours).toBeLessThan(11)
  })

  // Ambiguous, most-recent interpretation just passed (within grace): retry promptly.
  it('ambiguous within-grace (most-recent interpretation just passed) retries promptly', () => {
    const now = new Date('2026-07-07T20:30:00Z') // 22:30 Zurich, 30 min after the 10pm interpretation
    const wait = calculateWaitMsUpstream(
      { hour: 10, minute: 0, timezone: 'Europe/Zurich', ambiguous: true },
      60,
      5,
      now,
    )
    expect(wait / 60_000).toBeLessThan(5)
  })

  it('handles relative time correctly', () => {
    const wait = calculateWaitMsUpstream({ relative: true, waitMs: 300_000 }, 60, 5)
    expect(Math.abs(wait - 360_000)).toBeLessThan(2000) // 5 min + 60s margin
  })

  it('falls back on invalid timezone', () => {
    const wait = calculateWaitMsUpstream({ hour: 15, minute: 0, timezone: 'Invalid/Zone', ambiguous: false }, 60, 5)
    expect(Math.abs(wait - (5 * 3600 + 60) * 1000)).toBeLessThan(2000) // fallback
  })

  // Regression: in a positive-offset tz, 10:02 AM Melbourne (UTC+10) looking for
  // "11:40pm Melbourne" should wait ~13.6h (today), not ~37.6h.
  it('targets today for a future reset in a positive-offset timezone', () => {
    const now = new Date('2026-05-03T00:02:15Z') // 10:02 AM in Melbourne (UTC+10)
    const wait = calculateWaitMsUpstream(
      { hour: 23, minute: 40, timezone: 'Australia/Melbourne', ambiguous: false },
      60,
      5,
      now,
    )
    const hours = wait / 3_600_000
    expect(hours).toBeGreaterThan(13)
    expect(hours).toBeLessThan(14)
  })

  // Regression: negative-offset tz, "resets 3am NY" at 1am NY -> ~2h.
  it('targets today for a future reset in a negative-offset timezone', () => {
    const now = new Date('2026-05-03T05:00:00Z') // 1:00 AM in New York (UTC-4 EDT)
    const wait = calculateWaitMsUpstream(
      { hour: 3, minute: 0, timezone: 'America/New_York', ambiguous: false },
      60,
      5,
      now,
    )
    const hours = wait / 3_600_000
    expect(hours).toBeGreaterThan(1.9)
    expect(hours).toBeLessThan(2.1)
  })

  // Regression: reset already passed today -> target tomorrow (~22.6h), not 48h.
  it('targets tomorrow when reset time already passed today', () => {
    const now = new Date('2026-05-03T15:00:00Z') // 1:00 AM next day in Melbourne
    const wait = calculateWaitMsUpstream(
      { hour: 23, minute: 40, timezone: 'Australia/Melbourne', ambiguous: false },
      60,
      5,
      now,
    )
    const hours = wait / 3_600_000
    expect(hours).toBeGreaterThan(22)
    expect(hours).toBeLessThan(23)
  })

  // Reset-boundary grace window: detecting a limit banner whose reset time only JUST
  // passed must retry promptly -- the limit has effectively reset -- not park ~24h.
  it('retries promptly when the reset time only just passed (grace window)', () => {
    const now = new Date('2026-07-07T08:03:06Z') // 10:03 Zurich, 3 min after a 10am reset
    const wait = calculateWaitMsUpstream(
      { hour: 10, minute: 0, timezone: 'Europe/Zurich', ambiguous: false },
      60,
      5,
      now,
    )
    expect(wait / 60_000).toBeLessThan(5)
  })

  it('applies the grace window within the hour after the reset', () => {
    const now = new Date('2026-07-07T08:55:00Z') // 10:55 Zurich, 55 min after a 10am reset
    const wait = calculateWaitMsUpstream(
      { hour: 10, minute: 0, timezone: 'Europe/Zurich', ambiguous: false },
      60,
      5,
      now,
    )
    expect(wait / 60_000).toBeLessThan(5)
  })

  it('still rolls to tomorrow once the reset is well over an hour past', () => {
    const now = new Date('2026-07-07T10:00:00Z') // 12:00 Zurich, 2h after a 10am reset
    const wait = calculateWaitMsUpstream(
      { hour: 10, minute: 0, timezone: 'Europe/Zurich', ambiguous: false },
      60,
      5,
      now,
    )
    const hours = wait / 3_600_000
    expect(hours).toBeGreaterThan(21)
    expect(hours).toBeLessThan(23)
  })
})

describe('calculateWaitMs DST + far-timezone convergence (deterministic, no execFileSync subprocess)', () => {
  // Banner: resets 11:40pm Auckland (NZDT, UTC+13). Now: 2027-01-15T09:00Z = 22:00 NZDT.
  // Correct wait: 1h40m + 60s margin ~= 1.68h.
  it('banner tz beyond UTC+12 (Pacific/Auckland)', () => {
    const now = new Date('2027-01-15T09:00:00Z')
    const parsed = parseResetTime("You've hit your session limit · resets 11:40pm (Pacific/Auckland)")
    const wait = calculateWaitMsUpstream(parsed, 60, 5, now)
    expect(Math.abs(wait / 3_600_000 - 1.68)).toBeLessThan(0.02)
  })

  it('UTC+14 banner (Pacific/Kiritimati)', () => {
    const now = new Date('2027-01-15T10:00:00Z') // 00:00 Jan 16 in +14
    const parsed = parseResetTime('resets 12:30am (Pacific/Kiritimati)')
    const wait = calculateWaitMsUpstream(parsed, 60, 5, now)
    expect(Math.abs(wait / 3_600_000 - 0.52)).toBeLessThan(0.02)
  })

  // The roll-to-tomorrow must stay DST-safe: a flat +24h lands 1h short of tomorrow's
  // wall-clock time across a fall-back transition, and 1h long across spring-forward.
  // Tomorrow's occurrence must be computed date-anchored, like today's.
  it('fall-back night: "resets 3am" seen Sat 23:05 EDT waits to 3am EST, not 2am', () => {
    // Sat Oct 31 2026 23:05 EDT; reset Sun Nov 1 03:00 EST = 08:00Z -> 4h55m + margin
    const now = new Date('2026-11-01T03:05:00Z')
    const parsed = parseResetTime("You've hit your 5-hour limit · resets 3am (America/New_York)")
    const wait = calculateWaitMsUpstream(parsed, 60, 5, now)
    expect(Math.abs(wait / 3_600_000 - 4.933)).toBeLessThan(0.02)
  })

  it('fall-back night (EU): "resets at 4:00 AM" seen Sat 23:05 CEST waits to 4am CET', () => {
    // Sat Oct 24 2026 23:05 CEST; reset Sun Oct 25 04:00 CET = 03:00Z -> 5h55m + margin
    const now = new Date('2026-10-24T21:05:00Z')
    const parsed = parseResetTime('resets at 4:00 AM (Europe/Zurich)')
    const wait = calculateWaitMsUpstream(parsed, 60, 5, now)
    expect(Math.abs(wait / 3_600_000 - 5.933)).toBeLessThan(0.02)
  })

  it('spring-forward night: "resets 3am" seen Sat 23:05 EST waits to 3am EDT, not 4am', () => {
    // Sat Mar 13 2027 23:05 EST; reset Sun Mar 14 03:00 EDT = 07:00Z -> 2h55m + margin
    const now = new Date('2027-03-14T04:05:00Z')
    const parsed = parseResetTime('resets 3am (America/New_York)')
    const wait = calculateWaitMsUpstream(parsed, 60, 5, now)
    expect(Math.abs(wait / 3_600_000 - 2.933)).toBeLessThan(0.02)
  })

  // Rolling ONTO a transition day can land on a wall time that doesn't exist
  // (spring-forward gap) or exists twice (fall-back repeat). Both resolve to the LATE
  // side -- waking an hour late is safe; waking early burns maxRetries into a live banner.
  it('roll onto a NONEXISTENT 2am (spring-forward): wakes at the skip instant', () => {
    // Sat Mar 13 2027 23:30 EST; "2am" Sun Mar 14 doesn't exist (2->3 jump). The first
    // real instant at/after the intended time is 3:00 EDT = 07:00Z -> 2h30m + margin.
    const now = new Date('2027-03-14T04:30:00Z')
    const parsed = parseResetTime('resets 2am (America/New_York)')
    const wait = calculateWaitMsUpstream(parsed, 60, 5, now)
    expect(Math.abs(wait / 3_600_000 - 2.517)).toBeLessThan(0.02)
  })

  it('roll onto an AMBIGUOUS 2am (fall-back repeat): picks the later occurrence', () => {
    // Sat Apr 3 2027 23:30 NZDT; "2am" Sun Apr 4 occurs twice (3->2 rollback). Later
    // occurrence = 2:00 NZST = Apr 3 14:00Z -> 3h30m + margin.
    const now = new Date('2027-04-03T10:30:00Z')
    const parsed = parseResetTime('resets 2am (Pacific/Auckland)')
    const wait = calculateWaitMsUpstream(parsed, 60, 5, now)
    expect(Math.abs(wait / 3_600_000 - 3.517)).toBeLessThan(0.02)
  })

  it('sanity: normal-offset banner (Europe/Berlin)', () => {
    const now = new Date('2026-07-19T11:33:00Z') // 13:33 CEST -> 1h57m + margin ~= 1.97h
    const parsed = parseResetTime("You've hit your session limit · resets 3:30pm (Europe/Berlin)")
    const wait = calculateWaitMsUpstream(parsed, 60, 5, now)
    expect(Math.abs(wait / 3_600_000 - 1.97)).toBeLessThan(0.02)
  })
})

describe('parseResetTime / calculateWaitMs fallback path', () => {
  it('invalid/garbled input falls back to the default wait', () => {
    const parsed = parseResetTime('the quick brown fox jumps over the lazy dog')
    expect(parsed).toBeNull()
    const wait = calculateWaitMs(parsed, { marginSeconds: 60, fallbackWaitHours: 5 })
    expect(Math.abs(wait - (5 * 3600 + 60) * 1000)).toBeLessThan(2000)
  })
})
