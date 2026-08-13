/**
 * GHSA-q83v-phcc-hgv4: per-session MCP token binding.
 *
 * The server used one install-wide secret to authorise every request but took
 * the acted-for session from an unauthenticated `cccSessionId` query param, so
 * any holder of the (universally-distributed) secret could claim ANY session
 * and inherit its bound tools. The fix binds the credential to the session:
 * each session's token is HMAC(secret, sessionId), and the server derives the
 * bound session from the authenticated token — never from the query.
 *
 * These pin the security property directly on the pure functions. The
 * cross-session-rejection case was verified to FAIL when mcpSessionToken is
 * made session-independent (the old model).
 */
import { describe, it, expect } from 'vitest'
import {
  authenticateMcpRequest,
  mcpSessionToken,
  getConductorMcpSecret,
} from '../../../src/main/conductor-mcp-server'

const A = 'sessionAAA'
const B = 'sessionBBB'
const TOKEN_A = mcpSessionToken(A)
const TOKEN_B = mcpSessionToken(B)

describe('mcpSessionToken', () => {
  it('is a 64-char hex HMAC', () => {
    expect(TOKEN_A).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic per session and distinct across sessions', () => {
    expect(mcpSessionToken(A)).toBe(TOKEN_A)
    expect(TOKEN_A).not.toBe(TOKEN_B)
  })

  it('is NOT the install secret — the secret is a key, never a distributed token', () => {
    expect(TOKEN_A).not.toBe(getConductorMcpSecret())
  })
})

describe('authenticateMcpRequest — binds the session to the token', () => {
  it('authenticates a session presenting its OWN token (query form) and returns that session', () => {
    expect(authenticateMcpRequest(`/sse?cccSessionId=${A}&token=${TOKEN_A}`, undefined)).toBe(A)
  })

  it('authenticates via the Authorization: Bearer header too (Codex path)', () => {
    expect(authenticateMcpRequest(`/mcp?source=codex&cccSessionId=${A}`, `Bearer ${TOKEN_A}`)).toBe(A)
  })

  it('THE FIX: session A\'s token cannot claim session B', () => {
    // The exact PoC from the advisory: a valid, non-owned token paired with
    // another session's id. Pre-fix this returned true against the install
    // secret; now the token must be B's own.
    expect(authenticateMcpRequest(`/sse?cccSessionId=${B}&token=${TOKEN_A}`, undefined)).toBeNull()
    expect(authenticateMcpRequest(`/mcp?cccSessionId=${B}`, `Bearer ${TOKEN_A}`)).toBeNull()
  })

  it('rejects the install secret itself as a token (it is no longer a credential)', () => {
    expect(authenticateMcpRequest(`/sse?cccSessionId=${A}&token=${getConductorMcpSecret()}`, undefined)).toBeNull()
  })

  it('rejects a request with a valid token but no cccSessionId (nothing to bind to)', () => {
    expect(authenticateMcpRequest(`/sse?token=${TOKEN_A}`, undefined)).toBeNull()
  })

  it('rejects a correct cccSessionId with no token', () => {
    expect(authenticateMcpRequest(`/sse?cccSessionId=${A}`, undefined)).toBeNull()
  })

  it('rejects a wrong token for the claimed session', () => {
    expect(authenticateMcpRequest(`/sse?cccSessionId=${A}&token=deadbeef`, undefined)).toBeNull()
  })

  it('resolves the /messages follow-up shape (token + cccSessionId + transport sessionId)', () => {
    // What SSEServerTransport actually POSTs: our baked token+cccSessionId, plus
    // the SDK's own transport sessionId. The gate keys off cccSessionId.
    expect(
      authenticateMcpRequest(`/messages?token=${TOKEN_A}&cccSessionId=${A}&sessionId=transport-xyz`, undefined),
    ).toBe(A)
  })

  it('returns null for a malformed URL rather than throwing', () => {
    expect(authenticateMcpRequest('not a url', undefined)).toBeNull()
    expect(authenticateMcpRequest(undefined, undefined)).toBeNull()
  })
})
