import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { StatuslineData } from '../../../src/shared/types'

// handleStatuslineUpdate now PREFERS the per-session spawn-time capture
// (getClaudeAccount) over the drifty statusline payload. Mock the capture
// module so the test controls what the reliable source returns, without
// touching the live ~/.claude.json.
const claudeAccountBySession = new Map<string, string>()
const claudeProfileBySession = new Map<string, string>()
vi.mock('../../../src/main/claude-account-identity', () => ({
  getClaudeAccount: (sessionId: string) => claudeAccountBySession.get(sessionId) ?? null,
  getClaudeAccountMap: () => claudeAccountBySession,
  getClaudeProfileId: (sessionId: string) => claudeProfileBySession.get(sessionId),
}))

// eslint-disable-next-line import/first -- import after vi.mock so the mock is applied
import {
  handleStatuslineUpdate,
  __resetTokenomicsForTests,
  __seedTokenomicsForTests,
} from '../../../src/main/tokenomics-manager'

// Copilot review on PR #31 (p9.17): live Claude attribution moved out of
// applyIdentityAtFlush (which over-stamped historic records) and into
// handleStatuslineUpdate, where the per-session statusline payload is the
// authoritative ground truth for the account a live session runs under.

describe('handleStatuslineUpdate -- live Claude attribution', () => {
  beforeEach(() => {
    __resetTokenomicsForTests()
    claudeAccountBySession.clear()
    claudeProfileBySession.clear()
  })

  function tick(over: Partial<StatuslineData>): StatuslineData {
    return { sessionId: 's1', costUsd: 1.23, ...over } as StatuslineData
  }

  it('stamps accountEmail on the live session from the statusline payload', () => {
    handleStatuslineUpdate(tick({ accountEmail: 'alice@example.com' }))
    expect(__seedTokenomicsForTests.read().sessions.s1.accountEmail).toBe('alice@example.com')
  })

  it('canonicalises the email (lowercase + trim)', () => {
    handleStatuslineUpdate(tick({ accountEmail: '  Alice@Example.COM  ' }))
    expect(__seedTokenomicsForTests.read().sessions.s1.accountEmail).toBe('alice@example.com')
  })

  it('never overwrites an already-attributed session (first identity wins)', () => {
    __seedTokenomicsForTests([
      { sessionId: 's1', projectDir: '/p', model: 'sonnet', totalInputTokens: 0, totalOutputTokens: 0,
        totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalCostUsd: 0, messageCount: 0,
        firstTimestamp: '2026-01-01T00:00:00Z', lastTimestamp: '2026-01-01T00:00:00Z',
        accountEmail: 'first@example.com' },
    ])
    handleStatuslineUpdate(tick({ accountEmail: 'second@example.com' }))
    expect(__seedTokenomicsForTests.read().sessions.s1.accountEmail).toBe('first@example.com')
  })

  it('leaves accountEmail undefined when the payload carries none', () => {
    handleStatuslineUpdate(tick({}))
    expect(__seedTokenomicsForTests.read().sessions.s1.accountEmail).toBeUndefined()
  })

  // Copilot review on PR #31 (p9.17.1): nullish (not falsy) guard.
  it('stamps an identity-only tick that carries no cost metrics', () => {
    handleStatuslineUpdate({ sessionId: 's1', accountEmail: 'idonly@example.com' } as StatuslineData)
    expect(__seedTokenomicsForTests.read().sessions.s1.accountEmail).toBe('idonly@example.com')
  })

  it('does not drop a legitimate zero-cost tick', () => {
    handleStatuslineUpdate({ sessionId: 's1', costUsd: 0, accountEmail: 'zero@example.com' } as StatuslineData)
    const r = __seedTokenomicsForTests.read().sessions.s1
    expect(r).toBeDefined()
    expect(r.accountEmail).toBe('zero@example.com')
  })

  // ── reliable spawn-time capture is preferred over the drifty payload ──

  it('PREFERS the captured account over the statusline payload', () => {
    claudeAccountBySession.set('s1', 'captured@example.com')
    handleStatuslineUpdate(tick({ accountEmail: 'drifty@example.com' }))
    expect(__seedTokenomicsForTests.read().sessions.s1.accountEmail).toBe('captured@example.com')
  })

  it('canonicalises the captured account (lowercase + trim)', () => {
    claudeAccountBySession.set('s1', '  Captured@Example.COM  ')
    handleStatuslineUpdate(tick({ accountEmail: 'drifty@example.com' }))
    expect(__seedTokenomicsForTests.read().sessions.s1.accountEmail).toBe('captured@example.com')
  })

  it('falls back to the statusline payload when there is no capture', () => {
    // capture map empty -> use the payload
    handleStatuslineUpdate(tick({ accountEmail: 'fallback@example.com' }))
    expect(__seedTokenomicsForTests.read().sessions.s1.accountEmail).toBe('fallback@example.com')
  })

  it('does NOT overwrite an already-attributed session even when a capture exists', () => {
    __seedTokenomicsForTests([
      { sessionId: 's1', projectDir: '/p', model: 'sonnet', totalInputTokens: 0, totalOutputTokens: 0,
        totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalCostUsd: 0, messageCount: 0,
        firstTimestamp: '2026-01-01T00:00:00Z', lastTimestamp: '2026-01-01T00:00:00Z',
        accountEmail: 'first@example.com' },
    ])
    claudeAccountBySession.set('s1', 'captured@example.com')
    handleStatuslineUpdate(tick({ accountEmail: 'drifty@example.com' }))
    expect(__seedTokenomicsForTests.read().sessions.s1.accountEmail).toBe('first@example.com')
  })

  // ── profileId stamp (stable account key, independent of email/name changes) ──

  it('stamps profileId on the live session from the spawn capture', () => {
    claudeProfileBySession.set('s1', 'prof-abc')
    handleStatuslineUpdate(tick({ accountEmail: 'alice@example.com' }))
    expect(__seedTokenomicsForTests.read().sessions.s1.profileId).toBe('prof-abc')
  })

  it('leaves profileId undefined for a default session (no capture)', () => {
    handleStatuslineUpdate(tick({ accountEmail: 'alice@example.com' }))
    expect(__seedTokenomicsForTests.read().sessions.s1.profileId).toBeUndefined()
  })

  it('never overwrites an existing profileId (first capture wins)', () => {
    __seedTokenomicsForTests([
      { sessionId: 's1', projectDir: '/p', model: 'sonnet', totalInputTokens: 0, totalOutputTokens: 0,
        totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalCostUsd: 0, messageCount: 0,
        firstTimestamp: '2026-01-01T00:00:00Z', lastTimestamp: '2026-01-01T00:00:00Z',
        profileId: 'orig-prof' },
    ])
    claudeProfileBySession.set('s1', 'new-prof')
    handleStatuslineUpdate(tick({}))
    expect(__seedTokenomicsForTests.read().sessions.s1.profileId).toBe('orig-prof')
  })
})
