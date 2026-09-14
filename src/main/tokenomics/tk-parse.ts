import type { TkEvent } from './tk-types'

function toPriceModel(model: string, priceKeys: string[]): string {
  if (priceKeys.includes(model)) return model
  let best = ''
  for (const k of priceKeys) {
    if (model.startsWith(k) && k.length > best.length) best = k
  }
  return best || model
}

export function extractCwdFromLine(line: string): string | null {
  if (!line.includes('"cwd"')) return null
  try {
    const obj = JSON.parse(line)
    return typeof obj.cwd === 'string' && obj.cwd ? obj.cwd : null
  } catch { return null }
}

export function parseClaudeUsageLine(line: string, priceKeys: string[]): TkEvent | null {
  if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) return null
  let entry: any
  try { entry = JSON.parse(line) } catch { return null }
  if (entry.type !== 'assistant') return null
  const usage = entry.message?.usage
  if (!usage) return null
  const messageId = String(entry.message?.id ?? '')
  if (!messageId) return null
  const requestId = String(entry.requestId ?? '')
  const model = String(entry.message?.model ?? 'unknown')
  const ts = entry.timestamp ? Date.parse(entry.timestamp) : 0
  return {
    dedupKey: `c:${messageId}:${requestId}`,
    sessionId: String(entry.sessionId ?? ''),
    provider: 'claude',
    model,
    priceModel: toPriceModel(model, priceKeys),
    ts: Number.isFinite(ts) ? ts : 0,
    cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
    inTok: usage.input_tokens || 0,
    outTok: usage.output_tokens || 0,
    cacheReadTok: usage.cache_read_input_tokens || 0,
    cacheCreateTok: usage.cache_creation_input_tokens || 0,
  }
}

/** What a rollout's own header lines would have told us, for a caller that is
 *  reading the file from the middle and cannot see them. A rollout announces
 *  its session id and cwd once (`session_meta`, first line) and its model in
 *  `turn_context` lines near the top; a reader resuming past all of that has
 *  to be told, or it produces no events at all (no session id) and prices what
 *  it does produce as 'unknown', which matches no pricing row and costs $0. */
export interface CodexRolloutSeed { sessionId?: string; cwd?: string; model?: string }

export function codexEventsFromRollout(text: string, priceKeys: string[], startOrdinal: number, seed?: CodexRolloutSeed): TkEvent[] {
  const lines = text.split('\n').filter(Boolean)
  // Anything the file itself states overrides the seed: the seed is only a
  // stand-in for header lines this slice of the file cannot see.
  let sessionId = seed?.sessionId ?? ''
  let cwd = seed?.cwd ?? ''
  let model = seed?.model ?? ''
  let baseTs = 0
  // #307: the FIRST session_meta is the file's own identity. A SUBAGENT rollout
  // carries a SECOND session_meta naming its parent (thread_source 'subagent',
  // forked_from_id) — and taking the last id seen re-labelled the subagent's
  // turns with the parent's session, collapsing their per-file ordinals onto the
  // parent's so INSERT OR IGNORE dropped ~half of all Codex turns (measured
  // 49.3%). Lock the identity on the first real id (or the seed, which is the
  // header a mid-file reader already learned) and ignore later session_meta.
  let identityLocked = !!seed?.sessionId
  // The model is captured PER TURN, at the point the turn is read. Carrying one
  // mutable `model` and stamping the final value on every turn priced a whole
  // slice at whichever model it happened to end on: a session that switched
  // from a premium model to a cheap one billed entirely at the cheap one, and
  // the price of identical bytes then depended on where the reader split them.
  const turns: Array<{ ts: number; inNonCached: number; cached: number; out: number; model: string }> = []

  for (const line of lines) {
    let evt: any
    try { evt = JSON.parse(line) } catch { continue }
    if (evt.type === 'session_meta') {
      // Once the identity is locked, a later session_meta is parent metadata
      // (#307) — skip it entirely so it cannot steal the id, cwd or base ts.
      // A per-turn model change still arrives via `turn_context` below, so
      // pricing is unaffected.
      if (identityLocked) continue
      const p = evt.payload ?? {}
      // Only overwrite with something real: a malformed header must not wipe a
      // seed and leave us with no session id, which discards the whole slice.
      if (p.id) sessionId = String(p.id)
      if (p.cwd) cwd = String(p.cwd)
      if (p.model) model = String(p.model)
      baseTs = evt.timestamp ? Date.parse(evt.timestamp) : 0
      // Lock on the first session_meta that actually names a session; a
      // malformed first header (no id) still lets a real later one supply it.
      if (p.id) identityLocked = true
      continue
    }
    if (evt.type === 'turn_context' && evt.payload?.model) { model = String(evt.payload.model); continue }
    if (evt.type !== 'event_msg') continue
    const payload = evt.payload ?? {}
    if (payload.type !== 'token_count') continue
    const info = payload.info
    if (!info?.total_token_usage) continue
    const total = info.total_token_usage
    const last = info.last_token_usage
    const u = last ?? total
    const inputTotal = Number(u.input_tokens ?? 0)
    const cached = Number(u.cached_input_tokens ?? 0)
    // reasoning_output_tokens is a SUBSET of output_tokens (verified against real
    // rollouts: total_tokens == input + output exactly) — adding it double-counts.
    const out = Number(u.output_tokens ?? 0)
    turns.push({
      ts: evt.timestamp ? Date.parse(evt.timestamp) : baseTs,
      inNonCached: Math.max(0, inputTotal - cached),
      cached,
      out,
      model,
    })
  }

  if (!sessionId) return []
  const events: TkEvent[] = []
  for (let i = startOrdinal; i < turns.length; i++) {
    const t = turns[i]
    const turnModel = t.model || model || 'unknown'
    const ts = Number.isFinite(t.ts) ? t.ts : baseTs
    events.push({
      dedupKey: `x:${sessionId}:${i}`,
      sessionId,
      provider: 'codex',
      model: turnModel,
      priceModel: toPriceModel(turnModel, priceKeys),
      ts,
      cwd,
      inTok: t.inNonCached,
      outTok: t.out,
      cacheReadTok: t.cached,
      cacheCreateTok: 0,
    })
  }
  return events
}
