/**
 * R-DEC-3: per-launch secret for the Conductor MCP server.
 *
 * The MCP server listens on a loopback port with NO authentication and
 * exposes vision_* tools (including vision_eval -- arbitrary JS in the
 * embedded browser) plus cross-session actions. Any local process could
 * drive it. We now mint a random secret at boot and require it on EVERY
 * request, accepted via either an `Authorization: Bearer <secret>` header
 * OR a `?token=<secret>` query param (registration writers can only emit a
 * URL, so the query form is what Claude/Codex actually use).
 *
 * isAuthorizedMcpRequest is a pure helper (no I/O, no http types) so the
 * auth contract can be unit-tested directly -- the same idiom as
 * parseSourceFromUrl / buildSessionNotFoundResponse in this module.
 */
import { describe, it, expect } from 'vitest'
import {
  isAuthorizedMcpRequest,
  getConductorMcpSecret,
} from '../../../src/main/conductor-mcp-server'

const SECRET = getConductorMcpSecret()

describe('getConductorMcpSecret (R-DEC-3)', () => {
  it('is a 64-char hex string (crypto.randomBytes(32))', () => {
    expect(SECRET).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable for the process lifetime (minted once, not per-call)', () => {
    expect(getConductorMcpSecret()).toBe(SECRET)
  })
})

describe('isAuthorizedMcpRequest (R-DEC-3)', () => {
  it('rejects a request with no token (no header, no query param)', () => {
    expect(isAuthorizedMcpRequest('/sse', undefined, SECRET)).toBe(false)
  })

  it('rejects a request with an empty Authorization header', () => {
    expect(isAuthorizedMcpRequest('/sse', '', SECRET)).toBe(false)
  })

  it('rejects a wrong token via the Authorization header', () => {
    expect(isAuthorizedMcpRequest('/sse', 'Bearer deadbeef', SECRET)).toBe(false)
  })

  it('rejects a wrong token via the ?token= query param', () => {
    expect(isAuthorizedMcpRequest('/sse?token=deadbeef', undefined, SECRET)).toBe(false)
  })

  it('rejects a token that is a prefix of the secret (length mismatch)', () => {
    expect(isAuthorizedMcpRequest('/sse', `Bearer ${SECRET.slice(0, 32)}`, SECRET)).toBe(false)
  })

  it('rejects a token longer than the secret', () => {
    expect(isAuthorizedMcpRequest('/sse', `Bearer ${SECRET}extra`, SECRET)).toBe(false)
  })

  it('accepts the correct token via the Authorization: Bearer header', () => {
    expect(isAuthorizedMcpRequest('/sse', `Bearer ${SECRET}`, SECRET)).toBe(true)
  })

  it('accepts the correct token via the ?token= query param', () => {
    expect(isAuthorizedMcpRequest(`/sse?token=${SECRET}`, undefined, SECRET)).toBe(true)
  })

  it('accepts the correct token via ?token= alongside other query params', () => {
    expect(
      isAuthorizedMcpRequest(
        `/sse?source=claude&cccSessionId=sid1&token=${SECRET}`,
        undefined,
        SECRET,
      ),
    ).toBe(true)
  })

  it('accepts the correct token via query param on the /mcp route too', () => {
    expect(isAuthorizedMcpRequest(`/mcp?source=codex&token=${SECRET}`, undefined, SECRET)).toBe(true)
  })

  it('is case-insensitive on the Bearer scheme keyword', () => {
    expect(isAuthorizedMcpRequest('/sse', `bearer ${SECRET}`, SECRET)).toBe(true)
  })

  it('does not crash on a malformed URL (treats it as unauthenticated)', () => {
    expect(isAuthorizedMcpRequest('not a url', undefined, SECRET)).toBe(false)
  })

  it('prefers a valid header even when the query token is wrong', () => {
    expect(isAuthorizedMcpRequest('/sse?token=wrong', `Bearer ${SECRET}`, SECRET)).toBe(true)
  })
})
