import { describe, it, expect, vi } from 'vitest'

// WP2 5a (ADR-009 round 1): a review never outlives the session it serves.
// When pty-manager unregisters a session (its PTY ended or is being
// replaced), the MCP server stops that session's reviews, which releases
// their reviewer-account leases -- for codex_review (a Claude session) and,
// since 5b, claude_review (a Codex session) alike.

const h = vi.hoisted(() => ({ aborted: [] as string[] }))

vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null, saveConfig: () => true }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res', registerSetupHandlers: () => {} }))
vi.mock('../../../src/main/clipboard-file', () => ({ mimeForImage: () => 'image/png' }))
vi.mock('../../../src/main/providers/codex/mcp-config', () => ({ removeConductorVisionFromCodexConfig: () => {} }))
vi.mock('../../../src/main/vision-manager', () => ({ getGlobalManager: () => null, startGlobalVision: () => {}, launchBrowser: () => {} }))
vi.mock('../../../src/main/update-watcher', () => ({ isPackagedApp: () => false, getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../../src/main/codex-review-mcp-tool', () => ({
  registerCodexReviewTool: () => {},
  registerClaudeReviewTool: () => {},
  abortSessionReviews: (sessionId: string) => { h.aborted.push(sessionId) },
  cancelReviewRequest: () => false,
}))

import { registerCodexReviewSession, registerClaudeReviewSession, unregisterCodexReviewSession, reviewRegistrationOf } from '../../../src/main/conductor-mcp-server'

describe('codex_review sessions', () => {
  it('unregistering a session stops its in-flight reviews, and only its own', () => {
    registerCodexReviewSession('s1', '/proj/a')
    registerCodexReviewSession('s2', '/proj/b')
    expect(h.aborted).toEqual([])
    unregisterCodexReviewSession('s1')
    expect(h.aborted).toEqual(['s1'])
  })
})

describe('claude_review sessions (WP2 5b)', () => {
  it('unregistering a Codex session stops its in-flight Claude reviews too', () => {
    h.aborted.length = 0
    registerClaudeReviewSession('c1', '/proj/c')
    unregisterCodexReviewSession('c1')
    expect(h.aborted).toEqual(['c1'])
  })
})

// ADR-009 round 1 (5b): a session is registered for ONE reviewer at a time.
// A respawn that switches its provider (Claude to Codex or back) leaves no
// registration for the other tool behind, whatever the order.
describe('one review registration per session (WP2 5b)', () => {
  it('registering for one tool drops the other; unregistering drops both', () => {
    registerCodexReviewSession('x1', '/proj/a')
    registerClaudeReviewSession('x1', '/proj/b')
    expect(reviewRegistrationOf('x1')).toEqual({ tools: ['claude_review'], cwd: '/proj/b' })
    registerCodexReviewSession('x1', '/proj/c')
    expect(reviewRegistrationOf('x1')).toEqual({ tools: ['codex_review'], cwd: '/proj/c' })
    unregisterCodexReviewSession('x1')
    expect(reviewRegistrationOf('x1')).toBeNull()
    registerClaudeReviewSession('x2', '/proj/d')
    unregisterCodexReviewSession('x2')
    expect(reviewRegistrationOf('x2')).toBeNull()
  })
})
