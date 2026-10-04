/**
 * [CI] The owner's 2026-10-04 answer: Sonnet 5 is priced at Anthropic's
 * published rate ($2 / MTok input, $10 output, $0.20 cache hits, $2.50 5-minute
 * cache writes; re-checked 2026-10-04), on the path Tokenomics prices a session:
 * a transcript turn parsed with getAllPricing()'s keys, stored, and costed by the
 * summary query's pricing CTE. Offline, so the registry fallback prices it.
 * The host-side half is tests/unit/model-registry-sonnet5-opus-hint.test.ts.
 *
 * Native: better-sqlite3 is built for Electron, so this runs under
 * `npm run test:unit:native` (CI and the test VM), not in the host's vitest run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openTkDb } from '../../../src/main/tokenomics/tk-db'
import { getAllPricing } from '../../../src/main/tokenomics/tk-pricing'
import { parseClaudeUsageLine } from '../../../src/main/tokenomics/tk-parse'

const M = 1_000_000

describe('a Sonnet 5 session in Tokenomics', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tksonnet5-')) })
  afterEach(() => {
    // Only the folder this test made: its own prefix, directly in the temp folder.
    if (path.basename(tmp).startsWith('tksonnet5-') && path.dirname(tmp) === os.tmpdir()) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('[CI] costs $2 / $10 per million, cache hits $0.20 and cache writes $2.50', () => {
    const pricing = getAllPricing()
    const line = JSON.stringify({ type: 'assistant', timestamp: new Date(Date.UTC(2026, 9, 4, 10)).toISOString(), sessionId: 's-sonnet5', requestId: 'r1', cwd: 'F:\\proj',
      message: { id: 'm1', model: 'claude-sonnet-5-20260601', usage: { input_tokens: M, output_tokens: M, cache_read_input_tokens: M, cache_creation_input_tokens: M } } })
    const turn = parseClaudeUsageLine(line, Object.keys(pricing))!
    expect(turn.priceModel).toBe('claude-sonnet-5')
    const db = openTkDb(path.join(tmp, 'tk.db'))
    try {
      db.insertEvents([turn])
      const summary = db.querySummary(pricing, {}, turn.ts + 86_400_000)
      expect(summary.kpis.lifeToDateCostUsd).toBeCloseTo(2 + 10 + 0.2 + 2.5, 6)
      expect(summary.cacheSplit.inputUsd).toBeCloseTo(2, 6)
      expect(summary.cacheSplit.outputUsd).toBeCloseTo(10, 6)
      expect(summary.cacheSplit.cacheReadUsd).toBeCloseTo(0.2, 6)
      expect(summary.cacheSplit.cacheCreateUsd).toBeCloseTo(2.5, 6)
      expect(summary.unpriced).toEqual([])
    } finally {
      db.close()
    }
  })
})
