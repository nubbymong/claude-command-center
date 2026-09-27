/**
 * Codex allowances as one validated reading (usage track MP2).
 *
 * Codex reports an account's allowances in two shapes: the `rate_limits` of a
 * rollout's `token_count` event (snake_case, one limit per event) and the
 * result of the app-server's `account/rateLimits/read` (camelCase, the default
 * limit plus a map of every limit; ADR-022). Both are normalised here into one
 * provider-neutral `AllowanceReading`, and from that into the usage buckets
 * the page, the footer and the strip draw.
 *
 * Everything is treated as untrusted: only own properties of plain objects are
 * read, percentages are clamped to 0-100, a window length must be a positive
 * whole number of minutes, a reset time must fall within 60 days of the
 * reading, the plan must be one this build knows, a limit id must be a short
 * plain identifier and a limit name short and printable. Anything else is
 * dropped, never repaired, and fields this code does not use (account id,
 * credits, upsell, the fields later CLIs added) are never copied.
 */

import type { AllowanceLimit, AllowanceReading, AllowanceWindow, UsageBucket } from '../../../shared/usage-types'
import { planLabelFor } from '../../../shared/usage-types'
import { windowLabel } from '../../../shared/usage-labels'

/** The account-wide limit's id; any other id is a separate metered limit. */
export const CODEX_DEFAULT_LIMIT_ID = 'codex'

export type CodexRateLimitSource = 'rollout' | 'app-server'

const MAX_LIMITS = 8
const MAX_WINDOW_MINUTES = 366 * 1440
const RESET_BOUND_MS = 60 * 24 * 60 * 60 * 1000
const LIMIT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const LIMIT_NAME_MAX = 40
// Control, format (bidi overrides and the like) and line/paragraph separators.
const UNPRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

type Plain = Record<string, unknown>

/** A plain object, as JSON.parse makes: not an array, not a class instance,
 *  not an object that inherits from another. */
function isPlain(v: unknown): v is Plain {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function own(o: Plain, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined
}

/** The protocol's names for the fields this code reads, per source. */
const NAMES = {
  'rollout': { limitId: 'limit_id', limitName: 'limit_name', planType: 'plan_type', used: 'used_percent', minutes: 'window_minutes', resets: 'resets_at' },
  'app-server': { limitId: 'limitId', limitName: 'limitName', planType: 'planType', used: 'usedPercent', minutes: 'windowDurationMins', resets: 'resetsAt' },
} as const

type Names = (typeof NAMES)[CodexRateLimitSource]

function readWindow(raw: unknown, n: Names, reference: number): AllowanceWindow | null {
  if (!isPlain(raw)) return null
  const used = own(raw, n.used)
  if (typeof used !== 'number' || !Number.isFinite(used)) return null
  const minutes = own(raw, n.minutes)
  const resets = own(raw, n.resets)
  let resetsAt: number | null = null
  if (typeof resets === 'number' && Number.isFinite(resets)) {
    const ms = resets * 1000
    if (Math.abs(ms - reference) <= RESET_BOUND_MS) resetsAt = ms
  }
  return {
    windowMinutes: typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0 && minutes <= MAX_WINDOW_MINUTES ? minutes : null,
    usedPercent: Math.min(100, Math.max(0, used)),
    resetsAt,
  }
}

function readLimitName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (t.length === 0 || t.length > LIMIT_NAME_MAX || UNPRINTABLE_RE.test(t)) return null
  return t
}

interface Snapshot { limit: AllowanceLimit | null; planType: string | null }

/** One snapshot; null when it cannot be trusted at all (not a plain object, or
 *  a limit id that is present but not a plain identifier). */
function readSnapshot(raw: unknown, n: Names, reference: number): Snapshot | null {
  if (!isPlain(raw)) return null
  const id = own(raw, n.limitId)
  let limitId: string
  if (id === undefined || id === null) limitId = CODEX_DEFAULT_LIMIT_ID
  else if (typeof id === 'string' && LIMIT_ID_RE.test(id)) limitId = id
  else return null
  const plan = own(raw, n.planType)
  const planType = planLabelFor(plan) !== null ? (plan as string) : null
  const primary = readWindow(own(raw, 'primary'), n, reference)
  const secondary = readWindow(own(raw, 'secondary'), n, reference)
  const limit = primary || secondary
    ? { limitId, limitName: readLimitName(own(raw, n.limitName)), primary, secondary }
    : null
  return { limit, planType }
}

/** Default limit first, then the others by id; one entry per id, at most eight. */
function orderLimits(limits: AllowanceLimit[]): AllowanceLimit[] {
  const byId = new Map<string, AllowanceLimit>()
  for (const l of limits) byId.set(l.limitId, l)
  const others = [...byId.values()].filter((l) => l.limitId !== CODEX_DEFAULT_LIMIT_ID).sort((a, b) => (a.limitId < b.limitId ? -1 : a.limitId > b.limitId ? 1 : 0))
  const first = byId.get(CODEX_DEFAULT_LIMIT_ID)
  return (first ? [first, ...others] : others).slice(0, MAX_LIMITS)
}

