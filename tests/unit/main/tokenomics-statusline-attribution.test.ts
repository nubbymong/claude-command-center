import { describe, it, expect, beforeEach } from 'vitest'
import {
  handleStatuslineUpdate,
  __resetTokenomicsForTests,
  __seedTokenomicsForTests,
} from '../../../src/main/tokenomics-manager'
import type { StatuslineData } from '../../../src/shared/types'

// Copilot review on PR #31 (p9.17): live Claude attribution moved out of
// applyIdentityAtFlush (which over-stamped historic records) and into
// handleStatuslineUpdate, where the per-session statusline payload is the
// authoritative ground truth for the account a live session runs under.

describe('handleStatuslineUpdate -- live Claude attribution', () => {
  beforeEach(() => {
    __resetTokenomicsForTests()
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
})
