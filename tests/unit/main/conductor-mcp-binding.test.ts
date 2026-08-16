/**
 * GHSA-f3wv: POST /messages must bind the target transport to the AUTHENTICATED
 * session, not merely to any valid token. `authorizeMessagePost` is the pure
 * decision the request handler delegates to; these pin the security branch —
 * a session may only post to a transport it owns — without an http.Server.
 */
import { describe, it, expect } from 'vitest'
import { authorizeMessagePost } from '../../../src/main/conductor-mcp-server'

const fakeTransport = { handlePostMessage: async () => {} }

describe('authorizeMessagePost (GHSA-f3wv transport binding)', () => {
  it('allows a session to post to a transport it OWNS', () => {
    const transports = new Map([['t-A', fakeTransport]])
    const owners = new Map([['t-A', 'session-A']])
    const d = authorizeMessagePost('session-A', 't-A', transports, owners, undefined)
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.transport).toBe(fakeTransport)
  })

  it('REJECTS a valid session posting to a transport owned by ANOTHER session', () => {
    // The whole vulnerability: authenticated as A (a token A legitimately holds),
    // but naming B's transport id in the query string. Must not be routed.
    const transports = new Map([['t-B', fakeTransport]])
    const owners = new Map([['t-B', 'session-B']])
    const d = authorizeMessagePost('session-A', 't-B', transports, owners, undefined)
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.status).toBe(404)
  })

  it('a cross-session rejection is INDISTINGUISHABLE from an unknown transport for the same sid (no existence oracle)', () => {
    const existsOwnedByB = authorizeMessagePost('session-A', 't-B', new Map([['t-B', fakeTransport]]), new Map([['t-B', 'session-B']]), 'ua')
    const doesNotExist = authorizeMessagePost('session-A', 't-B', new Map(), new Map(), 'ua')
    expect(existsOwnedByB.ok).toBe(false)
    expect(doesNotExist.ok).toBe(false)
    if (!existsOwnedByB.ok && !doesNotExist.ok) {
      expect(existsOwnedByB.status).toBe(doesNotExist.status)
      expect(existsOwnedByB.body).toBe(doesNotExist.body) // identical body → no oracle
    }
  })

  it('logs a DISTINCT cross-session line so a genuine attempt stays visible in the logs', () => {
    const d = authorizeMessagePost('session-A', 't-B', new Map([['t-B', fakeTransport]]), new Map([['t-B', 'session-B']]), 'claude-cli/2')
    expect(d.ok).toBe(false)
    if (!d.ok) {
      expect(d.logMessage).toContain('may not post to a transport it does not own')
      expect(d.logMessage).not.toContain('unknown transport')
    }
  })

  it('returns an actionable 404 for a genuinely unknown transport id', () => {
    const d = authorizeMessagePost('session-A', 't-missing', new Map(), new Map(), undefined)
    expect(d.ok).toBe(false)
    if (!d.ok) {
      expect(d.status).toBe(404)
      expect(d.logMessage).toContain('unknown transport')
    }
  })

  it('returns 400 when no sessionId is supplied', () => {
    const d = authorizeMessagePost('session-A', null, new Map(), new Map(), undefined)
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.status).toBe(400)
  })

  it('rejects a transport with NO recorded owner (fail closed)', () => {
    // An ownerless transport must never be reachable — the owner compare treats
    // undefined !== any real session, so it 404s.
    const transports = new Map([['t-orphan', fakeTransport]])
    const owners = new Map<string, string>() // no owner recorded
    const d = authorizeMessagePost('session-A', 't-orphan', transports, owners, undefined)
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.status).toBe(404)
  })

  it('fails closed when there is no authenticated session (empty must not equal empty)', () => {
    // Unreachable past the 401 gate, but the ownership compare must never be
    // empty===empty: an empty authedSession must not reach even a (pathological)
    // empty-owner transport.
    const transports = new Map([['t-x', fakeTransport]])
    const owners = new Map([['t-x', '']])
    const d = authorizeMessagePost('', 't-x', transports, owners, undefined)
    expect(d.ok).toBe(false)
  })
})
