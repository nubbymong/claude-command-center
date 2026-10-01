/**
 * Codex rollout watch-and-claim telemetry (P3.1)
 *
 * Tails the rollout JSONL that Codex writes to
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 * and converts token_count events into StatuslineData updates, with the
 * lines its completed edits changed and the conversation's running time
 * (P3.7).
 *
 * Exports:
 *   parseCodexRollout       -- parse raw JSONL text into typed events
 *   mapTokenCountToStatusline -- convert a TokenCountEvent to StatuslineData
 *   withAllowance           -- put the validated allowance on an update (MP2)
 *   countFileChangeLines    -- the lines one recorded edit added and removed (P3.7)
 *   countRolloutRange       -- those, and the completed turns' time, over a byte range, in the background (P3.7)
 *   watchAndClaimRollout    -- 250ms-poll claim + 500ms-poll tail pipeline
 */

import { readdirSync, lstatSync, unlinkSync, rmdirSync, openSync, fstatSync, readSync, closeSync, constants as fsConstants, promises as fsp } from 'fs'
import type { FileHandle } from 'fs/promises'
import { join, relative, isAbsolute, sep, dirname, basename } from 'path'
import { computeCodexCostUsd } from './pricing'
import { CODEX_CONVERSATION_ID_RE, codexDayFolders, codexFolderIdentity, findCodexRollout, isRealFolder, parseSessionMetaLine, readRolloutFirstLine, sameDirectory } from './rollout-lookup'
import type { FoundRollout, RolloutSessionMeta } from './rollout-lookup'
import type { PickFolderIdentity } from '../types'
import { normaliseCodexRateLimits, mergeAllowanceReadings, readingToBuckets, isoFromEpochMs, zonedTimeMs, CODEX_DEFAULT_LIMIT_ID } from './rate-limits'
import { conversationRunningTime, noteConversationRunningTime } from '../../conversation-running-time'
import type { StatuslineData } from '../../../shared/types'
import type { AllowanceReading } from '../../../shared/usage-types'
import type { TelemetrySource } from '../types'

// ── Types ────────────────────────────────────────────────────────────────────

export interface RolloutMeta {
  id: string
  cwd: string
  model: string
  /**
   * Codex turn_context.payload.effort -- reasoning effort label like "xhigh".
   * Surfaced alongside the model name in the ContextBar so the user can see
   * which effort level the session is actually running at. Optional because
   * older rollouts (pre-0.128.0) and the very earliest events of a session
   * before the first turn_context may not carry it.
   */
  reasoningEffort?: string
  cli_version: string
  timestamp: string
}

/**
 * Merged view of a token_count event: token usage from evt.payload.info
 * combined with rate_limits from evt.payload.rate_limits.
 *
 * Codex JSONL structure (real format):
 *   { type: "event_msg", payload: {
 *       type: "token_count",
 *       info: { total_token_usage: {...}, last_token_usage: {...}, model_context_window: N } | null,
 *       rate_limits: { limit_id, limit_name, primary?: {...}, secondary?: {...}, plan_type, ... }
 *   }}
 *
 * Events where info is null (pre-response placeholders) are skipped here, but
 * their rate_limits still count: parseCodexRollout reads the allowance from
 * every token_count (usage track MP2).
 */
export interface CodexRolloutWindow {
  used_percent: number
  window_minutes?: number | null
  resets_at?: number | null
}

/** A token_count's rate_limits as the CLI writes it. `plan_type` sits on the
 *  snapshot, beside the windows, never inside `primary`. Untrusted: read it
 *  through normaliseCodexRateLimits. */
export interface CodexRolloutRateLimits {
  limit_id?: string | null
  limit_name?: string | null
  primary?: CodexRolloutWindow | null
  secondary?: CodexRolloutWindow | null
  plan_type?: string | null
}

export interface TokenCountEvent {
  total_token_usage: {
    input_tokens: number
    cached_input_tokens: number
    output_tokens: number
    reasoning_output_tokens: number
    total_tokens: number
  }
  last_token_usage?: {
    input_tokens?: number
    cached_input_tokens?: number
    output_tokens?: number
    reasoning_output_tokens?: number
    total_tokens?: number
  }
  rate_limits?: CodexRolloutRateLimits | null
}

// ── Parser ───────────────────────────────────────────────────────────────────

/**
 * What the status line needs from a rollout, read a line at a time (P3.5 fix
 * round 1), so a watcher reads only what a rollout gained since its last read:
 *   meta          -- session_meta fields (id, cwd, model, cli_version, timestamp),
 *                    with the model and effort of the latest turn_context
 *   contextWindow -- model_context_window of the latest task_started, or null
 *   latest        -- the latest token_count that has real usage data (info != null)
 *   allowance     -- the account's allowances from EVERY token_count that carries
 *                    rate_limits (the pre-response info-null one included): the
 *                    newest reading of each limit, stamped with the time of the
 *                    newest event that had one; null when none did (merged a
 *                    reading at a time: the same result as merging them all)
 *   linesAdded,   -- the lines the edits read so far added and removed
 *   linesRemoved     (P3.7, row 36; countFileChangeLines)
 *   turnWindows,  -- the running time the rollout proves in some spans of
 *   turnMs           time (P3.7): the turns it records as completed inside
 *                    one, each only for its part inside (none without one)
 */
export interface RolloutReadState {
  meta: RolloutMeta | null
  contextWindow: number | null
  latest: TokenCountEvent | null
  allowance: AllowanceReading | null
  /** A carried conversation's mark (ADR-023): when set, only the token_count
   *  events dated after it (with a zoned time) count towards `allowance`. The
   *  rest of what the rollout says is read as before. */
  allowanceAfter: number | null
  linesAdded: number
  linesRemoved: number
  turnWindows: TurnWindow[]
  turnMs: number
}

/** A span of time (epoch milliseconds, both ends excluded; 0 as `from` is
 *  from the start of time). */
export interface TurnWindow {
  from: number
  to: number
}

export function newRolloutReadState(turnWindows: TurnWindow[] = []): RolloutReadState {
  return { meta: null, contextWindow: null, latest: null, allowance: null, allowanceAfter: null, linesAdded: 0, linesRemoved: 0, turnWindows, turnMs: 0 }
}

/** Added and removed line counts. */
export interface LineCounts {
  added: number
  removed: number
}

/** What a background count found in a range of a rollout (countRolloutRange). */
export interface RangeCounts extends LineCounts {
  turnMs: number
}

/** How many lines `text` holds (a last line with no newline counts). */
function textLineCount(text: string): number {
  if (!text) return 0
  const breaks = text.split('\n').length - 1
  return text.endsWith('\n') ? breaks : breaks + 1
}

/** The lines one unified diff adds and removes: only lines inside a hunk,
 *  each hunk read for exactly the lines its header counts, so a file header
 *  before or between hunks is never taken for a change. */
function unifiedDiffLines(diff: string): LineCounts {
  const out: LineCounts = { added: 0, removed: 0 }
  let oldLeft = 0
  let newLeft = 0
  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line.charAt(0)
      if (c === '+') { out.added++; newLeft--; continue }
      if (c === '-') { out.removed++; oldLeft--; continue }
      if (c === ' ' || line === '') { oldLeft--; newLeft--; continue }
      if (c === '\\') continue
      // Not a hunk line: the hunk ended early; look for the next header.
      oldLeft = 0
      newLeft = 0
    }
    const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
    if (h) {
      oldLeft = h[1] === undefined ? 1 : Number(h[1])
      newLeft = h[2] === undefined ? 1 : Number(h[2])
    }
  }
  return out
}

/**
 * The lines one recorded edit added and removed (P3.7, row 36). Codex writes
 * no line count (P3.1 evidence, answer 5): a completed edit is an
 * item_completed event whose item is a FileChange, with a change per file.
 * An `update` carries a unified diff, whose hunk lines are counted; an `add`
 * or a `delete` carries the file's content, counted as added or removed.
 * Anything else counts nothing.
 */
export function countFileChangeLines(changes: unknown): LineCounts {
  const out: LineCounts = { added: 0, removed: 0 }
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return out
  for (const change of Object.values(changes as Record<string, unknown>)) {
    if (!change || typeof change !== 'object') continue
    const c = change as { type?: unknown; unified_diff?: unknown; content?: unknown }
    if (typeof c.unified_diff === 'string') {
      const d = unifiedDiffLines(c.unified_diff)
      out.added += d.added
      out.removed += d.removed
    } else if (c.type === 'add' && typeof c.content === 'string') {
      out.added += textLineCount(c.content)
    } else if (c.type === 'delete' && typeof c.content === 'string') {
      out.removed += textLineCount(c.content)
    }
  }
  return out
}

/** One JSONL line of a rollout into `state`; `onTokenCount` hears each usage
 *  event. A line that is not a record this reads is skipped. */