/**
 * Normalise Codex's allowance report into one reading.
 *
 * - `'rollout'`: `raw` is a `token_count` event's `rate_limits`; a snapshot
 *   with no limit id (older CLIs) is the default limit.
 * - `'app-server'`: `raw` is the `account/rateLimits/read` result
 *   (`{ rateLimits, rateLimitsByLimitId }`).
 *
 * `at` is when the reading was taken (the event time, or the read time),
 * epoch ms, and becomes `readingAt`; reset times must fall within 60 days of
 * it (of `now` when it is unknown), so an old transcript keeps its own resets.
 * Null when nothing usable is left: no limit with a window and no plan.
 */
export function normaliseCodexRateLimits(
  raw: unknown,
  source: CodexRateLimitSource,
  at: number | null,
  now: number = Date.now(),
): AllowanceReading | null {
  const n = NAMES[source]
  const readingAt = typeof at === 'number' && Number.isFinite(at) ? at : null
  const reference = readingAt ?? now
  const snapshots: Snapshot[] = []
  if (source === 'rollout') {
    const s = readSnapshot(raw, n, reference)
    if (s) snapshots.push(s)
  } else {
    if (!isPlain(raw)) return null
    const main = readSnapshot(own(raw, 'rateLimits'), n, reference)
    if (!main) return null
    snapshots.push(main)
    const map = own(raw, 'rateLimitsByLimitId')
    if (isPlain(map)) {
      for (const key of Object.keys(map).sort()) {
        const s = readSnapshot(own(map, key), n, reference)
        if (s) snapshots.push(s)
      }
    }
  }
  const limits = orderLimits(snapshots.flatMap((s) => (s.limit ? [s.limit] : [])))
  const planType = snapshots.find((s) => s.planType !== null)?.planType ?? null
  if (limits.length === 0 && planType === null) return null
  return { limits, planType, readingAt }
}

/**
 * Merge readings taken over time (a session's `token_count` events, oldest
 * first): each limit keeps its newest reading, the plan is the newest one
 * reported, and the reading time is the newest. Null when there is nothing.
 */
export function mergeAllowanceReadings(readings: readonly (AllowanceReading | null)[]): AllowanceReading | null {
  const present = readings.filter((r): r is AllowanceReading => r !== null)
  if (present.length === 0) return null
  const limits: AllowanceLimit[] = []
  let planType: string | null = null
  let readingAt: number | null = null
  for (const r of present) {
    limits.push(...r.limits)
    if (r.planType !== null) planType = r.planType
    if (r.readingAt !== null) readingAt = readingAt === null ? r.readingAt : Math.max(readingAt, r.readingAt)
  }
  // orderLimits keeps the LAST entry per id: the newest reading of each limit.
  return { limits: orderLimits(limits), planType, readingAt }
}

/**
 * The usage buckets a reading draws as. The default limit gives time-window
 * buckets keyed `codex/<minutes>:` and labelled from the window length ("5h",
 * "Weekly"); any other limit gives per-limit buckets keyed
 * `<limitId>/<minutes>:<name>` and labelled "<name> <window>", so
 * `isModelBucket` treats them like Claude's per-model buckets. A window with
 * no length is labelled by its position, as the legacy fields always were
 * (primary "5h", secondary "Weekly"). A repeated key is dropped.
 */
export function readingToBuckets(reading: AllowanceReading | null): UsageBucket[] {
  if (!reading) return []
  const out: UsageBucket[] = []
  const seen = new Set<string>()
  for (const limit of reading.limits) {
    const isDefault = limit.limitId === CODEX_DEFAULT_LIMIT_ID
    const name = limit.limitName ?? limit.limitId
    for (const slot of ['primary', 'secondary'] as const) {
      const w = limit[slot]
      if (!w) continue
      const window = windowLabel(w.windowMinutes) ?? (slot === 'primary' ? '5h' : 'Weekly')
      const key = `${limit.limitId}/${w.windowMinutes ?? slot}:${isDefault ? '' : name}`
      if (seen.has(key)) continue
      seen.add(key)
      const weekly = w.windowMinutes !== null ? w.windowMinutes >= 10080 : slot === 'secondary'
      out.push({
        key,
        label: isDefault ? window : `${name} ${window}`,
        group: weekly ? 'weekly' : 'session',
        percent: Math.round(w.usedPercent),
        resetsAt: w.resetsAt !== null ? new Date(w.resetsAt).toISOString() : '',
        severity: 'normal',
      })
    }
  }
  return out
}
