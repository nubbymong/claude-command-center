// Pure parser for Anthropic's OAuth usage payload (api.anthropic.com/api/oauth/usage).
//
// Anthropic keeps ADDING tracked usage categories (a per-model weekly "Fable"
// bucket appeared mid-2026, Opus/others may follow). Rather than hardcode a
// field per bucket and ship a release each time, we discover buckets from the
// self-describing `limits[]` array: each entry carries its own percent,
// resets_at, severity, group, and (for per-model weeklies) a model label.
//
// User scope (2026-07-03): surface only the meaningful buckets — the 5h session
// window and the weekly limits (all-models + per-model like Fable) — NOT the
// ~dozen null codenamed placeholder keys. Credits are shown only when the
// account actually has paid credit enabled.

import type { UsageBucket, CreditsInfo, ParsedUsage } from '../../shared/usage-types'
export type { UsageBucket, CreditsInfo, ParsedUsage } from '../../shared/usage-types'

const GROUP_ORDER: Record<string, number> = { session: 0, weekly: 1 }

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Label a `limits[]` entry: session windows read "5h"; weekly-all reads
 *  "Weekly"; a per-model weekly reads the model's display name ("Fable"). */
function labelForLimit(entry: Record<string, unknown>): string {
  const group = str(entry.group)
  if (group === 'session') return '5h'
  const scope = entry.scope as { model?: { display_name?: unknown } } | null | undefined
  const model = scope?.model?.display_name
  if (typeof model === 'string' && model.trim()) return model
  return 'Weekly'
}

/** Discover buckets from the self-describing `limits[]` array. Returns null when
 *  the array is absent (older CLI) so the caller can fall back to legacy keys. */
function bucketsFromLimits(raw: Record<string, unknown>): UsageBucket[] | null {
  const limits = raw.limits
  if (!Array.isArray(limits)) return null
  const out: UsageBucket[] = []
  for (const item of limits) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const group = str(entry.group)
    // User scope: only the session (5h) + weekly buckets.
    if (group !== 'session' && group !== 'weekly') continue
    const percent = num(entry.percent)
    if (percent === null) continue
    const label = labelForLimit(entry)
    const scope = entry.scope as { model?: { display_name?: unknown } } | null | undefined
    const modelKey = typeof scope?.model?.display_name === 'string' ? scope.model.display_name : ''
    out.push({
      key: `${str(entry.kind) || group}:${modelKey}`,
      label,
      group,
      percent: Math.round(percent),
      resetsAt: str(entry.resets_at),
      severity: str(entry.severity) || 'normal',
    })
  }
  // session first, then weekly-all, then per-model weeklies (stable input order
  // within a group). No sort key beyond group keeps the API's own ordering.
  out.sort((a, b) => (GROUP_ORDER[a.group] ?? 9) - (GROUP_ORDER[b.group] ?? 9))
  return out
}

/** Legacy fallback: build 5h + weekly buckets from the flat five_hour/seven_day
 *  keys that predate `limits[]`. No per-model buckets exist in this shape. */
function bucketsFromLegacy(raw: Record<string, unknown>): UsageBucket[] {
  const out: UsageBucket[] = []
  const fh = raw.five_hour as Record<string, unknown> | undefined
  if (fh) {
    const p = num(fh.utilization)
    if (p !== null) out.push({ key: 'session:', label: '5h', group: 'session', percent: Math.round(p), resetsAt: str(fh.resets_at), severity: 'normal' })
  }
  const sd = raw.seven_day as Record<string, unknown> | undefined
  if (sd) {
    const p = num(sd.utilization)
    if (p !== null) out.push({ key: 'weekly_all:', label: 'Weekly', group: 'weekly', percent: Math.round(p), resetsAt: str(sd.resets_at), severity: 'normal' })
  }
  return out
}

/** Credits are shown ONLY when the account has paid credit enabled. Prefer the
 *  newer `spend` object; fall back to `extra_usage`. Returns undefined when
 *  disabled/out-of-credits so the UI hides the row entirely. */
function parseCredits(raw: Record<string, unknown>): CreditsInfo | undefined {
  // Surface credits whenever the account has ANY monetary activity (paid credit
  // enabled, or a used/limit/balance figure), not only when currently enabled —
  // so a user who has added cash still sees their balance / "out of credits".
  const spend = raw.spend as Record<string, unknown> | undefined
  if (spend && typeof spend === 'object') {
    const used = spend.used as { amount_minor?: unknown; currency?: unknown; exponent?: unknown } | undefined
    const usedMinor = num(used?.amount_minor)
    const limitMinor = num(spend.limit)
    const balanceMinor = num(spend.balance)
    const hasData = spend.enabled === true || usedMinor !== null || limitMinor !== null || balanceMinor !== null
    if (hasData) {
      const exp = num(used?.exponent) ?? 2
      const div = Math.pow(10, exp)
      const usedMajor = (usedMinor ?? 0) / div
      return {
        currency: str(used?.currency) || 'USD',
        used: usedMajor,
        limit: limitMinor !== null ? limitMinor / div : null,
        remaining: balanceMinor !== null ? balanceMinor / div : (limitMinor !== null ? limitMinor / div - usedMajor : null),
        enabled: spend.enabled === true,
        disabledReason: str(spend.disabled_reason) || undefined,
      }
    }
  }
  const extra = raw.extra_usage as Record<string, unknown> | undefined
  if (extra && typeof extra === 'object') {
    const usedCredits = num(extra.used_credits)
    const limitMajorRaw = num(extra.monthly_limit)
    const hasData = extra.is_enabled === true || usedCredits !== null || limitMajorRaw !== null
    if (hasData) {
      const exp = num(extra.decimal_places) ?? 2
      const div = Math.pow(10, exp)
      const usedMajor = (usedCredits ?? 0) / div
      const limitMajor = limitMajorRaw !== null ? limitMajorRaw / div : null
      return {
        currency: str(extra.currency) || 'USD',
        used: usedMajor,
        limit: limitMajor,
        remaining: limitMajor !== null ? limitMajor - usedMajor : null,
        enabled: extra.is_enabled === true,
        disabledReason: str(extra.disabled_reason) || undefined,
      }
    }
  }
  return undefined
}

/** Parse a raw usage payload into display buckets + optional credits. Defensive:
 *  a malformed or empty payload yields `{ buckets: [] }`, never throws. */
export function parseUsage(raw: unknown): ParsedUsage {
  if (!raw || typeof raw !== 'object') return { buckets: [] }
  const obj = raw as Record<string, unknown>
  const buckets = bucketsFromLimits(obj) ?? bucketsFromLegacy(obj)
  const credits = parseCredits(obj)
  return credits ? { buckets, credits } : { buckets }
}
