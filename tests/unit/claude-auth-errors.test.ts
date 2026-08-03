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
      'OAuth token expired',
      'Could not refresh the OAuth session',
      'You are not logged in',
      'Please run /login to continue',
      'Invalid API key',
      'authentication_error',
      'credentials are invalid'
    ]) {
      expect(isAuthFailureMessage(message), message).toBe(true)
    }
  })

  it('deliberately no longer fires on context-free auth words', () => {
    // Removed patterns, and the reason they were removed. Missing a novel phrasing
    // costs a raw message in the UI; a false positive costs a needless login.
    for (const message of ['Unauthorized', 'Session has expired', 'unable to refresh']) {
      expect(isAuthFailureMessage(message), message).toBe(false)
    }
  })

  it('is case-insensitive', () => {
    expect(isAuthFailureMessage('FAILED TO AUTHENTICATE')).toBe(true)
  })

  // The adversarial pass on PR #206 beat the first corpus with 11 of 11 real-world
  // non-auth strings, because several patterns' distinguishing words were all
  // optional: `/(?:could not|unable to) refresh(?: the)?(?: oauth)?(?: session|
  // token)?/i` reduces to "unable to refresh", and a bare `/\bunauthorized\b/i`
  // matches any HTTP 401 on the network path. This predicate opens a login shell,
  // so a false positive walks the user into re-authenticating a working account.
  it('does NOT fire on network, proxy or unrelated-tooling failures', () => {
    for (const message of [
      'HTTP 401 Unauthorized from proxy.corp.example',
      '407 Proxy Authorization Required',
      'Your VPN session expired, reconnect and retry',
      'npm ERR! could not refresh the package index',
      'DNS refresh failed for registry.npmjs.org',
      'Licence expired: renew to continue',
      'unable to refresh the cached manifest',
      'Certificate expired on 2026-01-01',
      'The session expired while waiting for the debugger',
      'Unauthorized: repository access denied by branch protection',
      'ETIMEDOUT while refreshing the connection pool'
    ]) {
      expect(isAuthFailureMessage(message), message).toBe(false)
    }
  })

  it('still fires when expired/refresh sits next to a credential noun', () => {
    for (const message of [
      'OAuth session expired and could not be refreshed',
      'refresh token expired',
      'access token invalid',
      'OAuth token revoked',
      'unable to refresh oauth credentials',
      'credentials are revoked'
    ]) {
      expect(isAuthFailureMessage(message), message).toBe(true)
    }
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
