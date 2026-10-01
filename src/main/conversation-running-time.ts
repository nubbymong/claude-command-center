/**
 * conversation-running-time.ts: how long each provider conversation the app
 * has run has been running (P3.7, row 36), kept by main by conversation id,
 * so a session's Duration is its conversation's running time, carried on
 * across launches and relaunches, as Claude Code's is (its CLI restores the
 * figure from the transcript when it resumes).
 *
 * Codex's rollout does not tell its runs apart (P3.1 evidence: a resume adds
 * no session_meta; the one mark seen, thread_settings_applied, was seen only
 * on `codex exec resume`), and it records no run's start or end. So the
 * provider's watcher counts each launch's running time and notes it here,
 * as it goes and when the run ends; what the app did not see it takes from
 * what the rollout proves (the watcher's part).
 *
 * Each entry is the time counted (`ms`), the moment it was counted up to
 * (`until`), and the spans of time before that whose completed turns are not
 * in `ms` yet (`gaps`: a run that ended before its count of a large rollout
 * was done; the next run counts them). Main writes the list into the saved
 * session state at every save (session-resume-enrich) and reads it back at
 * load, schema-checked (app-session-durability). Only the most recent
 * CONVERSATION_RUNNING_TIMES_KEPT entries are kept, by `until`, and at most
 * CONVERSATION_GAPS_KEPT gaps each (spans that touch or overlap are one; past
 * the cap the shortest go, the few seconds of a Restart, never the history
 * before the app first ran the conversation). With the gaps, `gapMs`: the
 * part of their turns a run had counted (P3.16, M4), so a figure shown before
 * a Restart is never shown less after it while the next count runs.
 * Provider-neutral: ids and numbers only.
 */

/** A span of time (epoch milliseconds, both ends excluded). */
export interface RunningTimeGap {
  from: number
  to: number
}

export interface ConversationRunningTime {
  /** The running time counted, in milliseconds. */
  ms: number
  /** When it was counted up to (epoch milliseconds). */
  until: number
  /** Spans before `until` whose completed turns are not in `ms` yet. */
  gaps: RunningTimeGap[]
  /** P3.16 (M4): of the gaps' completed turns, the running time a run had
   *  counted (a part of them): the least they add to `ms`. Only with gaps. */
  gapMs?: number
}

export interface SavedConversationRunningTime {
  id: string
  ms: number
  until: number
  gaps?: RunningTimeGap[]
  gapMs?: number
}

/** How many conversations' times are kept (the most recent, by `until`). */
export const CONVERSATION_RUNNING_TIMES_KEPT = 1000
/** How many gaps a conversation keeps (past it the shortest go); the turns
 *  of one dropped are not counted. */
export const CONVERSATION_GAPS_KEPT = 8
/** No running time is longer than this. */
const MAX_RUNNING_MS = 10 * 365 * 24 * 3600 * 1000
/** A time counted up to later than now by more than this is not one. */
const FUTURE_SLACK_MS = 24 * 3600 * 1000
/** A conversation id (the spawn schema's form). */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const times = new Map<string, ConversationRunningTime>()

/** A time and when it was counted up to, both in range (NaN and the
 *  infinities are not). */
function validTime(ms: unknown, until: unknown, now: number): boolean {
  return typeof ms === 'number' && ms >= 0 && ms <= MAX_RUNNING_MS
    && typeof until === 'number' && until >= 0 && until <= now + FUTURE_SLACK_MS
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && CONVERSATION_ID.test(id)
}

/** The well-formed gaps of `gaps` (numbers, 0 <= from < to <= until), oldest
 *  first; anything else is passed over. P3.16 (M4): spans that touch or
 *  overlap are one span (their union: no turn is in it twice); past
 *  CONVERSATION_GAPS_KEPT the shortest go (of spans alike, the oldest): each
 *  Restart during a large rollout's count adds the few seconds the session
 *  was not running, which hold no turn of the app's, while the span from 0
 *  holds the conversation's history before the app first ran it. */
