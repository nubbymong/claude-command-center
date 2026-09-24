import { describe, it, expect, vi } from 'vitest'

// WP2 5a (ADR-009 round 1): a Codex review never outlives the session it
// serves. When pty-manager unregisters a session from codex_review (its PTY
// ended or is being replaced), the MCP server stops that session's reviews,
// which releases their reviewer-account leases.

const h = vi.hoisted(() => ({ aborted: [] as string[] }))

vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null, saveConfig: () => true }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res', registerSetupHandlers: () => {} }))
vi.mock('../../../src/main/clipboard-file', () => ({ mimeForImage: () => 'image/png' }))
vi.mock('../../../src/main/providers/codex/mcp-config', () => ({ removeConductorVisionFromCodexConfig: () => {} }))
vi.mock('../../../src/main/vision-manager', () => ({ getGlobalManager: () => null, startGlobalVision: () => {}, launchBrowser: () => {} }))
vi.mock('../../../src/main/update-watcher', () => ({ isPackagedApp: () => false, getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../../src/main/codex-review-mcp-tool', () => ({
  registerCodexReviewTool: () => {},
  abortCodexReviews: (sessionId: string) => { h.aborted.push(sessionId) },
}))

import { registerCodexReviewSession, unregisterCodexReviewSession } from '../../../src/main/conductor-mcp-server'

describe('codex_review sessions', () => {
  it('unregistering a session stops its in-flight reviews, and only its own', () => {
    registerCodexReviewSession('s1', '/proj/a')
    registerCodexReviewSession('s2', '/proj/b')
    expect(h.aborted).toEqual([])
    unregisterCodexReviewSession('s1')
    expect(h.aborted).toEqual(['s1'])
  })
})
