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
 * Each entry is the time counted (`ms`) and the moment it was counted up to
 * (`until`). Main writes the list into the saved session state at every save
 * (session-resume-enrich) and reads it back at load, schema-checked
 * (app-session-durability). Only the most recent CONVERSATION_RUNNING_TIMES_KEPT
 * entries are kept, by `until`. Provider-neutral: ids and numbers only.
 */

export interface ConversationRunningTime {
  /** The running time counted, in milliseconds. */
  ms: number
  /** When it was counted up to (epoch milliseconds). */
  until: number
}

export interface SavedConversationRunningTime extends ConversationRunningTime {
  id: string
}

/** How many conversations' times are kept (the most recent, by `until`). */
export const CONVERSATION_RUNNING_TIMES_KEPT = 1000
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
  return t ? { ms: t.ms, until: t.until } : null
}

/** Keep `ms` as the conversation's running time, counted up to `until`. */
export function noteConversationRunningTime(id: string, ms: number, until: number): void {
  if (!validId(id) || !validTime(ms, until, Date.now())) return
  times.set(id.toLowerCase(), { ms, until })
  trim()
}

/** Every kept time, for the saved session state. */
export function conversationRunningTimesForSave(): SavedConversationRunningTime[] {
  return [...times].map(([id, t]) => ({ id, ms: t.ms, until: t.until }))
}

/**
 * Read the times back from a loaded session state (`conversationRunningTimes`),
 * schema-checked: at most CONVERSATION_RUNNING_TIMES_KEPT entries are read, and
 * an entry that is not a conversation id with a time is passed over. One main
 * already has counted further (a later `until`) is kept as main has it.
 */
export function rememberConversationRunningTimesFrom(state: unknown): void {
  if (!state || typeof state !== 'object') return
  const list = (state as { conversationRunningTimes?: unknown }).conversationRunningTimes
  if (!Array.isArray(list)) return
  const now = Date.now()
  for (const entry of list.slice(0, CONVERSATION_RUNNING_TIMES_KEPT)) {
    if (!entry || typeof entry !== 'object') continue
    const { id, ms, until } = entry as { id?: unknown; ms?: unknown; until?: unknown }
    if (!validId(id) || !validTime(ms, until, now)) continue
    const key = id.toLowerCase()
    const had = times.get(key)
    if (!had || (until as number) > had.until) times.set(key, { ms: ms as number, until: until as number })
  }
  trim()
}

export function __resetConversationRunningTimesForTests(): void {
  times.clear()
}
