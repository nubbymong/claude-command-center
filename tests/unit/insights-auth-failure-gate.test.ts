import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => '',
  registerSetupHandlers: () => {}
}))

import { isAuthFailure } from '../../src/shared/claude-auth-errors'
import { describeClaudeError, readClaudeFailureFacts } from '../../src/main/insights-runner'

// Round 2 of the adversarial pass on PR #206 beat the TIGHTENED regex set on both
// axes, using strings pulled from the shipped claude binary. The lesson was that
// phrase matching is the wrong mechanism, because `describeClaudeError` folds the
// envelope's `result` into its reason — and when the model RAN, `result` is model
// prose generated from a prompt containing the user's own report content.
//
// The gate is now STRUCTURAL: an auth failure happens before the request is
// served, so it spends no tokens and reaches no API. These tests pin that.

const AUTH_ENVELOPE = {
  is_error: true,
  subtype: 'error_during_execution',
  result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
  duration_api_ms: 0,
  num_turns: 1,
  stop_reason: 'stop_sequence',
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
}

function facts(envelope: object) {
  const stdout = JSON.stringify(envelope)
  return readClaudeFailureFacts(stdout, describeClaudeError(stdout))
}

describe('the structural auth gate', () => {
  it('classifies the real auth failure — no tokens, no API time', () => {
    const f = facts(AUTH_ENVELOPE)
    expect(f.isError).toBe(true)
    expect(f.apiReached).toBe(false)
    expect(isAuthFailure(f)).toBe(true)
  })

  it('REFUSES to classify model prose, however auth-like, once the API was reached', () => {
    // Every false positive the attacker demonstrated was model output, which can
    // only exist if the model ran. One token spent closes the whole class.
    for (const prose of [
      'Finished configuring OAuth for the demo app; refresh your browser to see the new settings',
      'The MCP server reported: credentials are missing from its local config, unrelated to this account',
      'OAuth docs updated; refresh the page for the new token scopes table',
      'You should re-authenticate the staging deployment before the next release'
    ]) {
      const f = facts({ ...AUTH_ENVELOPE, result: prose, usage: { output_tokens: 12 } })
      expect(f.apiReached, prose).toBe(true)
      expect(isAuthFailure(f), prose).toBe(false)
    }
  })

  it('treats any counted token as "the API was reached"', () => {
    for (const usage of [
      { input_tokens: 1 },
      { output_tokens: 1 },
      { cache_read_input_tokens: 1 },
      { cache_creation_input_tokens: 1 },
      { outputTokens: 1 }
    ]) {
      expect(readClaudeFailureFacts(JSON.stringify({ ...AUTH_ENVELOPE, usage }), 'x').apiReached).toBe(true)
    }
  })

  it('treats non-zero API time as "the API was reached" even with zero tokens', () => {
    const f = facts({ ...AUTH_ENVELOPE, duration_api_ms: 5000 })
    expect(f.apiReached).toBe(true)
    expect(isAuthFailure(f)).toBe(false)
  })

  it('fails CLOSED on a numeric field that is present but not a number', () => {
    // Round 3 finding: coercing a wrong-typed field to zero failed OPEN, letting
    // model prose back through the gate. Unparseable stdout already failed closed;
    // this makes the two consistent. Plausible via schema drift or a provider
    // passthrough that serialises large ints as strings.
    for (const envelope of [
      { ...AUTH_ENVELOPE, usage: { input_tokens: '500', output_tokens: '300' }, duration_api_ms: '5000' },
      { ...AUTH_ENVELOPE, usage: { input_tokens: Number.NaN } },
      { ...AUTH_ENVELOPE, duration_api_ms: '0' },
      { ...AUTH_ENVELOPE, usage: { output_tokens: {} } }
    ]) {
      const f = facts(envelope)
      expect(f.apiReached, JSON.stringify(envelope.usage)).toBe(true)
      expect(isAuthFailure(f)).toBe(false)
    }
  })

  it('still classifies the real envelope, whose counters are all present and zero', () => {
    // The fix must not confuse "absent" or "legitimately zero" with "unreadable".
    expect(isAuthFailure(facts(AUTH_ENVELOPE))).toBe(true)
    expect(isAuthFailure(facts({ ...AUTH_ENVELOPE, usage: {} }))).toBe(true)
    const { duration_api_ms: _omitted, ...noDuration } = AUTH_ENVELOPE
    expect(isAuthFailure(facts(noDuration))).toBe(true)
  })

  it('fails CLOSED on unparseable output — no auth verdict from garbage', () => {
    const f = readClaudeFailureFacts('not json at all', 'Failed to authenticate')
    expect(f.apiReached).toBe(true)
    expect(isAuthFailure(f)).toBe(false)
  })

  it('never classifies a success envelope', () => {
    const f = facts({ is_error: false, result: 'not logged in', duration_api_ms: 0, usage: {} })
    expect(isAuthFailure(f)).toBe(false)
  })
})

describe('the real CLI phrasings the previous set MISSED', () => {
  // All three were extracted from the shipped claude binary by the attacker.
  it('catches them now', () => {
    for (const result of [
      'Expired - log in again',
      'Cloud gateway session expired.  run /login to reconnect.',
      'Your token is no longer valid, you need to re-authenticate with your provider'
    ]) {
      expect(isAuthFailure(facts({ ...AUTH_ENVELOPE, result })), result).toBe(true)
    }
  })
})
