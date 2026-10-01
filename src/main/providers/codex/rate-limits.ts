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
 * reading and inside the Date range, the plan must be one this build knows, a
 * limit id must be a short plain identifier (never "__proto__" and the like)
 * and a limit name short and printable. Anything else is
 * dropped, never repaired, and fields this code does not use (account id,
 * upsell, the fields later CLIs added) are never copied.
 *
 * The one addition (P3.14, ADR-023): the account's credits count, three
 * fields only and each validated: `hasCredits` and `unlimited` booleans (else
 * the whole is dropped), `balance` a plain decimal string (else null). They
 * are read from the rollout snapshot itself, or from the answer's own
 * `rateLimits`; never from an entry of the per-limit map. Codex credits are a
 * count, not money. They belong to the account-wide (default) limit's report,
 * the one the main bars come from, and have three states: a figure; `null`,
 * "none now" (the key is null, as an account without credits writes it, or it
 * is present and unusable); and no statement (the key is absent, or the
 * snapshot is a sub-limit's, whose credits are never read). A later report's
 * null clears an earlier figure; no statement leaves it.
 */

import type { AllowanceCredits, AllowanceLimit, AllowanceReading, AllowanceWindow, UsageBucket } from '../../../shared/usage-types'
import { planLabelFor } from '../../../shared/usage-types'
import { windowLabel } from '../../../shared/usage-labels'

/** The account-wide limit's id; any other id is a separate metered limit. */
export const CODEX_DEFAULT_LIMIT_ID = 'codex'

export type CodexRateLimitSource = 'rollout' | 'app-server'

const MAX_LIMITS = 8
const MAX_WINDOW_MINUTES = 366 * 1440
const RESET_BOUND_MS = 60 * 24 * 60 * 60 * 1000
const LIMIT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
/** Names an object's own machinery answers to: never a limit id. */
const RESERVED_IDS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])
/** The largest epoch ms a Date can hold: past it toISOString throws. */
const MAX_DATE_MS = 8.64e15
/** How far past now a reading's time may claim to be (clock skew between the
 *  CLI's clock and this app's): later is held to now plus this, so a reading
 *  stamped in the far future can neither look fresh for ever nor outrank every
 *  later reading. */
const FUTURE_SKEW_MS = 5 * 60 * 1000
const LIMIT_NAME_MAX = 40
/** A credits balance as the CLI writes it: a plain non-negative decimal, at
 *  most 13 integer and 12 fraction digits (the real one has 10 fraction
 *  digits). ASCII digits only; no sign, exponent, space or separator. */
const BALANCE_RE = /^\d{1,13}(\.\d{1,12})?$/
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

const isLimitId = (v: unknown): v is string => typeof v === 'string' && LIMIT_ID_RE.test(v) && !RESERVED_IDS.has(v)

/** An epoch-ms time a Date can hold, or null. */
const dateMs = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_DATE_MS ? v : null)

/** ISO text for an epoch-ms time, or '' for one a Date cannot hold (never throws). */
export function isoFromEpochMs(ms: number | null): string {
  const v = dateMs(ms)
  return v === null ? '' : new Date(v).toISOString()
}

