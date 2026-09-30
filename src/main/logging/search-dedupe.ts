/**
 * P3.12: search lists each turn of a Codex conversation once. A tab does
 * not index a conversation another tab holds; when the holder stops, or a
 * new tab resumes the conversation, that session indexes it in its own slot
 * from its start (a continuation stays within one session), so the index
 * holds the conversation once per session that had it. Both are right for
 * the slots; search shows each turn once. A Codex turn is the same when it
 * is of the same conversation (a rollout id both runs read), its role and
 * record time (the rollout's own timestamp) are, and its words hash alike.
 * Claude's hits are listed as before.
 *
 * No default export (project convention).
 */
import { createHash } from 'crypto'
import { codexConversationKey } from '../../shared/codex-conversation-key'

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
  /** The run's Codex rollout paths, one per line (null when none). */
  codexPaths: string | null
}

/** `rows` in rank order, a Codex turn met again dropped, at most `limit`,
 *  each in the search hit's own shape. */
export function dedupeSearchHits(rows: RankedSearchRow[], limit: number): Array<{ runId: number; idx: number; configId: string | null; sessionId: string; snippet: string }> {
  const seen = new Map<string, Set<string>>()
  const out: Array<{ runId: number; idx: number; configId: string | null; sessionId: string; snippet: string }> = []
  for (const r of rows) {
    if (out.length >= limit) break
    if (r.provider === 'codex') {
      const conversations = (r.codexPaths ?? '').split('\n').filter(Boolean).map(codexConversationKey)
      if (conversations.length > 0) {
        const key = JSON.stringify([r.role, r.ts, createHash('sha256').update(String(r.content)).digest('hex')])
        const before = seen.get(key)
        if (before && conversations.some((c) => before.has(c))) continue
        const set = before ?? new Set<string>()
        for (const c of conversations) set.add(c)
        seen.set(key, set)
      }
    }
    out.push({ runId: r.runId, idx: r.idx, configId: r.configId, sessionId: r.sessionId, snippet: r.snippet })
  }
  return out
}