export function applyRolloutLine(state: RolloutReadState, line: string, onTokenCount?: (tc: TokenCountEvent) => void): void {
  let evt: Record<string, unknown>
  try {
    evt = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  if (!evt || typeof evt !== 'object') return
  const payload = evt.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload !== 'object') return

  if (evt.type === 'session_meta') {
    state.meta = {
      id: String(payload.id ?? ''),
      cwd: String(payload.cwd ?? ''),
      // model is populated below from turn_context; session_meta only has model_provider
      model: String(payload.model ?? ''),
      cli_version: String(payload.cli_version ?? ''),
      timestamp: String(evt.timestamp ?? ''),
    }
    return
  }

  // turn_context carries the resolved model name (e.g. "gpt-5.5") and the
  // reasoning effort (e.g. "xhigh"). The effort is on payload.effort directly.
  if (evt.type === 'turn_context' && state.meta) {
    if (typeof payload.model === 'string' && payload.model) state.meta.model = payload.model
    if (typeof payload.effort === 'string' && payload.effort) state.meta.reasoningEffort = payload.effort
    return
  }

  if (evt.type !== 'event_msg') return

  if (payload.type === 'task_started') {
    const cw = payload.model_context_window
    if (typeof cw === 'number') state.contextWindow = cw
    return
  }

  // A turn Codex completed (P3.7): the time it records the turn took
  // (duration_ms, both versions) is running time the rollout proves. Counted
  // only inside one of the read state's windows (they never overlap), and of
  // a turn that began before that window only its part inside it.
  if (payload.type === 'task_complete') {
    const ms = Number.isFinite(payload.duration_ms) ? payload.duration_ms as number : 0
    // A timestamp that does not parse is NaN, never inside a window.
    const at = Date.parse(String(evt.timestamp ?? ''))
    const w = ms > 0 ? state.turnWindows.find((x) => at > x.from && at < x.to) : undefined
    if (w) state.turnMs += Math.min(ms, at - w.from)
    return
  }

  // An edit Codex applied (P3.7): only a completed one changed the files.
  if (payload.type === 'item_completed') {
    const item = payload.item as { type?: unknown; status?: unknown; changes?: unknown } | null | undefined
    if (item && typeof item === 'object' && item.type === 'FileChange' && item.status === 'completed') {
      const n = countFileChangeLines(item.changes)
      state.linesAdded += n.added
      state.linesRemoved += n.removed
    }
    return
  }

  if (payload.type === 'token_count') {
    // The allowance first: a pre-response event (info null) already carries it.
    if (payload.rate_limits != null) {
      let at = Date.parse(String(evt.timestamp ?? ''))
      // A carried conversation (ADR-023): an event of the earlier account, or
      // one with no zoned time, is not this account's allowance.
      let counts = true
      if (state.allowanceAfter !== null) {
        const zoned = zonedTimeMs(evt.timestamp)
        counts = zoned !== null && zoned > state.allowanceAfter
        if (zoned !== null) at = zoned
      }
      if (counts) state.allowance = mergeAllowanceReadings([state.allowance, normaliseCodexRateLimits(payload.rate_limits, 'rollout', Number.isFinite(at) ? at : null)])
    }
    // info is null for pre-response token_count events -- no usage in those
    const info = payload.info as Record<string, unknown> | null
    if (!info) return

    const usage = info.total_token_usage as Record<string, unknown>
    if (!usage) return

    const tokenCountEvent: TokenCountEvent = {
      total_token_usage: {
        input_tokens: Number(usage.input_tokens ?? 0),
        cached_input_tokens: Number(usage.cached_input_tokens ?? 0),
        output_tokens: Number(usage.output_tokens ?? 0),
        reasoning_output_tokens: Number(usage.reasoning_output_tokens ?? 0),
        total_tokens: Number(usage.total_tokens ?? 0),
      },
      rate_limits: payload.rate_limits as TokenCountEvent['rate_limits'] | undefined,
    }

    const lastUsage = info.last_token_usage as Record<string, unknown> | undefined
    if (lastUsage) {
      tokenCountEvent.last_token_usage = {
        input_tokens: Number(lastUsage.input_tokens ?? 0),
        cached_input_tokens: Number(lastUsage.cached_input_tokens ?? 0),
        output_tokens: Number(lastUsage.output_tokens ?? 0),
        reasoning_output_tokens: Number(lastUsage.reasoning_output_tokens ?? 0),
        total_tokens: Number(lastUsage.total_tokens ?? 0),
      }
    }

    state.latest = tokenCountEvent
    onTokenCount?.(tokenCountEvent)
  }
}

/**
 * Parse raw JSONL text from a Codex rollout file.
 *
 * Returns:
 *   meta          -- session_meta fields (id, cwd, model, cli_version, timestamp)
 *   tokenCounts   -- all token_count events that have real usage data (info != null)
 *   contextWindow -- model_context_window from the task_started event, or null
 *   allowance     -- the account's allowances from EVERY token_count that carries
 *                    rate_limits (the pre-response info-null one included): the
 *                    newest reading of each limit, stamped with the time of the
 *                    newest event that had one; null when none did
 *   linesAdded,   -- the lines its completed edits added and removed (P3.7)
 *   linesRemoved
 *
 * Throws if no session_meta line is found.
 */
export function parseCodexRollout(text: string): {
  meta: RolloutMeta
  tokenCounts: TokenCountEvent[]
  contextWindow: number | null
  allowance: AllowanceReading | null
  linesAdded: number
  linesRemoved: number
} {
  const state = newRolloutReadState()
  const tokenCounts: TokenCountEvent[] = []
  for (const line of text.split('\n')) {
    if (line) applyRolloutLine(state, line, (tc) => tokenCounts.push(tc))
  }
  if (!state.meta) throw new Error('rollout missing session_meta')
  return { meta: state.meta, tokenCounts, contextWindow: state.contextWindow, allowance: state.allowance, linesAdded: state.linesAdded, linesRemoved: state.linesRemoved }
}

/** How much of a rollout the background count reads at a time, and the
 *  longest line it keeps to look at (a longer one is passed over): 8 MiB,
 *  so one huge line never holds hundreds of MB or stalls main while it is
 *  parsed; an edit record longer than that is not counted (P3.7 review). */
export const EDIT_COUNT_CHUNK_BYTES = 1024 * 1024
export const EDIT_COUNT_LINE_MAX_BYTES = 8 * 1024 * 1024
/** The text every line holding an edit, or a completed turn, contains; no
 *  other line is parsed. */
const FILE_CHANGE_MARK = Buffer.from('"FileChange"')
const TASK_COMPLETE_MARK = Buffer.from('"task_complete"')

/** Bytes the background counts have read, and the most of one line any of
 *  them held at once (tests read them). */
let editCountBytesRead = 0
let editCountMostHeld = 0
export function __codexEditCountBytesReadForTests(): number { return editCountBytesRead }
/** The most held since the last call, then starts again. */
export function __codexEditCountTakeMostHeldForTests(): number { const n = editCountMostHeld; editCountMostHeld = 0; return n }

/** How long a background count may take (P3.7 review round 2; the carry has
 *  60 s too): past it there is no count, and the count stops at its next
 *  chunk if a read held up ever returns. */
export const EDIT_COUNT_MAX_MS = 60_000

/** The counts whose file is not closed yet (tests wait for them). */
const countsOpen = new Set<Promise<unknown>>()
/** Resolves once every background count has closed its file. */
export async function __codexCountsSettledForTests(): Promise<void> {
  while (countsOpen.size) await Promise.all([...countsOpen])
}

/**
 * The lines the completed edits in whole lines of `file` from byte `start`
 * to `end` added and removed, and the running time its completed turns prove
 * inside `turnWindows` (none without any) (P3.7): what a watcher that read
 * only a large rollout's head and tail did not see. Read apart from the status line's own
 * reads, a chunk at a time, while the opened file is still `identity` (its
 * device and file id, as the watcher claimed it). Null when it is not, when
 * the read fails, when `stale()` says the count is no longer wanted (it
 * is asked before each chunk, and last once the file is closed: once it is,
 * no further read starts and the file is closed when the read in hand
 * returns), or once `limits.maxMs` (EDIT_COUNT_MAX_MS) has passed, even with
 * a read held up. A last line with no newline before `end` is not a whole
 * record and is not counted; a line longer than `lineMaxBytes` is passed
 * over, never held.
 */
