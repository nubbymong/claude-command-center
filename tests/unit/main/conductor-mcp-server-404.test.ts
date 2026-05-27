/**
 * #435 regression: when a /messages POST arrives with a sessionId that
 * isn't registered in the transports map (SSE dropped, server restarted,
 * Claude reusing a stale sid), we want:
 *
 *   1. The 404 response body to be actionable -- includes a recovery
 *      hint instead of the bare "Session not found" that the LLM
 *      currently surfaces.
 *   2. A WARN-level server-side log line with diagnostics (requested sid
 *      prefix, count of active transports, sample sids, user-agent) so
 *      we can correlate user reports against the in-process state when
 *      the bug recurs.
 *
 * The helper is pure (no I/O, no http types) so we can unit-test it
 * directly without spinning up a real http.Server.
 *
 * Note: we deliberately do NOT fix the underlying SSE-reconnect race
 * here -- this PR is diagnostic + UX only. The recovery investigation
 * is deferred to a follow-up cycle.
 */
import { describe, it, expect } from 'vitest'
import { buildSessionNotFoundResponse } from '../../../src/main/conductor-mcp-server'

describe('buildSessionNotFoundResponse (#435)', () => {
  it('returns status 404', () => {
    const result = buildSessionNotFoundResponse('abc12345xyz', new Map(), undefined)
    expect(result.status).toBe(404)
  })

  it('reports 0 active transports and empty samples when map is empty', () => {
    const result = buildSessionNotFoundResponse('abc12345xyz', new Map(), undefined)
    expect(result.logMessage).toContain('have 0 active transports')
    expect(result.logMessage).toContain('samples=[]')
  })

  it('includes the truncated requested sid prefix in the log line and body', () => {
    const result = buildSessionNotFoundResponse(
      'abc12345-this-is-the-full-id-and-we-do-not-want-to-leak-it',
      new Map(),
      undefined,
    )
    // First 8 chars then ellipsis.
    expect(result.logMessage).toContain('sessionId=abc12345')
    expect(result.body).toContain('abc12345')
    // Full id MUST NOT leak into the body (LLM-visible) or log.
    expect(result.body).not.toContain('this-is-the-full-id')
    expect(result.logMessage).not.toContain('this-is-the-full-id')
  })

  it('handles short requested sids without crashing (less than 8 chars)', () => {
    // Defensive: a malformed POST might pass a 3-char sid; truncate-to-8
    // shouldn't blow up.
    const result = buildSessionNotFoundResponse('abc', new Map(), undefined)
    expect(result.status).toBe(404)
    expect(result.logMessage).toContain('sessionId=abc')
  })

  it('includes the recovery instructions in the body', () => {
    const result = buildSessionNotFoundResponse('abc12345xyz', new Map(), undefined)
    expect(result.body).toContain('MCP transport session not found')
    expect(result.body).toContain('restart the Claude session inside CCC')
    expect(result.body).toContain('SSE connection')
    // No JSON wrapping -- plain text.
    expect(result.body.trim().startsWith('{')).toBe(false)
  })

  it('uses ASCII double-dash (not em dash) in the body', () => {
    // User-facing copy convention: no em dashes (obvious AI tell + the
    // LLM consumer is going to relay this text verbatim).
    const result = buildSessionNotFoundResponse('abc12345xyz', new Map(), undefined)
    expect(result.body).not.toContain('—')
  })

  it('lists samples (truncated to first 8 chars) when 2 transports are present', () => {
    const transports = new Map<string, unknown>([
      ['first-transport-sid-aaa', {}],
      ['second-transport-sid-bbb', {}],
    ])
    const result = buildSessionNotFoundResponse('missing-sid', transports, undefined)
    expect(result.logMessage).toContain('have 2 active transports')
    expect(result.logMessage).toContain('first-tr')
    expect(result.logMessage).toContain('second-t')
    // Full sids must NOT appear -- we only log the 8-char prefixes.
    expect(result.logMessage).not.toContain('first-transport-sid-aaa')
    expect(result.logMessage).not.toContain('second-transport-sid-bbb')
  })

  it('caps samples at 3 when more than 3 transports are present', () => {
    const transports = new Map<string, unknown>([
      ['aaaaaaaa-one', {}],
      ['bbbbbbbb-two', {}],
      ['cccccccc-three', {}],
      ['dddddddd-four', {}],
      ['eeeeeeee-five', {}],
    ])
    const result = buildSessionNotFoundResponse('missing-sid', transports, undefined)
    expect(result.logMessage).toContain('have 5 active transports')
    // First three should appear (Map iteration is insertion-ordered).
    expect(result.logMessage).toContain('aaaaaaaa')
    expect(result.logMessage).toContain('bbbbbbbb')
    expect(result.logMessage).toContain('cccccccc')
    // Fourth and fifth must NOT appear.
    expect(result.logMessage).not.toContain('dddddddd')
    expect(result.logMessage).not.toContain('eeeeeeee')
  })

  it('uses ua="unknown" when the user-agent header is absent', () => {
    const result = buildSessionNotFoundResponse('abc12345xyz', new Map(), undefined)
    expect(result.logMessage).toContain('ua="unknown"')
  })

  it('includes the verbatim user-agent header when present', () => {
    const result = buildSessionNotFoundResponse(
      'abc12345xyz',
      new Map(),
      'claude-cli/2.0.13',
    )
    expect(result.logMessage).toContain('ua="claude-cli/2.0.13"')
  })

  it('caps the user-agent at 64 chars to keep log lines bounded', () => {
    // Defensive: a malicious / runaway client could send a multi-kB UA.
    // We don't want a single bad request to spam multi-line log entries.
    const longUa = 'x'.repeat(200)
    const result = buildSessionNotFoundResponse('abc12345xyz', new Map(), longUa)
    // Extract the ua="..." substring and assert its inner length is <= 64.
    const match = result.logMessage.match(/ua="([^"]*)"/)
    expect(match).not.toBeNull()
    expect(match![1].length).toBeLessThanOrEqual(64)
  })

  it('begins the log line with the [vision-mcp] prefix used by neighbours', () => {
    // Consistency with the surrounding logInfo/logError calls in this
    // file -- the rebrand to "conductor" happened but the log prefix was
    // intentionally kept as [vision-mcp].
    const result = buildSessionNotFoundResponse('abc12345xyz', new Map(), undefined)
    expect(result.logMessage.startsWith('[vision-mcp]')).toBe(true)
  })

  it('mentions POST /messages 404 in the log line for greppability', () => {
    const result = buildSessionNotFoundResponse('abc12345xyz', new Map(), undefined)
    expect(result.logMessage).toContain('POST /messages 404')
  })
})
