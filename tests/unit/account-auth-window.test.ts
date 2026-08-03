import { describe, it, expect } from 'vitest'
import { authFailureStillApplies, describeAuthWindow } from '../../src/shared/account-auth'

// #203: `.credentials.json` carries TWO expiries and conflating them produces a
// wrong, alarming UI. Measured on real profiles:
//   expiresAt              (access token)  0.5 - 7.8 HOURS, auto-renewed
//   refreshTokenExpiresAt  (refresh token) 1.0 - 27.4 DAYS, forces a login
// Only the second may appear in a countdown.

const NOW = Date.parse('2026-08-03T11:17:00Z')
const DAY = 86400000
const HOUR = 3600000

describe('describeAuthWindow', () => {
  it('counts down the REFRESH token, never the access token', () => {
    const w = describeAuthWindow(
      {
        hasRefreshToken: true,
        // Access token expires in 30 minutes and is irrelevant to the countdown.
        expiresAt: NOW + 30 * 60000,
        refreshTokenExpiresAt: NOW + 20 * DAY
      } as never,
      NOW
    )
    expect(w.daysUntilForcedLogin).toBe(20)
    expect(w.label).toBe('Forced sign-in in 20 days')
    expect(w.label).not.toMatch(/hour|minute/)
  })

  it('reproduces the real prod values and their tones', () => {
    // Measured 2026-08-03 11:17 local: 2.0d, 1.6d, 1.0d, 20.4d.
    const cases: Array<[number, number, string]> = [
      [2.0, 2, 'warning'],
      [1.6, 1, 'critical'],
      [1.0, 1, 'critical'],
      [20.4, 20, 'ok']
    ]
    for (const [inDays, expectDays, expectTone] of cases) {
      const w = describeAuthWindow(
        { hasRefreshToken: true, refreshTokenExpiresAt: NOW + inDays * DAY } as never,
        NOW
      )
      expect(w.daysUntilForcedLogin, `${inDays}d`).toBe(expectDays)
      expect(w.tone, `${inDays}d`).toBe(expectTone)
    }
  })

  it('switches to hours inside the last day rather than saying "0 days"', () => {
    const w = describeAuthWindow(
      { hasRefreshToken: true, refreshTokenExpiresAt: NOW + 5 * HOUR } as never,
      NOW
    )
    expect(w.label).toBe('Forced sign-in in 5 hours')
    expect(w.tone).toBe('critical')
    expect(w.label).not.toMatch(/0 days/)
  })

  it('singularises', () => {
    expect(
      describeAuthWindow({ hasRefreshToken: true, refreshTokenExpiresAt: NOW + 1 * DAY + HOUR } as never, NOW).label
    ).toBe('Forced sign-in in 1 day')
    expect(
      describeAuthWindow({ hasRefreshToken: true, refreshTokenExpiresAt: NOW + 1 * HOUR } as never, NOW).label
    ).toBe('Forced sign-in in 1 hour')
  })

  it('reports an already-expired refresh token', () => {
    const w = describeAuthWindow(
      { hasRefreshToken: true, refreshTokenExpiresAt: NOW - DAY } as never,
      NOW
    )
    expect(w.tone).toBe('expired')
    expect(w.label).toMatch(/expired/i)
  })

  it('reports missing credentials without inventing a countdown', () => {
    const w = describeAuthWindow({ credentialsMissing: true } as never, NOW)
    expect(w.tone).toBe('expired')
    expect(w.label).toBe('Not signed in')
    expect(w.daysUntilForcedLogin).toBeNull()
  })

  it('reports a credential set with no refresh token at all', () => {
    const w = describeAuthWindow({ hasRefreshToken: false } as never, NOW)
    expect(w.tone).toBe('expired')
    expect(w.label).toMatch(/no refresh token/i)
  })

  it('says the date is unknown rather than fabricating one for older files', () => {
    // Credential files written before refreshTokenExpiresAt existed.
    const w = describeAuthWindow({ hasRefreshToken: true } as never, NOW)
    expect(w.tone).toBe('unknown')
    expect(w.daysUntilForcedLogin).toBeNull()
    expect(w.label).toMatch(/unknown/i)
  })

  it('ignores a non-finite or non-positive expiry', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const w = describeAuthWindow(
        { hasRefreshToken: true, refreshTokenExpiresAt: bad } as never,
        NOW
      )
      expect(w.tone, String(bad)).toBe('unknown')
    }
  })
})

// The reported bug: "even though I logged in, it's still flagging an account as not
// logged in". The Insights warning was derived from run history, and signing in does
// NOT produce a new run — so the fix could never clear the warning. This is the
// retirement rule that fixes it.
describe('authFailureStillApplies', () => {
  const RUN_AT = NOW - 2 * HOUR

  it('retires the failure once the user has signed in since', () => {
    expect(authFailureStillApplies(RUN_AT, { credentialsUpdatedAt: NOW - HOUR })).toBe(false)
  })

  it('keeps the failure when the credentials predate the failed run', () => {
    expect(authFailureStillApplies(RUN_AT, { credentialsUpdatedAt: RUN_AT - HOUR })).toBe(true)
  })

  it('treats credentials written in the same instant as the run as not newer', () => {
    expect(authFailureStillApplies(RUN_AT, { credentialsUpdatedAt: RUN_AT })).toBe(true)
  })

  it('keeps the failure when the credentials are gone entirely', () => {
    expect(authFailureStillApplies(RUN_AT, { credentialsMissing: true, credentialsUpdatedAt: NOW })).toBe(true)
  })

  it('keeps the failure when nothing is known — fails toward warning, not silence', () => {
    expect(authFailureStillApplies(RUN_AT, undefined)).toBe(true)
    expect(authFailureStillApplies(RUN_AT, {})).toBe(true)
  })
})