export async function countRolloutRange(
  file: string,
  identity: string,
  start: number,
  end: number,
  stale: () => boolean = () => false,
  limits: { chunkBytes?: number; lineMaxBytes?: number; maxMs?: number } = {},
  turnWindows: TurnWindow[] = [],
): Promise<RangeCounts | null> {
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => { expired = true; resolve(null) }, limits.maxMs ?? EDIT_COUNT_MAX_MS)
    ;(timer as { unref?: () => void }).unref?.()
  })
  const counting = countRange(file, identity, start, end, () => expired || stale(), limits, turnWindows)
  countsOpen.add(counting)
  void counting.finally(() => { countsOpen.delete(counting) })
  try {
    return await Promise.race([counting, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** countRolloutRange's count itself, with no time limit of its own. */
async function countRange(
  file: string,
  identity: string,
  start: number,
  end: number,
  stale: () => boolean,
  limits: { chunkBytes?: number; lineMaxBytes?: number },
  turnWindows: TurnWindow[],
): Promise<RangeCounts | null> {
  const chunkBytes = Math.max(1, limits.chunkBytes ?? EDIT_COUNT_CHUNK_BYTES)
  const lineMax = limits.lineMaxBytes ?? EDIT_COUNT_LINE_MAX_BYTES
  const counted = newRolloutReadState(turnWindows)
  let result: RangeCounts | null = null
  let fh: FileHandle | null = null
  try {
    fh = await fsp.open(file, 'r')
    const st = await fh.stat({ bigint: true })
    if (`${st.dev}:${st.ino}` !== identity) return null
    /** The line read so far across chunks, and its length (Infinity once it
     *  is longer than lineMax: it is being passed over and nothing is held). */
    const pieces: Buffer[] = []
    let pending = 0
    const take = (line: Buffer): void => {
      if (line.includes(FILE_CHANGE_MARK) || line.includes(TASK_COMPLETE_MARK)) applyRolloutLine(counted, line.toString('utf-8'))
    }
    let pos = start
    while (pos < end) {
      if (stale()) return null
      const len = Math.min(chunkBytes, end - pos)
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, pos)
      if (bytesRead <= 0) break
      editCountBytesRead += bytesRead
      pos += bytesRead
      const chunk = buf.subarray(0, bytesRead)
      let at = 0
      for (let nl = chunk.indexOf(0x0a, at); nl >= 0; nl = chunk.indexOf(0x0a, at)) {
        const part = chunk.subarray(at, nl)
        if (pending + part.length <= lineMax) take(pieces.length ? Buffer.concat([...pieces, part]) : part)
        pieces.length = 0
        pending = 0
        at = nl + 1
      }
      if (at < chunk.length) {
        const rest = chunk.subarray(at)
        if (pending + rest.length > lineMax) {
          pieces.length = 0
          pending = Number.POSITIVE_INFINITY
        } else {
          pieces.push(rest)
          pending += rest.length
          if (pending > editCountMostHeld) editCountMostHeld = pending
        }
      }
    }
    result = { added: counted.linesAdded, removed: counted.linesRemoved, turnMs: counted.turnMs }
  } catch {
    result = null
  } finally {
    if (fh) { try { await fh.close() } catch { /* already closed */ } }
  }
  // Asked last, once the file is closed: nothing runs between this answer
  // and the caller's use of the count.
  return result && !stale() ? result : null
}

// ── Mapper ───────────────────────────────────────────────────────────────────

/**
 * Convert a TokenCountEvent into a StatuslineData update.
 *
 * - inputTokens = input_tokens (cached_input_tokens is a SUBSET of it — verified
 *   against real rollouts where total_tokens == input_tokens + output_tokens)
 * - outputTokens = output_tokens (reasoning_output_tokens is likewise a subset)
 * - costUsd: computed via computeCodexCostUsd; undefined if model has no pricing entry
 * - contextUsedPercent: contextTokensInWindow / contextWindow * 100 when contextWindow is known
 * - no rate-limit field: withAllowance sets those from the validated allowance
 */

/** Tokens currently occupying the context window. Codex's `total_token_usage`
 *  is CUMULATIVE across the whole session, so `total / window` overshoots 100%
 *  after a few turns (the bar pinned red at ~96% on sessions whose window was
 *  mostly free, contradicting Codex's own "% left" footer). The window's real
 *  occupancy is the LAST request: its prompt (input_tokens, which already
 *  includes cached_input_tokens) + its output (which rides into the next turn).
 *  Falls back to the cumulative total on the first event, where the two are
 *  identical anyway. Exported for tests. */
export function contextTokensInWindow(tc: TokenCountEvent): number {
  const last = tc.last_token_usage
  const lastTokens = last ? (last.input_tokens ?? 0) + (last.output_tokens ?? 0) : 0
  return lastTokens > 0 ? lastTokens : tc.total_token_usage.total_tokens
}

export function mapTokenCountToStatusline(
  tc: TokenCountEvent,
  meta: RolloutMeta,
  sessionId: string,
  contextWindow: number | null = null,
): StatuslineData {
  const u = tc.total_token_usage

  const cost = computeCodexCostUsd(meta.model, {
    inputTokens: u.input_tokens,
    cachedInputTokens: u.cached_input_tokens,
    outputTokens: u.output_tokens,
  })

  const sl: StatuslineData = {
    sessionId,
    model: meta.model,
    reasoningEffort: meta.reasoningEffort,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    costUsd: cost ?? undefined,
    contextWindowSize: contextWindow ?? undefined,
    contextUsedPercent: contextWindow ? Math.min(100, (contextTokensInWindow(tc) / contextWindow) * 100) : undefined,
  }
  // The rate-limit fields come only from the validated allowance
  // (withAllowance), never from this event's raw rate_limits.
  return sl
}

/**
 * Put a session's allowance on a status line update (usage track MP2), from
 * the validated reading only: `usageBuckets` (one per window, labelled from
 * its length), `rateLimitsAt` (how old the reading is: its oldest limit's
 * event time, so a figure left behind never looks fresh), and the
 * legacy `rateLimitCurrent` / `rateLimitWeekly` pair from the default limit.
 * These are the only source of those fields (mapTokenCountToStatusline sets
 * none of them). With no reading none of them is set. Exported for tests.
 */
export function withAllowance(sl: StatuslineData, reading: AllowanceReading | null): StatuslineData {
  const out: StatuslineData = { ...sl }
  if (!reading) return out
  const buckets = readingToBuckets(reading)
  if (buckets.length > 0) out.usageBuckets = buckets
  if (reading.readingAt !== null) out.rateLimitsAt = reading.readingAt
  const main = reading.limits.find((l) => l.limitId === CODEX_DEFAULT_LIMIT_ID)
  if (main?.primary) {
    out.rateLimitCurrent = Math.round(main.primary.usedPercent)
    const iso = isoFromEpochMs(main.primary.resetsAt)
    if (iso) out.rateLimitCurrentResets = iso
  }
  if (main?.secondary) {
    out.rateLimitWeekly = Math.round(main.secondary.usedPercent)
    const iso = isoFromEpochMs(main.secondary.resetsAt)
    if (iso) out.rateLimitWeeklyResets = iso
  }
  return out
}

// ── Watch-and-claim pipeline ─────────────────────────────────────────────────

/**
 * Module-level count of the active watchers reading each rollout file path.
 * A NEW conversation's rollout is taken by one watcher only (the scan skips a
 * path any watcher reads), so two concurrent sessions never both latch onto
 * the same new file. A conversation named exactly (a resume by id, a pick, a
 * hook) is read by every session on it (P3.10: the P3.7 VM finding, a second
 * tab on a conversation another tab held showed no figures, where Claude shows
 * them in both). stop() and a release take the count down, so the map stays
 * bounded over the app's life.
 */
const readers = new Map<string, number>()
const claimed = {
  has: (p: string): boolean => (readers.get(p) ?? 0) > 0,
  add: (p: string): void => { readers.set(p, (readers.get(p) ?? 0) + 1) },
  delete: (p: string): void => {
    const n = (readers.get(p) ?? 0) - 1
    if (n > 0) readers.set(p, n)
    else readers.delete(p)
  },
}
/** How many watchers read `rolloutPath` (tests read it). */
export function __codexRolloutReadersForTests(rolloutPath: string): number { return readers.get(rolloutPath) ?? 0 }
/** P3.10: the one watcher per rollout that keeps its conversation's running
 *  time (P3.7); the others reading it show what main keeps. */
const keepers = new Map<string, object>()

/**
 * P3.6 (ADR-009 round 1, B1): the launches still waiting to claim a NEW
 * conversation, in every realm. Two new sessions in one folder of one realm,
 * started within the claim window, can take each other's rollout (P3.5's
 * recorded limit, until P3.10's exact claim). A claim made while another such
 * launch could have taken the same rollout, or while this launch saw more
 * than one rollout it could take, is reported as not certain, and so is the
 * later claim of every launch it competed with. A launch that has claimed
 * nothing counts as waiting from its start until its process ends (stop),
 * past its no-claim deadline too. The claim itself is P3.5's,
 * unchanged; a Switch account never carries a conversation claimed that way
 * (pty-manager).
 */
interface PendingNewClaim {
  sessionsDir: string
  cwd: string
  /** Whether this launch would take a new rollout that began at `at`. */
  admits(at: number): boolean
  /** Another launch's claim competed with this one: its own is not certain. */
  contested: boolean
}
const pendingNewClaims = new Set<PendingNewClaim>()

/**
 * How a watcher finds its rollout (P3.5, rows 34 and 38). All optional: a
 * launch that names none claims a new rollout by directory and time, as
 * before.
 */
export interface CodexClaimOptions {
  /** The conversation this launch resumes by id (`codex resume <id>`, an
   *  exact resume on relaunch or Restart): its rollout is claimed wherever
   *  it is in the realm, whatever its age, and no other rollout is. */
  resumeId?: string
  /** The rollout the launch chose for `resumeId` (the builder's lookup):
   *  claimed without walking the realm again, when it is still that
   *  conversation's plain file inside this realm's real folders. */
  resumePath?: string
  /** A conversation carried into this realm by Switch Account (ADR-023): when
   *  the rollout being read was carried, the time it was; its allowance, plan
   *  and credits then come only from events dated after it. Null (or absent):
   *  the whole rollout counts. Asked on every read, so a mark recorded later
   *  applies from the next read. Never throws (a throw counts as none). */
  allowanceAfter?: (rolloutPath: string) => number | null
  /** Where the resume picker records each decision it makes (P3.5 fix
   *  round 1): `{ id }` when it resumes that conversation, `{ fresh: true }`
   *  when it starts a new one (a New conversation choice, nothing to list,
   *  or the fallback after a resume failed). Read each poll, removed once
   *  read; the latest decision wins. Before the first, nothing is claimed;
   *  after `{ id }` only that conversation, claimed at once (VM finding V2); after
   *  `{ fresh }` only a new rollout created from the decision on. */
  pickFile?: string
  /** The pick file's folder as the builder made it (fix round 3): a pick
   *  is read, and anything there removed, only while the folder is still
   *  that one (the same device and file id, the same real path, not a
   *  link or junction). Without it no pick is read. */
  pickFolder?: PickFolderIdentity
  /** Told once which conversation the watcher claimed: its id and the
   *  directory its rollout records. Only a conversation id is reported.
   *  `certain` (P3.6): false when the rollout could have been another
   *  launch's (see pendingNewClaims); a resume by id, or the conversation a
   *  picker named, is always certain. `exact` (P3.10): the conversation is
   *  known, not inferred from a folder and a time: a resume by id, the one a
   *  picker named, or the one the session's own hook reported (told again,
   *  with `fromHook`, when a hook confirms an inferred claim). */
  onClaim?: (claim: { id: string; cwd: string; certain: boolean; exact: boolean; fromHook: boolean }) => void
  /** Told when a claim is let go: the picker decided again after it (fix
   *  round 2), so the session is no longer on that conversation. Told too
   *  when a later decision takes back a conversation reported by onShared. */
  onRelease?: () => void
  /** P3.6 (VM finding V2): told which conversation the session is on
   *  when another session holds its rollout: a resume by id, the
   *  conversation a picker named or the one its own hook reported is exact,
   *  so it is the session's all the same. P3.10: its rollout is read here
   *  too, so this tab shows the conversation's figures as the holder does. */
  onShared?: (conversation: { id: string; cwd: string; exact: boolean; fromHook: boolean }) => void
  /** P3.12 (rows 31, 32, 65): told the rollout claimed, each time onClaim or
   *  onShared is told (its path as this watcher's own checks found it inside
   *  the realm, the realm's sessions folder, whether the conversation is known
   *  exactly, whether another session holds it), and null each time a claim is
   *  let go. The session's logs, its name file and its GitHub Session Context
   *  read its conversation from this. */
  onRollout?: (rollout: { path: string; sessionsDir: string; exact: boolean; shared: boolean; identity?: string } | null) => void
}

/** How often a claim by id walks the realm's sessions folder while unclaimed:
 *  first after LOOKUP_INTERVAL_MS, the wait doubling after each walk that
 *  finds nothing, up to LOOKUP_INTERVAL_MAX_MS; after LOOKUP_MAX_MISSES such
 *  walks, not again until a new decision or a claim let go (P3.5 final
 *  round: a picked rollout removed after the picker listed it is not
 *  walked for once a second for the tab's life). */
const LOOKUP_INTERVAL_MS = 1_000
const LOOKUP_INTERVAL_MAX_MS = 30_000
const LOOKUP_MAX_MISSES = 10
/** The most of a pick file that is read. */
const PICK_FILE_MAX_BYTES = 1_024
/** How far before a New conversation decision a new rollout may say it began
 *  (the decision is dated by the pick file, or by its reading if earlier). */
const FRESH_DECISION_TOLERANCE_MS = 1_000
/** Open for reading without following a link where the platform can say so;
 *  elsewhere the opened file is compared with what lstat saw. */
const READ_NO_FOLLOW = fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)

/** A decision the resume picker recorded (see CodexClaimOptions.pickFile). */
type PickDecision = { kind: 'id'; id: string } | { kind: 'fresh'; at: number }

/** What a watcher reads of a rollout from its start (a claim, or a rollout
 *  replaced): all of it when it is no bigger than these two together, else
 *  its head (session_meta, the first task_started) and its tail (the newest
 *  events). A resumed conversation's rollout can be many megabytes. */
export const CLAIM_HEAD_BYTES = 256 * 1024
export const CLAIM_TAIL_BYTES = 1024 * 1024
/** The most a watcher reads of what a rollout gained since its last read; a
 *  larger gain is read from the start again (head and tail). */
export const READ_STEP_MAX_BYTES = 1024 * 1024

/** Bytes the watchers have read from rollouts after a claim (tests read it). */
let rolloutBytesRead = 0
export function __codexRolloutBytesReadForTests(): number { return rolloutBytesRead }

/** Bytes [start, end) of an open file, counted. */
function readSpan(fd: number, start: number, end: number): Buffer {
  const len = Math.max(0, end - start)
  const buf = Buffer.alloc(len)
  let got = 0
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, start + got)
    if (n <= 0) break
    got += n
  }
  rolloutBytesRead += got
  return got === len ? buf : buf.subarray(0, got)
}

