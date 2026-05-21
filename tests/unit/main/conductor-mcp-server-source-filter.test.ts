/**
 * P6.9 regression: parseSourceFromUrl correctly identifies the SSE
 * connection's originating provider via the ?source= query string.
 * The MCP server uses this to gate codex_review tool registration
 * (Codex sessions don't see the tool to avoid self-review confusion).
 *
 * P7.7.10 additions: parseCccSessionIdFromUrl returns the CCC session id
 * baked into the per-session --mcp-config URL by writeLocalSessionMcpConfig.
 * Returning null means the caller falls back to the tool's arg-supplied id.
 */
import { describe, it, expect } from 'vitest'
import { parseSourceFromUrl, parseCccSessionIdFromUrl } from '../../../src/main/conductor-mcp-server'

describe('parseSourceFromUrl (P6.9)', () => {
  it('returns "codex" for ?source=codex', () => {
    expect(parseSourceFromUrl('/sse?source=codex')).toBe('codex')
  })

  it('returns "claude" for ?source=claude', () => {
    expect(parseSourceFromUrl('/sse?source=claude')).toBe('claude')
  })

  it('returns "unknown" when source param is absent', () => {
    expect(parseSourceFromUrl('/sse')).toBe('unknown')
  })

  it('returns "unknown" for an unrecognised source value', () => {
    expect(parseSourceFromUrl('/sse?source=other')).toBe('unknown')
  })

  it('returns "unknown" for a malformed URL', () => {
    // The function uses URL constructor which throws on invalid input;
    // the catch block returns 'unknown'.
    expect(parseSourceFromUrl('not a url')).toBe('unknown')
  })
})

describe('parseCccSessionIdFromUrl (P7.7.10)', () => {
  it('returns the sessionId for ?cccSessionId=<sid>', () => {
    expect(parseCccSessionIdFromUrl('/sse?cccSessionId=mpg2abc123')).toBe('mpg2abc123')
  })

  it('returns null when cccSessionId param is absent', () => {
    expect(parseCccSessionIdFromUrl('/sse')).toBe(null)
    expect(parseCccSessionIdFromUrl('/sse?source=claude')).toBe(null)
  })

  it('returns null for an empty cccSessionId value', () => {
    expect(parseCccSessionIdFromUrl('/sse?cccSessionId=')).toBe(null)
  })

  it('returns null for a malformed URL', () => {
    expect(parseCccSessionIdFromUrl('not a url')).toBe(null)
  })

  it('decodes percent-encoded characters in the sessionId', () => {
    // writeLocalSessionMcpConfig uses encodeURIComponent for safety, so the
    // URL constructor's auto-decoding round-trips back to the original sid.
    expect(parseCccSessionIdFromUrl('/sse?cccSessionId=sess%2Bone')).toBe('sess+one')
  })

  it('coexists with the source param (both readable from the same URL)', () => {
    const url = '/sse?source=claude&cccSessionId=mpg2xyz'
    expect(parseSourceFromUrl(url)).toBe('claude')
    expect(parseCccSessionIdFromUrl(url)).toBe('mpg2xyz')
  })

  it('returns null when cccSessionId exceeds the 256-char defensive cap', () => {
    // CCC session ids are nanoid-style ~12 chars in practice; a 300-char
    // value is almost certainly malformed and shouldn't propagate into
    // ACL lookups or error-message logs.
    const huge = 'x'.repeat(300)
    expect(parseCccSessionIdFromUrl(`/sse?cccSessionId=${huge}`)).toBe(null)
  })
})