function validGaps(gaps: unknown, until: number): RunningTimeGap[] {
  if (!Array.isArray(gaps)) return []
  const spans: RunningTimeGap[] = []
  for (const g of gaps.slice(0, CONVERSATION_GAPS_KEPT * 4)) {
    if (!g || typeof g !== 'object') continue
    const { from, to } = g as { from?: unknown; to?: unknown }
    if (typeof from !== 'number' || typeof to !== 'number' || !(from >= 0) || !(to > from) || !(to <= until)) continue
    spans.push({ from, to })
  }
  spans.sort((a, b) => a.from - b.from)
  const out: RunningTimeGap[] = []
  for (const s of spans) {
    const last = out[out.length - 1]
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to)
    else out.push({ from: s.from, to: s.to })
  }
  while (out.length > CONVERSATION_GAPS_KEPT) {
    let shortest = 0
    for (let i = 1; i < out.length; i++) {
      if (out[i].to - out[i].from < out[shortest].to - out[shortest].from) shortest = i
    }
    out.splice(shortest, 1)
  }
  return out
}

/** P3.16 (M4): the counted part of the gaps' turns, when it is a time and
 *  there are gaps it is a part of; else none. */
function validGapMs(gapMs: unknown, gaps: RunningTimeGap[]): number | undefined {
  return gaps.length > 0 && typeof gapMs === 'number' && gapMs > 0 && gapMs <= MAX_RUNNING_MS ? gapMs : undefined
}

function entryOf(ms: number, until: number, gaps: unknown, gapMs: unknown): ConversationRunningTime {
  const kept = validGaps(gaps, until)
  const counted = validGapMs(gapMs, kept)
  return counted === undefined ? { ms, until, gaps: kept } : { ms, until, gaps: kept, gapMs: counted }
}

/** Past the limit, the entries counted up to the earliest go. */
function trim(): void {
  while (times.size > CONVERSATION_RUNNING_TIMES_KEPT) {
    let oldest: string | null = null
    let oldestUntil = Number.POSITIVE_INFINITY
    for (const [id, t] of times) {
      if (t.until < oldestUntil) { oldest = id; oldestUntil = t.until }
    }
    if (oldest === null) return
    times.delete(oldest)
  }
}

/** The conversation's running time as kept, or null (a copy). */
export function conversationRunningTime(id: string): ConversationRunningTime | null {
  if (!validId(id)) return null
  const t = times.get(id.toLowerCase())
  if (!t) return null
  const gaps = t.gaps.map((g) => ({ from: g.from, to: g.to }))
  return t.gapMs === undefined ? { ms: t.ms, until: t.until, gaps } : { ms: t.ms, until: t.until, gaps, gapMs: t.gapMs }
}

/** Keep `ms` as the conversation's running time, counted up to `until`, with
 *  the spans before it whose completed turns are not in `ms` yet, and the
 *  part of those turns already counted (`gapMs`, P3.16 M4). */
export function noteConversationRunningTime(id: string, ms: number, until: number, gaps: RunningTimeGap[] = [], gapMs?: number): void {
  if (!validId(id) || !validTime(ms, until, Date.now())) return
  times.set(id.toLowerCase(), entryOf(ms, until, gaps, gapMs))
  trim()
}

/** Every kept time, for the saved session state (gaps only where there are some). */
export function conversationRunningTimesForSave(): SavedConversationRunningTime[] {
  return [...times].map(([id, t]) => {
    if (!t.gaps.length) return { id, ms: t.ms, until: t.until }
    const gaps = t.gaps.map((g) => ({ ...g }))
    return t.gapMs === undefined ? { id, ms: t.ms, until: t.until, gaps } : { id, ms: t.ms, until: t.until, gaps, gapMs: t.gapMs }
  })
}

/**
 * Read the times back from a loaded session state (`conversationRunningTimes`),
 * schema-checked: at most CONVERSATION_RUNNING_TIMES_KEPT entries are read, and
 * an entry that is not a conversation id with a time is passed over, as is a
 * gap that is not a span before its `until`. One main already has counted
 * further (a later `until`) is kept as main has it.
 */
export function rememberConversationRunningTimesFrom(state: unknown): void {
  if (!state || typeof state !== 'object') return
  const list = (state as { conversationRunningTimes?: unknown }).conversationRunningTimes
  if (!Array.isArray(list)) return
  const now = Date.now()
  for (const entry of list.slice(0, CONVERSATION_RUNNING_TIMES_KEPT)) {
    if (!entry || typeof entry !== 'object') continue
    const { id, ms, until, gaps, gapMs } = entry as { id?: unknown; ms?: unknown; until?: unknown; gaps?: unknown; gapMs?: unknown }
    if (!validId(id) || !validTime(ms, until, now)) continue
    const key = id.toLowerCase()
    const had = times.get(key)
    if (!had || (until as number) > had.until) times.set(key, entryOf(ms as number, until as number, gaps, gapMs))
  }
  trim()
}

export function __resetConversationRunningTimesForTests(): void {
  times.clear()
}