/** Whether every folder from `sessionsDir` down to `dir` is a real folder,
 *  not a link or junction to one. */
function realFolderChain(sessionsDir: string, dir: string): boolean {
  const rel = relative(sessionsDir, dir)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
  let at = sessionsDir
  if (!isRealFolder(at)) return false
  for (const part of rel.split(sep)) {
    at = join(at, part)
    if (!isRealFolder(at)) return false
  }
  return true
}

/**
 * Watch and claim the Codex rollout file for a spawned session.
 *
 * Algorithm:
 * 1. Poll every 250ms for the session's rollout:
 *    - a launch that resumes a conversation by id (`resumeId`) claims that
 *      conversation's rollout wherever it is in the realm (rollout-lookup's
 *      findCodexRollout), and nothing else;
 *    - a launch through the resume picker (`pickFile`) claims the
 *      conversation the picker opened, at its decision, or a new one;
 *    - a new conversation: a rollout in one of the day folders (recomputed on
 *      every poll: today and yesterday, each by UTC and by local date, so a
 *      session crossing midnight is found) whose session_meta.cwd matches
 *      sessionCwd AND whose timestamp is within [spawnTimestamp - 5000ms, +inf).
 *      Only each file's first line is read, bounded; a file that settled as
 *      another session's is not read again.
 * 2. Once claimed, poll every 500ms. fs.watch is NOT used because on Windows
 *    it misses append events when the Codex CLI writer holds the file open --
 *    same failure mode that hit the Claude statusline in v1.2.134 (SMB
 *    writes). Each poll looks at the size first and reads only what the
 *    rollout gained; the claim reads it all when small, else its head and
 *    tail (CLAIM_HEAD_BYTES, CLAIM_TAIL_BYTES).
 * 3. If no claim happens within 10s, log a "still polling" warning. If still
 *    no claim at 30s, give up (--ephemeral path) and stop polling. The 30s
 *    cap accounts for cold-start delay -- on Windows, Codex 0.128.0 typically
 *    writes the first rollout event ~8s after spawn but a cold launch through
 *    the cmd.exe wrapper can run noticeably longer. A picker launch waits for
 *    the user instead: nothing runs until they pick, however long that takes.
 * 4. stop() clears both timeouts, the claim-poll interval, and the tail-poll
 *    interval, removes the path from the claimed set and the pick file.
 *
 * Windows path note: Codex records cwd exactly as provided by the OS at spawn
 * time. Pass the same resolvedCwd string from pty-manager (backslashes on
 * Windows) so the exact-string match works correctly.
 *
 * `sessionsDir` (WP2): the transcript folder of the realm the session runs in.
 * Required (WP2 commit 6g): there is no fallback to the ambient home, which
 * would claim another account's transcript. Without one nothing is watched.
 *
 * `onAllowance` (usage track MP3): handed the session's validated allowance
 * each time the rollout changes and carries one, for the Account usage page's
 * live figure (the package records it by `sessionsDir`). A throw in it never
 * stops the watch.
 */
