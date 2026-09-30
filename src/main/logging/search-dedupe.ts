/**
 * P3.12: search lists each turn of a Codex conversation once. A tab does
 * not index a conversation another tab holds; when the holder stops, or a
 * new tab resumes the conversation, that session indexes it in its own slot
 * from its start (a continuation stays within one session), so the index
 * holds the conversation once per session that had it. Both are right for
 * the slots; search shows each turn once. A Codex turn is the same when its
 * role, its record time (the rollout's own timestamp) and its words are.
 * Claude's hits are listed as before.
 *
 * Pure (no imports); no default export (project convention).
 */

export interface RankedSearchRow {
  runId: number
  idx: number
  configId: string | null
  sessionId: string
  snippet: string
  provider: string
  role: string
  ts: number
  content: string
}

/** `rows` in rank order, a Codex turn met again dropped, at most `limit`,
 *  each in the search hit's own shape. */
export function dedupeSearchHits(rows: RankedSearchRow[], limit: number): Array<{ runId: number; idx: number; configId: string | null; sessionId: string; snippet: string }> {
  const seen = new Set<string>()
  const out: Array<{ runId: number; idx: number; configId: string | null; sessionId: string; snippet: string }> = []
  for (const r of rows) {
    if (out.length >= limit) break
    if (r.provider === 'codex') {
      const key = JSON.stringify([r.role, r.ts, r.content])
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push({ runId: r.runId, idx: r.idx, configId: r.configId, sessionId: r.sessionId, snippet: r.snippet })
  }
  return out
}
