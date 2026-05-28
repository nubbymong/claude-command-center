// tests/unit/standing-approvals-store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
const store = new Map<string, unknown>()
vi.mock('../../src/main/channel-storage', () => ({
  readJsonFile: <T>(n: string, seed: () => T): T => (store.has(n) ? store.get(n) as T : seed()),
  writeJsonFile: (n: string, d: unknown) => { store.set(n, d); return true },
}))
const { addApproval, loadApprovals, clearUntilRestart, matchApproval } = await import('../../src/main/standing-approvals-store')

describe('standing-approvals-store', () => {
  beforeEach(() => store.clear())
  it('addApproval(1h) computes expiresAt ~1h out; matchApproval matches the tool', () => {
    const now = Date.now()
    addApproval('Bash', '1h', now)
    const list = loadApprovals(now)
    expect(list).toHaveLength(1)
    expect(list[0].expiresAt).toBe(now + 3600_000)
    expect(matchApproval('Bash', now)).toBe(true)
    expect(matchApproval('Edit', now)).toBe(false)
  })
  it('wildcard * matches any tool', () => {
    const now = Date.now()
    addApproval('*', '1h', now)
    expect(matchApproval('WebFetch', now)).toBe(true)
  })
  it('loadApprovals prunes TTL-expired entries', () => {
    const now = Date.now()
    addApproval('Bash', '1h', now)
    expect(loadApprovals(now + 3600_001)).toHaveLength(0)
  })
  it('clearUntilRestart removes only until-restart entries', () => {
    const now = Date.now()
    addApproval('Bash', '1h', now)
    addApproval('Edit', 'until-restart', now)
    clearUntilRestart()
    const list = loadApprovals(now)
    expect(list.map(a => a.tool)).toEqual(['Bash'])
  })
})
