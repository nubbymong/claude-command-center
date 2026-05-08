/**
 * P6.9 regression: parseSourceFromUrl correctly identifies the SSE
 * connection's originating provider via the ?source= query string.
 * The MCP server uses this to gate codex_review tool registration
 * (Codex sessions don't see the tool to avoid self-review confusion).
 */
import { describe, it, expect } from 'vitest'
import { parseSourceFromUrl } from '../../../src/main/vision-mcp-server'

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
