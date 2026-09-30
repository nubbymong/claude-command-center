/**
 * P3.12: a Codex conversation two tabs both had (one after the other, each
 * session's slot its own run, the later one read from its start) is in the
 * index once per session; search lists each of its turns once. A turn is
 * the same when its role, its record time and its words are (the rollout's
 * own timestamp, so a turn typed twice is two). Claude's hits are listed as
 * before.
 */
import { describe, it, expect } from 'vitest'
import { dedupeSearchHits } from '../../../src/main/logging/search-dedupe'

const hit = (runId: number, idx: number, provider: string, role: string, ts: number, content: string, sessionId = `s${runId}`) =>
  ({ runId, idx, configId: null, sessionId, snippet: `[${content}]`, provider, role, ts, content })

describe('search lists a Codex turn once (P3.12)', () => {
  it('the same Codex turn indexed in two sessions is listed once, the best-ranked first; the hits keep their own shape', () => {
    const out = dedupeSearchHits([
      hit(1, 0, 'codex', 'user', 100, 'fix the flaky test'),
      hit(2, 0, 'codex', 'user', 100, 'fix the flaky test'),
      hit(2, 1, 'codex', 'assistant', 101, 'done'),
      hit(1, 1, 'codex', 'assistant', 101, 'done'),
    ], 50)
    expect(out).toEqual([
      { runId: 1, idx: 0, configId: null, sessionId: 's1', snippet: '[fix the flaky test]' },
      { runId: 2, idx: 1, configId: null, sessionId: 's2', snippet: '[done]' },
    ])
  })

  it('two turns with the same words at different times, or by different roles, are two; Claude hits are all kept', () => {
    const out = dedupeSearchHits([
      hit(1, 0, 'codex', 'user', 100, 'again'),
      hit(1, 2, 'codex', 'user', 200, 'again'),
      hit(1, 3, 'codex', 'assistant', 200, 'again'),
      hit(3, 0, 'claude', 'user', 100, 'again'),
      hit(4, 0, 'claude', 'user', 100, 'again'),
    ], 50)
    expect(out.map((h) => [h.runId, h.idx])).toEqual([[1, 0], [1, 2], [1, 3], [3, 0], [4, 0]])
  })

  it('at most the limit, counted after the repeats are gone', () => {
    const rows = [hit(1, 0, 'codex', 'user', 1, 'x'), hit(2, 0, 'codex', 'user', 1, 'x'), hit(1, 1, 'codex', 'user', 2, 'y'), hit(1, 2, 'codex', 'user', 3, 'z')]
    expect(dedupeSearchHits(rows, 2).map((h) => h.idx)).toEqual([0, 1])
  })
})
