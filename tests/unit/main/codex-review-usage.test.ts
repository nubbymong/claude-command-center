import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock setup-handlers so the module sees a controllable resources dir.
let testResourcesDir: string
vi.mock('../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => testResourcesDir,
}))

import {
  recordReview,
  getUsage,
  disposeSession,
  __resetForTests,
} from '../../../src/main/codex-review-usage'

// Matches the source's todayLocalIso() so the test passes regardless of
// the developer's UTC offset. Using `new Date().toISOString().slice(0, 10)`
// breaks for ~1 hour/day in timezones east of UTC near midnight (the test
// was flaky in UK BST when run between 00:00 and 01:00 local time).
function todayLocalIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('codex-review-usage', () => {
  beforeEach(() => {
    testResourcesDir = mkdtempSync(join(tmpdir(), 'ccc-codex-review-'))
    __resetForTests()
  })

  afterEach(() => {
    rmSync(testResourcesDir, { recursive: true, force: true })
  })

  it('returns null for an unknown session', () => {
    expect(getUsage('sess-unknown')).toBeNull()
  })

  it('records a review and round-trips via getUsage', () => {
    recordReview('sess-1', {
      inputTokens: 1200,
      outputTokens: 800,
      rateLimit: { usedPercent: 0.42, resetsAt: 1714850000, planType: 'plus' },
    })
    const u = getUsage('sess-1')
    expect(u).not.toBeNull()
    expect(u!.sessionId).toBe('sess-1')
    expect(u!.reviewCount).toBe(1)
    expect(u!.totalInputTokens).toBe(1200)
    expect(u!.totalOutputTokens).toBe(800)
    expect(u!.lastRateLimitWindow?.usedPercent).toBe(0.42)
    expect(u!.lastRateLimitWindow?.planType).toBe('plus')
    expect(typeof u!.lastReviewAt).toBe('number')
  })

  it('accumulates multiple reviews in the same session', () => {
    recordReview('sess-1', { inputTokens: 100, outputTokens: 50, rateLimit: null })
    recordReview('sess-1', { inputTokens: 200, outputTokens: 75, rateLimit: null })
    const u = getUsage('sess-1')!
    expect(u.reviewCount).toBe(2)
    expect(u.totalInputTokens).toBe(300)
    expect(u.totalOutputTokens).toBe(125)
  })

  it('keeps separate sessions isolated', () => {
    recordReview('sess-A', { inputTokens: 100, outputTokens: 50, rateLimit: null })
    recordReview('sess-B', { inputTokens: 999, outputTokens: 111, rateLimit: null })
    expect(getUsage('sess-A')!.totalInputTokens).toBe(100)
    expect(getUsage('sess-B')!.totalInputTokens).toBe(999)
  })

  it('disposeSession clears in-memory state but preserves disk shard', () => {
    recordReview('sess-1', { inputTokens: 100, outputTokens: 50, rateLimit: null })
    disposeSession('sess-1')
    expect(getUsage('sess-1')).toBeNull()
    const shardPath = join(testResourcesDir, 'tokenomics', 'codex-review-by-day.json')
    expect(existsSync(shardPath)).toBe(true)
    const shard = JSON.parse(readFileSync(shardPath, 'utf-8'))
    const today = todayLocalIso()
    expect(shard.byDay[today]?.reviewCount).toBe(1)
    expect(shard.byDay[today]?.totalInputTokens).toBe(100)
  })

  it('persists across module re-init via the disk shard', async () => {
    recordReview('sess-1', { inputTokens: 250, outputTokens: 100, rateLimit: null })
    __resetForTests()  // simulate restart -- in-memory map cleared, shard remains
    const today = todayLocalIso()
    // Re-record into a fresh session; daily aggregate must accumulate, not reset.
    recordReview('sess-2', { inputTokens: 50, outputTokens: 25, rateLimit: null })
    const shardPath = join(testResourcesDir, 'tokenomics', 'codex-review-by-day.json')
    const shard = JSON.parse(readFileSync(shardPath, 'utf-8'))
    expect(shard.byDay[today].reviewCount).toBe(2)
    expect(shard.byDay[today].totalInputTokens).toBe(300)
  })
})
