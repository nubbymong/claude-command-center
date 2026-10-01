/**
 * P3.12: a Codex conversation two tabs both had (one after the other, each
 * session's slot its own run, the later one read from its start) is in the
 * index once per session; search lists each of its turns once. A turn is
 * the same when its role, its record time and its words are (the rollout's
 * own timestamp, so a turn typed twice is two). P3.16 (M1): a Claude turn the
 * same way, by its transcript's file name.
 */
import { describe, it, expect } from 'vitest'
import { dedupeSearchHits } from '../../../src/main/logging/search-dedupe'

const ROLLOUT = (id: string) => `/r/a/sessions/2026/09/30/rollout-2026-09-30T10-00-00-019dd000-0001-7000-8000-${id}.jsonl`
const TRANSCRIPT = (id: string) => `/h/.claude/projects/C--w/7f3e0c1a-0000-4000-8000-${id}.jsonl`
const hit = (runId: number, idx: number, provider: string, role: string, ts: number, content: string, sessionId = `s${runId}`, transcriptPaths: string | null = ({ codex: ROLLOUT('000000000001') } as Record<string, string>)[provider] ?? null) =>
  ({ runId, idx, configId: null, sessionId, snippet: `[${content}]`, provider, role, ts, content, transcriptPaths })

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

  it('two turns with the same words at different times, or by different roles, are two; hits with no transcript known are all kept', () => {
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

  it('Y2: the same words at the same time in two different conversations are two', () => {
    const out = dedupeSearchHits([
      hit(1, 0, 'codex', 'user', 100, 'hello', 's1', ROLLOUT('000000000001')),
      hit(2, 0, 'codex', 'user', 100, 'hello', 's2', ROLLOUT('000000000002')),
      hit(3, 0, 'codex', 'user', 100, 'hello', 's3', ROLLOUT('000000000001').replace('/r/a/', '/r/b/')),
      hit(4, 0, 'codex', 'user', 100, 'other words', 's4', ROLLOUT('000000000001')),
    ], 50)
    expect(out.map((h) => h.runId)).toEqual([1, 2, 4])
  })
})

describe('search lists a Claude turn once, as a Codex one (P3.16, M1)', () => {
  it('the same Claude turn indexed in two sessions (a resume in a new tab) is listed once', () => {
    const out = dedupeSearchHits([
      hit(1, 0, 'claude', 'user', 100, 'fix the flaky test', 's1', TRANSCRIPT('000000000001')),
      hit(2, 0, 'claude', 'user', 100, 'fix the flaky test', 's2', TRANSCRIPT('000000000001')),
      hit(2, 1, 'claude', 'assistant', 101, 'done', 's2', TRANSCRIPT('000000000001')),
    ], 50)
    expect(out.map((h) => [h.runId, h.idx])).toEqual([[1, 0], [2, 1]])
  })

  it('a run that rotated to another conversation (a /clear) matches by any of its transcripts', () => {
    const out = dedupeSearchHits([
      hit(1, 0, 'claude', 'user', 100, 'same words', 's1', `${TRANSCRIPT('000000000001')}\n${TRANSCRIPT('000000000002')}`),
      hit(2, 0, 'claude', 'user', 100, 'same words', 's2', TRANSCRIPT('000000000002')),
    ], 50)
    expect(out.map((h) => h.runId)).toEqual([1])
  })

  it('the same words at the same time in two Claude conversations, or a Claude and a Codex turn, are two', () => {
    const out = dedupeSearchHits([
      hit(1, 0, 'claude', 'user', 100, 'hello', 's1', TRANSCRIPT('000000000001')),
      hit(2, 0, 'claude', 'user', 100, 'hello', 's2', TRANSCRIPT('000000000002')),
      hit(3, 0, 'codex', 'user', 100, 'hello', 's3', ROLLOUT('000000000001')),
    ], 50)
    expect(out.map((h) => h.runId)).toEqual([1, 2, 3])
  })
})
