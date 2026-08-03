import { describe, it, expect } from 'vitest'
import { isAuthFailureMessage } from '../../src/shared/claude-auth-errors'

// #191: Insights offers a re-auth action off the back of this classifier, so a
// false positive sends the user into a login shell for a perfectly good account.
// Deliberately a narrow allow-list, and these tests pin both directions.

describe('isAuthFailureMessage', () => {
  it('recognises the message a real run produced', () => {
    expect(
      isAuthFailureMessage('Failed to authenticate: OAuth session expired and could not be refreshed')
    ).toBe(true)
  })

  it('recognises the message as it arrives wrapped by describeClaudeError', () => {
    expect(
      isAuthFailureMessage(
        'success; Failed to authenticate: OAuth session expired and could not be refreshed; the API was never reached (duration_api_ms=0); stop_reason=stop_sequence'
      )
    ).toBe(true)
  })

  it('recognises the other ways a dead sign-in is reported', () => {
    for (const message of [
      'Session has expired',
      'OAuth token expired',
      'Could not refresh the OAuth session',
      'unable to refresh token',
      'You are not logged in',
      'Please run /login to continue',
      'Invalid API key',
      'authentication_error',
      'Unauthorized',
      'credentials are invalid'
    ]) {
      expect(isAuthFailureMessage(message), message).toBe(true)
    }
  })

  it('is case-insensitive', () => {
    expect(isAuthFailureMessage('FAILED TO AUTHENTICATE')).toBe(true)
  })

  it('does NOT fire on the other real failure modes', () => {
    for (const message of [
      'the analysis reply was cut off mid-object',
      'no JSON object could be recovered from the reply',
      'kpis.json could not be written',
      'claude exited 1',
      'Only 1 of 4 accounts produced KPIs; a cross-account report needs at least 2',
      '/insights did not produce a report within 600s',
      'Failed to copy report files',
      'Interrupted by app restart',
      // Close but not an auth problem: an expired report, not an expired session.
      'the cached report expired and was regenerated'
    ]) {
      expect(isAuthFailureMessage(message), message).toBe(false)
    }
  })

  it('handles empty, null and undefined', () => {
    expect(isAuthFailureMessage('')).toBe(false)
    expect(isAuthFailureMessage(null)).toBe(false)
    expect(isAuthFailureMessage(undefined)).toBe(false)
  })
})