/** The protocol's names for the fields this code reads, per source. */
const NAMES = {
  'rollout': { limitId: 'limit_id', limitName: 'limit_name', planType: 'plan_type', used: 'used_percent', minutes: 'window_minutes', resets: 'resets_at', has: 'has_credits' },
  'app-server': { limitId: 'limitId', limitName: 'limitName', planType: 'planType', used: 'usedPercent', minutes: 'windowDurationMins', resets: 'resetsAt', has: 'hasCredits' },
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
    const ms = dateMs(resets * 1000)
    if (ms !== null && Math.abs(ms - reference) <= RESET_BOUND_MS) resetsAt = ms
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

/** The account's credits count: the three validated fields, or null (null,
 *  not a plain object, or a flag that is not a boolean). A balance that is not
 *  a plain decimal is null, the flags kept (the regex bounds it to at most 25
 *  digits, so the Number is always finite). Never throws and copies no other
 *  key. */
function readCredits(raw: unknown, n: Names): AllowanceCredits | null {
  if (!isPlain(raw)) return null
  const hasCredits = own(raw, n.has)
  const unlimited = own(raw, 'unlimited')
  if (typeof hasCredits !== 'boolean' || typeof unlimited !== 'boolean') return null
  const text = own(raw, 'balance')
  const balance = typeof text === 'string' && BALANCE_RE.test(text) ? Number(text) : null
  return { hasCredits, unlimited, balance }
}

/** `credits`: see the header (a figure, null for "none now", undefined for no
 *  statement). */
interface Snapshot { limit: AllowanceLimit | null; planType: string | null; credits: AllowanceCredits | null | undefined }

/** One snapshot; null when it cannot be trusted at all (not a plain object, or
 *  a limit id that is present but not a plain identifier). A snapshot with no
 *  id of its own is `fallbackId`'s: the default limit for a rollout's or the
 *  answer's own snapshot, its key for an entry of the per-limit map. */
function readSnapshot(raw: unknown, n: Names, reference: number, readingAt: number | null, fallbackId: string): Snapshot | null {
  if (!isPlain(raw)) return null
  const id = own(raw, n.limitId)
  let limitId: string
  if (id === undefined || id === null) limitId = fallbackId
  else if (isLimitId(id)) limitId = id
  else return null
  const plan = own(raw, n.planType)
  const planType = planLabelFor(plan) !== null ? (plan as string) : null
  const primary = readWindow(own(raw, 'primary'), n, reference)
  const secondary = readWindow(own(raw, 'secondary'), n, reference)
  const limit = primary || secondary
    ? { limitId, limitName: readLimitName(own(raw, n.limitName)), readingAt, primary, secondary }
    : null
  // Only the default limit's snapshot speaks for the account's credits, and
  // only when it has the key: a figure, or null (null, or unusable).
  const rawCredits = own(raw, 'credits')
  const credits = limitId === CODEX_DEFAULT_LIMIT_ID && rawCredits !== undefined ? readCredits(rawCredits, n) : undefined
  return { limit, planType, credits }
}

/** The oldest time among limits, or null when none has one. */
function oldestOf(limits: readonly AllowanceLimit[]): number | null {
  let out: number | null = null
  for (const l of limits) if (l.readingAt !== null && (out === null || l.readingAt < out)) out = l.readingAt
  return out
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
 * epoch ms, and becomes each limit's `readingAt` (null outside the Date
 * range, and never later than `now` plus five minutes); reset times must fall within 60 days of it (of `now` when it is
 * unknown), so an old transcript keeps its own resets. An entry of the
 * per-limit map with no id of its own takes its key; one whose own id is not
 * its key, or whose key is not a plain identifier, is dropped: no entry can
 * stand in for the default limit. Null when nothing usable is left: no limit
 * with a window and no plan.
 */
export function normaliseCodexRateLimits(
  raw: unknown,
  source: CodexRateLimitSource,
  at: number | null,
  now: number = Date.now(),
): AllowanceReading | null {
  const n = NAMES[source]
  const reported = dateMs(at)
  const latest = Number.isFinite(now) ? now + FUTURE_SKEW_MS : null
  const readingAt = reported !== null && latest !== null && reported > latest ? latest : reported
  const reference = readingAt ?? now
  const snapshots: Snapshot[] = []
  if (source === 'rollout') {
    const s = readSnapshot(raw, n, reference, readingAt, CODEX_DEFAULT_LIMIT_ID)
    if (s) snapshots.push(s)
  } else {
    if (!isPlain(raw)) return null
    const main = readSnapshot(own(raw, 'rateLimits'), n, reference, readingAt, CODEX_DEFAULT_LIMIT_ID)
    if (!main) return null
    snapshots.push(main)
    const map = own(raw, 'rateLimitsByLimitId')
    if (isPlain(map)) {
      for (const key of Object.keys(map).sort()) {
        if (!isLimitId(key)) continue
        const entry = own(map, key)
        const ownId = isPlain(entry) ? own(entry, n.limitId) : undefined
        if (ownId !== undefined && ownId !== null && ownId !== key) continue
        const s = readSnapshot(entry, n, reference, readingAt, key)
        if (s) snapshots.push(s)
      }
    }
  }
  const limits = orderLimits(snapshots.flatMap((s) => (s.limit ? [s.limit] : [])))
  const planType = snapshots.find((s) => s.planType !== null)?.planType ?? null
  if (limits.length === 0 && planType === null) return null
  // Every limit here was read at the same moment: the reading is as old as it.
  const out: AllowanceReading = { limits, planType, readingAt }
  // The credits of the rollout's own snapshot or the answer's own `rateLimits`
  // (the first snapshot of either): never an entry of the per-limit map. A
  // figure, or null ("none now"); no key at all when it makes no statement.
  const credits = snapshots[0].credits
  if (credits !== undefined) out.credits = credits
  return out
}

/**
 * Merge readings taken over time (a session's `token_count` events, oldest
 * first): each limit keeps its newest reading WITH its own time, the plan is
 * the newest one reported, the credits are the newest default-limit reading's
 * (a null clears an older figure; a reading that makes no statement about
 * them leaves it; the merged reading never carries null), and the reading as
 * a whole is as old as its oldest limit (so a default figure left behind by a
 * switch to another model's limit never looks fresh). Null when there is
 * nothing.
 */
export function mergeAllowanceReadings(readings: readonly (AllowanceReading | null)[]): AllowanceReading | null {
  const present = readings.filter((r): r is AllowanceReading => r !== null)
  if (present.length === 0) return null
  const limits: AllowanceLimit[] = []
  let planType: string | null = null
  let credits: AllowanceCredits | null = null
  let readingAt: number | null = null
  for (const r of present) {
    limits.push(...r.limits)
    if (r.planType !== null) planType = r.planType
    if (r.credits !== undefined) credits = r.credits
    if (r.readingAt !== null) readingAt = readingAt === null ? r.readingAt : Math.max(readingAt, r.readingAt)
  }
  // orderLimits keeps the LAST entry per id: the newest reading of each limit.
  const merged = orderLimits(limits)
  const out: AllowanceReading = { limits: merged, planType, readingAt: merged.length > 0 ? oldestOf(merged) : readingAt }
  if (credits) out.credits = credits
  return out
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
        resetsAt: isoFromEpochMs(w.resetsAt),
        severity: 'normal',
      })
    }
  }
  return out
}