export function watchAndClaimRollout(
  sessionId: string,
  sessionCwd: string,
  spawnTimestamp: number,
  onUpdate: (sl: StatuslineData) => void,
  sessionsDir: string,
  onAllowance?: (reading: AllowanceReading) => void,
  claimOpts?: CodexClaimOptions,
): TelemetrySource {
  if (typeof sessionsDir !== 'string' || !sessionsDir) return { stop() {} }
  // A resume id that is not a conversation id resumes nothing: claim as a new launch would.
  const resumeId = typeof claimOpts?.resumeId === 'string' && CODEX_CONVERSATION_ID_RE.test(claimOpts.resumeId) ? claimOpts.resumeId : undefined
  /** The rollout the launch chose for `resumeId`, tried once before any walk. */
  let givenPath: string | null = resumeId && typeof claimOpts?.resumePath === 'string' && claimOpts.resumePath ? claimOpts.resumePath : null
  const pickFile = typeof claimOpts?.pickFile === 'string' && claimOpts.pickFile ? claimOpts.pickFile : undefined
  const pickFolder = claimOpts?.pickFolder && typeof claimOpts.pickFolder.id === 'string' && typeof claimOpts.pickFolder.real === 'string' ? claimOpts.pickFolder : null
  const waitsForUser = !!pickFile && !resumeId

  let claimedPath: string | null = null
  let intervalHandle: ReturnType<typeof setInterval> | null = null
  let tailIntervalHandle: ReturnType<typeof setInterval> | null = null
  let stopped = false
  let contextWindow: number | null = null
  /** What the claimed rollout has said so far, and how far it has been read
   *  (through its last complete line). */
  let readState = newRolloutReadState()
  /** The carry mark of the rollout being read (claimOpts.allowanceAfter),
   *  asked afresh at each read. */
  let allowanceAfter: number | null = null
  let offset = 0
  /** How the claim was made (P3.10): known rather than inferred (a resume by
   *  id, a pick, the session's own hook), confirmed by that hook, and read
   *  beside another session that holds the same conversation. */
  let claimExact = false
  let claimFromHook = false
  let claimShared = false
  /** This watcher, as the keeper of a rollout's running time (keepers). */
  const self = {}
  /** The conversation read beside the tab that keeps its time; null when
   *  this watcher keeps it (run), or claims nothing. */
  let sharedRunId: string | null = null
  /** Files whose first line settled as not this session's: never read again. */
  const settled = new Set<string>()
  /** When the next walk may run, the wait after a walk that finds nothing,
   *  and the walks since one last found it. */
  let nextLookupAt = Number.NEGATIVE_INFINITY
  let lookupWait = LOOKUP_INTERVAL_MS
  let lookupMisses = 0
  /** When the realm was last walked: never again within LOOKUP_INTERVAL_MS,
   *  whatever looks again (a new decision, a claim let go). */
  let lastWalkAt = Number.NEGATIVE_INFINITY
  /** The claimed rollout as claimed: its device and file id, exact. The tail
   *  re-checks it is still reading the claimed file (P3.5 final round). */
  let claimedIdentity: string | null = null
  /** Set by a read that opened another file at the claimed path. */
  let claimedFileChanged = false
  /** P3.12 round 1 (B1): the claimed rollout's session_meta, to report again. */
  let claimedMeta: RolloutSessionMeta | null = null
  /** The picker's latest decision (none yet: nothing is claimed). */
  let decision: PickDecision | null = null
  /** A pick entry already dealt with (read, or refused), by its identity: never read again. */
  let handledPick: string | null = null
  /** This launch's run of the claimed conversation (P3.7, row 36): its id,
   *  the moment counted from (`start`: the launch, or later if main already
   *  kept time past it), the running time main kept of it before, and the
   *  spans of time whose completed turns are not in that (`windows`): the
   *  time main did not see before this run, and any gaps main kept. */
  let run: { id: string; start: number; before: number; windows: TurnWindow[] } | null = null
  /** Read states whose proven turns are not all counted: a background count
   *  of the part between the head and the tail is running, or gave none. */
  const turnsIncomplete = new WeakSet<RolloutReadState>()
  /** This launch among those waiting for a new conversation (P3.6); a resume
   *  by id never takes a new one. */
  const pending: PendingNewClaim | null = resumeId ? null : {
    sessionsDir,
    cwd: sessionCwd,
    admits: (at: number) => {
      // Waiting while its process runs (ADR-009 round 2, C2): a launch past
      // its no-claim deadline may still write the rollout another takes.
      if (stopped || claimedPath) return false
      if (pickFile) return decision?.kind === 'fresh' && at >= decision.at - FRESH_DECISION_TOLERANCE_MS
      return at >= spawnTimestamp - 5000
    },
    contested: false,
  }
  if (pending) pendingNewClaims.add(pending)

  /** Tell the session which conversation it is on and how that is known:
   *  onShared while another session reads the same rollout (P3.6 VM finding
   *  V2), else onClaim. */
  function report(found: RolloutSessionMeta, certain: boolean): void {
    if (!CODEX_CONVERSATION_ID_RE.test(found.id)) return
    try {
      if (claimShared && claimOpts?.onShared) claimOpts.onShared({ id: found.id, cwd: found.cwd, exact: claimExact, fromHook: claimFromHook })
      else if (!claimShared && claimOpts?.onClaim) claimOpts.onClaim({ id: found.id, cwd: found.cwd, certain, exact: claimExact, fromHook: claimFromHook })
    } catch { /* a listener never stops the watch */ }
    if (claimedPath && claimOpts?.onRollout) {
      // Round 1 (A1): with the claimed file's identity, so the index reads
      // only that file at the path.
      try { claimOpts.onRollout({ path: claimedPath, sessionsDir, exact: claimExact, shared: claimShared, ...(claimedIdentity ? { identity: claimedIdentity } : {}) }) } catch { /* a listener never stops the watch */ }
    }
  }

  /** Claim `fullPath` and read it. `how.exact`: the conversation is known
   *  (a resume by id, a pick, the session's own hook), not inferred from its
   *  folder and time; `how.shared`: another session reads it too (P3.10: it
   *  is read here all the same, so both tabs show its figures). */
  function claim(fullPath: string, found: RolloutSessionMeta, certain: boolean, how: { exact: boolean; shared?: boolean; fromHook?: boolean }): void {
    claimShared = how.shared === true
    claimExact = how.exact
    claimFromHook = how.fromHook === true
    claimedPath = fullPath
    claimed.add(fullPath)
    claimedIdentity = fileIdentity(fullPath)
    claimedFileChanged = false
    claimedMeta = found
    report(found, certain)

    // Its running time (P3.7, row 36), as Claude Code's Duration: what main
    // kept of the conversation's earlier runs, the turns its rollout records
    // as completed in the time main did not see (runs outside the app, or
    // before the app first ran it), and this run from its start: the launch,
    // or for the resume picker the choice made in it (Claude Code counts a
    // resumed conversation from its restore).
    // P3.10: one watcher keeps a rollout's running time (the first that read
    // it); another reading it beside that one shows what main keeps, counted
    // on to now, and takes the keeping over once the keeper has let go
    // (emit), so two tabs on one conversation still count their shared time
    // once (P3.7's review fix) and both show the same Duration.
    sharedRunId = null
    if (CODEX_CONVERSATION_ID_RE.test(found.id)) {
      if (!keepers.has(fullPath)) keepers.set(fullPath, self)
      if (keepers.get(fullPath) === self) beginRun(found.id, pickFile && !resumeId ? (decision?.kind === 'fresh' ? decision.at : Date.now()) : spawnTimestamp)
      else sharedRunId = found.id
    }

    // What is already there: all of it when small, else its head and its
    // tail (a resumed conversation's rollout can be large; P3.5 fix round 1).
    offset = 0
    if (readNew(fullPath)) emit()

    // Replaced fs.watch with a polling interval -- fs.watch on Windows
    // misses append events when the Codex CLI writer holds the file open
    // and appends progressively. Each poll looks at the size first and reads
    // only what the rollout gained, so a quiet rollout costs one stat.
    tailIntervalHandle = setInterval(() => {
      if (stopped || !claimedPath) return
      // The picker can decide again after a claim (fix round 2): a resume
      // that wrote to its rollout and then failed falls back to a new
      // conversation. A new decision lets this claim go and claims again by
      // the protocol.
      if (pickFile && !resumeId) {
        const next = readPick()
        if (next) { release(); decision = next; startClaimPolling(); return }
      }
      const read = readNew(claimedPath)
      // Another file at the claimed path (P3.5 final round): not read; the
      // claim is let go, as a new decision would, and claiming goes on.
      if (claimedFileChanged) { release(); startClaimPolling(); return }
      if (read) emit()
    }, 500)

    // Claimed -- the interval can stop polling
    if (intervalHandle) {
      clearInterval(intervalHandle)
      intervalHandle = null
    }
  }

  /** This launch's run of conversation `id`, launched at `launched`, from
   *  what main keeps of it now. Counted from no earlier than the time main
   *  already kept (P3.7 review): another tab's run of the conversation that
   *  ended after this launch began already counted the time they shared. */
  function beginRun(id: string, launched: number): void {
    const kept = conversationRunningTime(id)
    const start = kept ? Math.max(launched, kept.until) : launched
    // An empty span (a run launched as the last one ended) holds no turn,
    // and the store keeps no empty gap.
    run = {
      id,
      start,
      before: kept ? kept.ms : 0,
      windows: [...(kept ? kept.gaps : []), { from: kept ? kept.until : 0, to: start }],
    }
  }

  /** The claimed conversation's running time at `now`, with the turns
   *  `state` proves (P3.7). */
  function runningMs(r: { start: number; before: number }, state: RolloutReadState, now: number): number {
    return r.before + state.turnMs + Math.max(0, now - r.start)
  }

  /** Main keeps the run's running time up to `now` (P3.7): with the turns
   *  `state` proves once they are all counted; while they are not (a large
   *  rollout's background count is running, or gave none), without them, and
   *  the run's windows are kept as gaps for the next run to count (CI at
   *  427807fb: a run no longer waits on its count once it is over, so the
   *  count lets go of the rollout at once). */
  function keepRun(r: NonNullable<typeof run>, state: RolloutReadState, now: number): void {
    try {
      if (turnsIncomplete.has(state)) noteConversationRunningTime(r.id, r.before + Math.max(0, now - r.start), now, r.windows)
      else noteConversationRunningTime(r.id, runningMs(r, state, now), now)
    } catch (err) {
      console.warn(`[codex/telemetry] the running time of session ${sessionId} could not be kept: ${(err as Error)?.message ?? err}`)
    }
  }

  /** This run of the claimed conversation is over (the claim let go, or the
   *  watch ended with the process): main keeps its running time up to now. */
  function settleRun(): void {
    sharedRunId = null
    if (claimedPath && keepers.get(claimedPath) === self) keepers.delete(claimedPath)
    if (!run) return
    const r = run
    run = null
    keepRun(r, readState, Date.now())
  }

  /** Let the claim go: stop following its rollout, and say so. The status
   *  line no longer shows that conversation's figures (fix round 3): its
   *  tokens, cost and context go to zero until the next claim reports. */
  function release(): void {
    settleRun()
    if (tailIntervalHandle) { clearInterval(tailIntervalHandle); tailIntervalHandle = null }
    if (claimedPath) claimed.delete(claimedPath)
    claimedPath = null
    claimedIdentity = null
    claimedFileChanged = false
    claimedMeta = null
    claimExact = false
    claimFromHook = false
    claimShared = false
    resetLookup()
    readState = newRolloutReadState()
    offset = 0
    contextWindow = null
    try { onUpdate({ sessionId, inputTokens: 0, outputTokens: 0, costUsd: 0, contextUsedPercent: 0, linesAdded: 0, linesRemoved: 0, totalDurationMs: 0 }) } catch { /* a sink that throws never stops the watch */ }
    if (claimOpts?.onRelease) {
      try { claimOpts.onRelease() } catch { /* a listener never stops the watch */ }
    }
    if (claimOpts?.onRollout) {
      try { claimOpts.onRollout(null) } catch { /* a listener never stops the watch */ }
    }
  }

  /** The rollout of conversation `id` in this realm, looked up at most once a
   *  second, and whether another session reads it already (P3.10: it is
   *  read here too, as a shared claim, where before it was only reported).
   *  `preferCwd`: the folder a resume by id prefers (the session's own); a
   *  pick names a conversation, not a folder, and gives none (fix round 3:
   *  one picked from another worktree never records the session's folder,
   *  so preferring it would walk on to the walk's bounds on every pick). */
  function lookup(id: string, preferCwd?: string): { found: FoundRollout; shared: boolean } | null {
    if (lookupMisses >= LOOKUP_MAX_MISSES) return null
    const now = Date.now()
    if (now < nextLookupAt || now - lastWalkAt < LOOKUP_INTERVAL_MS) return null
    lastWalkAt = now
    const found = findCodexRollout(sessionsDir, id, undefined, preferCwd)
    if (!found) {
      lookupMisses++
      nextLookupAt = now + lookupWait
      lookupWait = Math.min(lookupWait * 2, LOOKUP_INTERVAL_MAX_MS)
      return null
    }
    lookupMisses = 0
    lookupWait = LOOKUP_INTERVAL_MS
    nextLookupAt = now + LOOKUP_INTERVAL_MS
    return { found, shared: claimed.has(found.path) }
  }

  /** Look again at once, at the first wait: a new decision, or a claim let go. */
  function resetLookup(): void {
    nextLookupAt = Number.NEGATIVE_INFINITY
    lookupWait = LOOKUP_INTERVAL_MS
    lookupMisses = 0
  }

  /** `file`'s device and file id, exact, when it is a plain file; else null. */
  function fileIdentity(file: string): string | null {
    try {
      const st = lstatSync(file, { bigint: true })
      return st.isFile() ? `${st.dev}:${st.ino}` : null
    } catch {
      return null
    }
  }

  /** `file`, when it is still a plain file whose session_meta names `id`. */
  function stillTheConversation(file: string, id: string): FoundRollout | null {
    try { if (!lstatSync(file).isFile()) return null } catch { return null }
    const head = readRolloutFirstLine(file)
    if (!head || head.kind !== 'line') return null
    const found = parseSessionMetaLine(head.line)
    return found && found.id.toLowerCase() === id.toLowerCase() ? { path: file, meta: found, dated: false } : null
  }

  /** The complete lines of `buf` into the read state: the bytes used (through
   *  its last newline; a line still being written waits for the next read). */
  function applyLines(buf: Buffer): number {
    const end = buf.lastIndexOf(0x0a) + 1
    if (end <= 0) return 0
    readState.allowanceAfter = allowanceAfter
    for (const line of buf.subarray(0, end).toString('utf-8').split('\n')) {
      if (line) applyRolloutLine(readState, line)
    }
    return end
  }

  /** Read what `file` gained since the last read: true when a line was read.
   *  The size first: no growth, nothing read. From the start (a claim, a
   *  rollout replaced by a smaller one, or a gain past READ_STEP_MAX_BYTES):
   *  all of it when it is no bigger than its head and tail, else its head
   *  (session_meta, the first task_started) and its tail (the newest
   *  events), each bounded; the edits between them are counted in the
   *  background (countBetween, P3.7). */
  function readNew(file: string): boolean {
    let fd: number | null = null
    allowanceAfter = null
    if (typeof claimOpts?.allowanceAfter === 'function') {
      try {
        const m = claimOpts.allowanceAfter(file)
        allowanceAfter = typeof m === 'number' && Number.isFinite(m) ? m : null
      } catch { allowanceAfter = null }
    }
    try {
      fd = openSync(file, 'r')
      // The tail re-checks it is still reading the claimed file (P3.5 final
      // round): the opened file must be the one claimed (device and file id,
      // recorded at the claim, or at this first read when the claim could
      // not record it); another file at that path is not read.
      const opened = fstatSync(fd, { bigint: true })
      const openedIdentity = `${opened.dev}:${opened.ino}`
      if (claimedIdentity === null) claimedIdentity = openedIdentity
      if (openedIdentity !== claimedIdentity) {
        claimedFileChanged = true
        return false
      }
      const size = Number(opened.size)
      if (offset > 0 && size === offset) return false
      if (offset === 0 || size < offset || size - offset > READ_STEP_MAX_BYTES) {
        readState = newRolloutReadState(run ? run.windows : [])
        if (size <= CLAIM_HEAD_BYTES + CLAIM_TAIL_BYTES) {
          offset = applyLines(readSpan(fd, 0, size))
          return offset > 0
        }
        const headUsed = applyLines(readSpan(fd, 0, CLAIM_HEAD_BYTES))
        const tailStart = size - CLAIM_TAIL_BYTES
        const tail = readSpan(fd, tailStart, size)
        // The tail's first line may be cut: it is skipped.
        const first = tail.indexOf(0x0a) + 1
        const used = first > 0 ? applyLines(tail.subarray(first)) : 0
        offset = first > 0 ? tailStart + first + used : size
        // The edits and completed turns between the head and the tail
        // (P3.7): counted in the background, whole lines only, so the lines
        // changed and the running time are the whole conversation's.
        countBetween(file, openedIdentity, headUsed, tailStart + first)
        return true
      }
      const used = applyLines(readSpan(fd, offset, size))
      offset += used
      return used > 0
    } catch {
      // Read error -- try again next poll
      return false
    } finally {
      if (fd !== null) { try { closeSync(fd) } catch { /* already closed */ } }
    }
  }

  /** The edits and completed turns in bytes [start, end) of the claimed
   *  rollout, which a head and tail read passed over, added to what this read
   *  state counted once the background count is done (P3.7). Until then (or
   *  if it gives none) the state's proven turns are not all counted. It is
   *  wanted only while the state is the watch's own: once the watch stopped,
   *  the claim was let go or the state was replaced by a later read from the
   *  start, it starts no further read and lets go of the rollout (CI at
   *  427807fb: on Windows a file still open keeps its folder from being
   *  removed). Another file at the path is never read (countRolloutRange). */
  function countBetween(file: string, identity: string, start: number, end: number): void {
    const state = readState
    const live = (): boolean => !stopped && readState === state
    turnsIncomplete.add(state)
    // Its last question to stale() comes after it closed the file, so the
    // answer still holds here.
    void countRolloutRange(file, identity, start, end, () => !live(), {}, state.turnWindows).then((n) => {
      if (!n) return
      state.linesAdded += n.added
      state.linesRemoved += n.removed
      state.turnMs += n.turnMs
      turnsIncomplete.delete(state)
      emit()
    }, () => { /* the count never stops the watch */ })
  }

  /** The status line from what the rollout has said, once its session_meta was read. */
  function emit(): void {
    const meta = readState.meta
    if (!meta) return
    if (readState.contextWindow != null && contextWindow == null) contextWindow = readState.contextWindow
    const allowance = readState.allowance
    if (allowance && onAllowance) {
      try { onAllowance(allowance) } catch { /* the live figure never stops the watch */ }
    }
    // The conversation's lines changed ride on every update (P3.7, row 36):
    // zero until an edit lands, as Claude Code reports them. So does its
    // running time, which main keeps as it goes (a relaunch after the app
    // itself stopped short carries on from the last update).
    const lines: Partial<StatuslineData> = { linesAdded: readState.linesAdded, linesRemoved: readState.linesRemoved }
    // P3.10: read beside another tab, and that tab has let go: this one keeps
    // the conversation's time from where main has it (that tab's end).
    if (!run && sharedRunId && claimedPath && !keepers.has(claimedPath)) {
      keepers.set(claimedPath, self)
      const id = sharedRunId
      sharedRunId = null
      beginRun(id, conversationRunningTime(id)?.until ?? Date.now())
    }
    if (run) {
      const now = Date.now()
      lines.totalDurationMs = runningMs(run, readState, now)
      keepRun(run, readState, now)
    } else if (sharedRunId) {
      // Beside the tab that keeps it: what main keeps, counted on to now.
      const kept = conversationRunningTime(sharedRunId)
      lines.totalDurationMs = kept ? kept.ms + Math.max(0, Date.now() - kept.until) : 0
    }
    try {
      if (readState.latest) {
        onUpdate({ ...withAllowance(mapTokenCountToStatusline(readState.latest, meta, sessionId, contextWindow), allowance), ...lines })
      } else if (allowance) {
        // Only the pre-response event so far: its allowance is already real.
        onUpdate({ ...withAllowance({ sessionId }, allowance), ...lines })
      }
    } catch { /* a sink that throws never stops the watch */ }
  }

  /** Whether the pick file's folder is still the one the builder made (fix
   *  round 3): a real folder, not a link or junction, with the same device
   *  and file id and the same real path. Looked at before every read and
   *  every removal there. */
  function pickFolderIntact(): boolean {
    if (!pickFile || !pickFolder) return false
    const now = codexFolderIdentity(dirname(pickFile))
    return !!now && now.id === pickFolder.id && now.real === pickFolder.real
  }

  function removePickFile(): void {
    if (!pickFile || !pickFolderIntact()) return
    // The folder check and the unlink are separate operations on the path
    // (Node has no unlinkat); see the pick file's limit in the P3.5 record.
    try { unlinkSync(pickFile) } catch { /* not there, or already gone */ }
  }

  /** A new decision the picker recorded, or null. Read only while the pick
   *  folder is the one made for the launch, and only when the pick
   *  path is a small regular file, never through a link (lstat, then the
   *  opened file compared with it, no-follow where the platform has it); an
   *  entry is dealt with once: read or refused, it is removed (a folder is
   *  left, and remembered as refused). The picker replaces the file whole
   *  (it renames a finished file into place), so what is read is complete. */
  function readPick(): PickDecision | null {
    if (!pickFile || !pickFolderIntact()) return null
    let st: ReturnType<typeof lstatSync> | undefined
    try { st = lstatSync(pickFile, { throwIfNoEntry: false }) } catch { return null }
    if (!st) return null
    const identity = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`
    if (identity === handledPick) return null
    const done = (): null => {
      handledPick = identity
      if (!st!.isDirectory()) removePickFile()
      return null
    }
    if (!st.isFile() || st.size > PICK_FILE_MAX_BYTES) return done()
    let text: string
    let fd: number | null = null
    try {
      fd = openSync(pickFile, READ_NO_FOLLOW)
      const opened = fstatSync(fd)
      const same = opened.isFile() && opened.dev === st.dev && (!st.ino || opened.ino === st.ino) && opened.size <= PICK_FILE_MAX_BYTES
      if (!same) return done()
      const buf = Buffer.alloc(opened.size)
      const n = opened.size > 0 ? readSync(fd, buf, 0, opened.size, 0) : 0
      text = buf.subarray(0, n).toString('utf-8')
    } catch {
      // Gone or replaced between the two looks: look again next poll.
      return null
    } finally {
      if (fd !== null) { try { closeSync(fd) } catch { /* already closed */ } }
    }
    // Still the folder made for the launch once read: else nothing is decided.
    if (!pickFolderIntact()) return null
    const at = Math.min(st.mtimeMs, Date.now())
    let parsed: { id?: unknown; fresh?: unknown } | null = null
    try { parsed = JSON.parse(text) as { id?: unknown; fresh?: unknown } } catch { parsed = null }
    done()
    if (parsed && typeof parsed.id === 'string' && CODEX_CONVERSATION_ID_RE.test(parsed.id)) return { kind: 'id', id: parsed.id }
    if (parsed && parsed.fresh === true) return { kind: 'fresh', at }
    return null
  }

  function tryClaim(): void {
    if (claimedPath || stopped) return

    if (resumeId) {
      // The rollout the launch chose (fix round 2): taken at once, without a
      // second walk, while it is still that conversation's plain file inside
      // this realm's real folders and no other session holds it; else a lookup.
      if (givenPath) {
        const given = givenPath
        givenPath = null
        const found = realFolderChain(sessionsDir, dirname(given)) ? stillTheConversation(given, resumeId) : null
        if (found) { claim(found.path, found.meta, true, { exact: true, shared: claimed.has(found.path) }); return }
      }
      const looked = lookup(resumeId, sessionCwd)
      if (looked) claim(looked.found.path, looked.found.meta, true, { exact: true, shared: looked.shared })
      return
    }

    // A picker launch claims only what the picker decided (P3.5 fix round
    // 1): nothing before its first decision, so a new rollout another
    // session writes in the same folder is never taken meanwhile.
    let since = spawnTimestamp - 5000
    if (pickFile) {
      const next = readPick()
      if (next) { decision = next; resetLookup() }
      if (!decision) return
      if (decision.kind === 'fresh') {
        // A new conversation: only a rollout created from the decision on.
        since = decision.at - FRESH_DECISION_TOLERANCE_MS
      } else {
        // The conversation the picker opened (P3.5 VM finding V2): claimed at
        // the decision, as a resume by id is at its launch, so its status
        // line shows at once rather than at its first new turn. Only its own
        // rollout, with the checks a launch's chosen rollout gets: inside this
        // realm's real folders, a plain file whose session_meta names the id
        // (the walk); one another session holds is read here too (P3.10,
        // shared). A resume that then fails
        // falls back to a new conversation, and that decision lets this
        // claim go (release).
        const looked = lookup(decision.id)
        if (looked && realFolderChain(sessionsDir, dirname(looked.found.path))) claim(looked.found.path, looked.found.meta, true, { exact: true, shared: looked.shared })
        // Only the named conversation is this session's.
        return
      }
    }

    const now = Date.now()
    // The first rollout this launch would take (P3.5's claim, unchanged), and
    // how many it could take (P3.6: more than one is not a certain claim).
    let first: { path: string; meta: RolloutSessionMeta } | null = null
    let candidates = 0
    for (const dateDir of codexDayFolders(sessionsDir, [now, now - 24 * 3600 * 1000])) {
      // Real folders only, at every level, and plain files only: a link or
      // junction anywhere on the way is not followed (P3.5 fix round 1).
      if (!realFolderChain(sessionsDir, dateDir)) continue
      let files: string[]
      try {
        files = readdirSync(dateDir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'))
          .map((e) => e.name)
      } catch {
        continue
      }

      for (const f of files) {
        const fullPath = join(dateDir, f)
        if (claimed.has(fullPath) || settled.has(fullPath)) continue
        const head = readRolloutFirstLine(fullPath)
        // Not readable just now, or its first line still being written: read it again next poll.
        if (!head || head.kind === 'partial') continue
        if (head.kind === 'too-long') { settled.add(fullPath); continue }
        const found = parseSessionMetaLine(head.line)
        if (found && found.cwd === sessionCwd && found.at >= since) {
          candidates++
          if (!first) first = { path: fullPath, meta: found }
          continue
        }
        settled.add(fullPath)
      }
    }
    if (!first) return
    // Certain only when no other launch waiting for a new conversation in
    // this realm and folder could take this rollout, this launch saw no other
    // it could take, and no earlier claim competed with this launch; every
    // launch this claim competes with is marked, so its own claim is not
    // certain either.
    const at = first.meta.at
    const rivals = [...pendingNewClaims].filter((p) => p !== pending && sameDirectory(p.sessionsDir, sessionsDir) && p.cwd === sessionCwd && p.admits(at))
    for (const p of rivals) p.contested = true
    claim(first.path, first.meta, candidates === 1 && rivals.length === 0 && !pending?.contested, { exact: false })
  }

  /** `rolloutPath` as this realm's rollout it names, spelled as the walk
   *  spells it (the realm's sessions folder, then its year, month and day
   *  folders and the file's own name, as its day folder lists it), or null:
   *  it must lie in a day folder of this realm (real folders at every level,
   *  never a link), be a plain file named `rollout-...-<id>.jsonl`, and its
   *  session_meta must name that id. Untrusted input (a hook's payload):
   *  refused on any doubt. P3.10 round 1 (A4): no `:` after the drive (a
   *  Windows alternate data stream, `rollout-x:y-<id>.jsonl`, is not a
   *  file of the folder); and the name is the day folder's own spelling of
   *  it, so a name spelled in another case (the id in capitals, on a file
   *  system that ignores case) is the same rollout, read and counted under
   *  one key, never a second. */
  function exactRollout(rolloutPath: string): { path: string; meta: RolloutSessionMeta } | null {
    if (typeof rolloutPath !== 'string' || !rolloutPath || rolloutPath.length > 4096 || /[\x00-\x1f\x7f]/.test(rolloutPath)) return null
    if (!isAbsolute(rolloutPath)) return null
    if ((/^[A-Za-z]:/.test(rolloutPath) ? rolloutPath.slice(2) : rolloutPath).includes(':')) return null
    const rel = relative(sessionsDir, rolloutPath)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    const parts = rel.split(sep)
    if (parts.length !== 4) return null
    const [year, month, day, given] = parts
    if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) return null
    const dayDir = join(sessionsDir, year, month, day)
    if (!realFolderChain(sessionsDir, dayDir)) return null
    const name = dayFolderSpelling(dayDir, given)
    if (!name) return null
    const m = /^rollout-.+-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/.exec(name)
    if (!m) return null
    const found = stillTheConversation(join(dayDir, name), m[1].toLowerCase())
    return found ? { path: found.path, meta: found.meta } : null
  }

  /** The day folder's own spelling of `given`: the entry of that name, or,
   *  where the file system ignores case (Windows, macOS), the one entry that
   *  differs from it in case only; null when there is none (or two). */
  function dayFolderSpelling(dayDir: string, given: string): string | null {
    let names: string[]
    try { names = readdirSync(dayDir) } catch { return null }
    if (names.includes(given)) return given
    if (process.platform !== 'win32' && process.platform !== 'darwin') return null
    const want = given.toLowerCase()
    const same = names.filter((n) => n.toLowerCase() === want)
    return same.length === 1 ? same[0] : null
  }

  // Set up the 250ms polling interval before the initial tryClaim() call so
  // that if tryClaim() claims synchronously, it can clear intervalHandle
  // correctly. Started again when a claim is let go.
  function startClaimPolling(): void {
    if (intervalHandle) clearInterval(intervalHandle)
    intervalHandle = setInterval(() => {
      if (claimedPath || stopped) {
        if (intervalHandle) {
          clearInterval(intervalHandle)
          intervalHandle = null
        }
        return
      }
      tryClaim()
    }, 250)

    // Initial attempt -- avoids waiting 250ms before the first probe.
    tryClaim()
  }
  startClaimPolling()

  // No-claim deadline. P3.5 dev smoke showed Codex 0.128.0 takes ~8s to write the
  // first rollout event on Windows after the cmd.exe wrapper warms up; cold starts
  // can run longer. We warn at 10s (so the user sees something is slow) but keep
  // polling until 30s before giving up. Hitting 30s genuinely indicates --ephemeral
  // or a launch failure. A picker launch has no deadline: it waits for the user.
  // P3.10 round 1 (Q4): the same deadline is armed again whenever claiming
  // starts again after a refuted claim (refuteInferredClaim), so that polling
  // stops too; the session's own hook still claims exactly at any time.
  let warnHandle: ReturnType<typeof setTimeout> | null = null
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  function armClaimDeadline(): void {
    if (warnHandle) clearTimeout(warnHandle)
    if (timeoutHandle) clearTimeout(timeoutHandle)
    warnHandle = setTimeout(() => {
      if (!claimedPath && !stopped) {
        console.warn(
          `[codex/telemetry] no rollout claimed for session ${sessionId} after 10s -- still polling, will give up at 30s`,
        )
      }
    }, 10_000)
    timeoutHandle = setTimeout(() => {
      if (!claimedPath && !stopped) {
        console.warn(
          `[codex/telemetry] no rollout claimed for session ${sessionId} after 30s -- assuming --ephemeral`,
        )
        if (intervalHandle) {
          clearInterval(intervalHandle)
          intervalHandle = null
        }
        // Nothing will report this session's allowance (D3: "no reading").
        try { onUpdate({ sessionId, usageUnavailable: 'no-reading' }) } catch { /* the sink must not break the watcher */ }
      }
    }, 30_000)
  }
  if (!waitsForUser) armClaimDeadline()

  return {
    /** P3.10: the session's own hook (authenticated by its gateway token)
     *  reported the rollout its Codex is on. That is exact, as Claude's
     *  SessionStart bind is (#480): a claim of the same file becomes exact;
     *  a claim of another file (an inferred claim that took the wrong new
     *  rollout, or a conversation switched inside the TUI with its own resume
     *  or new) is let go and this one claimed, read beside any other session
     *  on it. A picker launch's decisions are the picker's word; this is the
     *  process's own, and wins. */
    noteExactRollout(rolloutPath: string): { id: string; cwd: string } | null {
      if (stopped) return null
      const exact = exactRollout(rolloutPath)
      if (!exact) return null
      if (claimedPath === exact.path) {
        if (!claimExact || !claimFromHook) {
          claimExact = true
          claimFromHook = true
          report(exact.meta, true)
        }
        return { id: exact.meta.id, cwd: exact.meta.cwd }
      }
      if (claimedPath) release()
      if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null }
      claim(exact.path, exact.meta, true, { exact: true, fromHook: true, shared: claimed.has(exact.path) })
      return { id: exact.meta.id, cwd: exact.meta.cwd }
    },
    /** P3.12 round 1 (B1) and round 2 (Q3): a claim made beside another
     *  session's (shared) whose holder has since let it go (its inferred
     *  claim refuted, or its session stopped): this watcher holds it now,
     *  and says so again. True when it did. */
    recheckShared(): boolean {
      if (stopped || !claimedPath || !claimShared || !claimedMeta) return false
      // Another watcher still reads it (this one is counted too): still shared.
      if ((readers.get(claimedPath) ?? 0) > 1) return false
      claimShared = false
      report(claimedMeta, true)
      return true
    },
    /** P3.10: another session's own hook proved `rolloutPath` is that
     *  session's conversation. An inferred claim of it here (a new
     *  conversation taken by folder and time) was the wrong one: it is let
     *  go, never taken by inference again, and claiming goes on. An exact
     *  claim (a resume by id, a pick, this session's own hook) is kept: two
     *  tabs can be on one conversation. */
    refuteInferredClaim(rolloutPath: string): boolean {
      if (stopped || !claimedPath || claimExact) return false
      const exact = exactRollout(rolloutPath)
      if (!exact || exact.path !== claimedPath) return false
      settled.add(exact.path)
      release()
      startClaimPolling()
      // Round 1 (Q4): claiming by inference stops again at the deadline.
      if (!stopped && !claimedPath) armClaimDeadline()
      return true
    },
    stop(): void {
      stopped = true
      // The run is over with its process (P3.7): its running time is kept.
      settleRun()
      if (pending) pendingNewClaims.delete(pending)
      if (warnHandle) clearTimeout(warnHandle)
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (intervalHandle) {
        clearInterval(intervalHandle)
        intervalHandle = null
      }
      if (tailIntervalHandle) {
        clearInterval(tailIntervalHandle)
        tailIntervalHandle = null
      }
      if (claimedPath) {
        claimed.delete(claimedPath)
        claimedPath = null
      }
      // The pick file's own folder (fix round 2), made for this launch, while
      // it is still that folder (fix round 3): the pick file, and any new
      // file a picker stopped between its write and its rename left
      // (`pick.json.<16 hex>.tmp`), are removed, then the folder, never
      // recursively: anything else there keeps it. Any other folder is left.
      if (pickFile && pickFolderIntact()) {
        removePickFile()
        const dir = dirname(pickFile)
        const prefix = `${basename(pickFile)}.`
        try {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (!e.isFile() || !e.name.startsWith(prefix) || !e.name.endsWith('.tmp')) continue
            if (!/^[0-9a-f]{16}$/.test(e.name.slice(prefix.length, -'.tmp'.length))) continue
            try { unlinkSync(join(dir, e.name)) } catch { /* gone */ }
          }
        } catch { /* not listed: left */ }
        if (/^ccc-codex-pick-/.test(basename(dir))) {
          try { rmdirSync(dir) } catch { /* not empty, or gone */ }
        }
      }
    },
  }
}
