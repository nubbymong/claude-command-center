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
import { parseSourceFromUrl, parseCccSessionIdFromUrl, offeredReviewTool, serveStatelessMcp } from '../../../src/main/conductor-mcp-server'

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

  // P9.6: the /mcp streamable-HTTP route reuses parseSourceFromUrl so the
  // same source-based codex_review gate (`if source !== 'codex'`) applies.
  // Without this Codex sessions reaching the server via /mcp would see
  // codex_review and could recursively review themselves.
  it('returns "codex" for /mcp?source=codex (streamable HTTP route)', () => {
    expect(parseSourceFromUrl('/mcp?source=codex')).toBe('codex')
  })

  it('returns "claude" for /mcp?source=claude', () => {
    expect(parseSourceFromUrl('/mcp?source=claude')).toBe('claude')
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

// WP2 commit 5b (owner decision 3): each session is offered only the OTHER
// provider's reviewer, and claude_review only while a Claude review could be
// prepared now.
describe('offeredReviewTool', () => {
  const on = { toolsMaster: true, codexReviewOn: true, codexEnabled: true, claudeReviewReady: () => true }
  it('a Claude or unknown connection gets codex_review while its toggles allow; never claude_review', () => {
    for (const source of ['claude', 'unknown'] as const) {
      expect(offeredReviewTool(source, on)).toBe('codex_review')
      expect(offeredReviewTool(source, { ...on, codexReviewOn: false })).toBeNull()
      expect(offeredReviewTool(source, { ...on, codexEnabled: false })).toBeNull()
    }
  })
  it('a Codex connection gets claude_review only while a Claude review is ready and the Conductor tools are on; never codex_review', () => {
    expect(offeredReviewTool('codex', on)).toBe('claude_review')
    expect(offeredReviewTool('codex', { ...on, claudeReviewReady: () => false })).toBeNull()
    expect(offeredReviewTool('codex', { ...on, toolsMaster: false })).toBeNull()
    // The codex_review toggles do not decide it.
    expect(offeredReviewTool('codex', { ...on, codexReviewOn: false, codexEnabled: false })).toBe('claude_review')
  })
  it('asks whether a Claude review is ready only for a Codex connection', () => {
    let asked = 0
    offeredReviewTool('claude', { ...on, claudeReviewReady: () => { asked++; return true } })
    expect(asked).toBe(0)
  })
})

// ADR-009 confirmation (5b): a stateless /mcp exchange closes its server as
// soon as the client drops the request -- while a long call (a review) is
// still inside handleRequest -- which aborts that call; not after it has run
// to its own deadline.
describe('serveStatelessMcp', () => {
  it('a client that drops the request closes the transport and the server while the call is still running', async () => {
    const closed: string[] = []
    const listeners: Array<() => void> = []
    let finish!: () => void
    const server = { connect: async () => {}, close: () => { closed.push('server') } }
    const transport = { handleRequest: () => new Promise<void>((r) => { finish = r }), close: () => { closed.push('transport') } }
    const res = { on: (_e: 'close', fn: () => void) => { listeners.push(fn) } }
    const p = serveStatelessMcp(server, transport, {}, res)
    await Promise.resolve()
    await Promise.resolve()
    expect(listeners).toHaveLength(1)
    listeners[0]()
    expect(closed).toEqual(['transport', 'server'])
    finish()
    await p
  })
})
