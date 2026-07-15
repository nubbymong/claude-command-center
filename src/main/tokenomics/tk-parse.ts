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

export function codexEventsFromRollout(text: string, priceKeys: string[], startOrdinal: number): TkEvent[] {
  const lines = text.split('\n').filter(Boolean)
  let sessionId = ''
  let cwd = ''
  let model = ''
  let baseTs = 0
  const turns: Array<{ ts: number; inNonCached: number; cached: number; out: number }> = []

  for (const line of lines) {
    let evt: any
    try { evt = JSON.parse(line) } catch { continue }
    if (evt.type === 'session_meta') {
      const p = evt.payload ?? {}
      sessionId = String(p.id ?? '')
      cwd = String(p.cwd ?? '')
      if (p.model) model = String(p.model)
      baseTs = evt.timestamp ? Date.parse(evt.timestamp) : 0
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
    })
  }

  if (!sessionId) return []
  const events: TkEvent[] = []
  for (let i = startOrdinal; i < turns.length; i++) {
    const t = turns[i]
    events.push({
      dedupKey: `x:${sessionId}:${i}`,
      sessionId,
      provider: 'codex',
      model: model || 'unknown',
      priceModel: toPriceModel(model || 'unknown', priceKeys),
      ts: Number.isFinite(t.ts) ? t.ts : baseTs,
      cwd,
      inTok: t.inNonCached,
      outTok: t.out,
      cacheReadTok: t.cached,
      cacheCreateTok: 0,
    })
  }
  return events
}
