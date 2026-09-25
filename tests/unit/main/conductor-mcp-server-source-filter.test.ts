/**
 * The provider-facing helpers of the conductor MCP server: the session id
 * parsed from the transport URL, which review tool each provider is offered,
 * and the stateless /mcp serving path.
 *
 * P7.7.10 additions: parseCccSessionIdFromUrl returns the CCC session id
 * baked into the per-session --mcp-config URL by writeLocalSessionMcpConfig.
 * Returning null means the caller falls back to the tool's arg-supplied id.
 */
import { describe, it, expect } from 'vitest'
import { parseCccSessionIdFromUrl, offeredReviewTool, serveStatelessMcp } from '../../../src/main/conductor-mcp-server'

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

  it('reads the session id beside other query params', () => {
    const url = '/sse?source=claude&cccSessionId=mpg2xyz'
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
  const on = { toolsMaster: true, codexReviewOn: true, codexEnabled: true, codexReviewReady: () => true, claudeReviewOn: true, claudeReviewReady: () => true }
  it('a Claude or unknown connection gets codex_review while its toggles allow and a Codex review could run; never claude_review', () => {
    for (const source of ['claude', 'unknown'] as const) {
      expect(offeredReviewTool(source, on)).toBe('codex_review')
      expect(offeredReviewTool(source, { ...on, codexReviewOn: false })).toBeNull()
      expect(offeredReviewTool(source, { ...on, codexEnabled: false })).toBeNull()
      // No Codex account could review now: not offered (WP2 commit 6).
      expect(offeredReviewTool(source, { ...on, codexReviewReady: () => false })).toBeNull()
      // The Claude review switch does not decide it.
      expect(offeredReviewTool(source, { ...on, claudeReviewOn: false })).toBe('codex_review')
    }
  })
  it('a Codex connection gets claude_review only while a Claude review is ready and the Conductor tools are on; never codex_review', () => {
    expect(offeredReviewTool('codex', on)).toBe('claude_review')
    expect(offeredReviewTool('codex', { ...on, claudeReviewReady: () => false })).toBeNull()
    expect(offeredReviewTool('codex', { ...on, toolsMaster: false })).toBeNull()
    // Its own switch (Settings, Built-in tools) withdraws it.
    expect(offeredReviewTool('codex', { ...on, claudeReviewOn: false })).toBeNull()
    // The codex_review toggles do not decide it.
    expect(offeredReviewTool('codex', { ...on, codexReviewOn: false, codexEnabled: false })).toBe('claude_review')
  })
  it('asks whether a Claude review is ready only for a Codex connection, and a Codex review only for the others', () => {
    let asked = 0
    offeredReviewTool('claude', { ...on, claudeReviewReady: () => { asked++; return true } })
    expect(asked).toBe(0)
    let askedCodex = 0
    offeredReviewTool('codex', { ...on, codexReviewReady: () => { askedCodex++; return true } })
    expect(askedCodex).toBe(0)
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
