// insights-cross-account.ts — the PURE half of a cross-account insights roll-up.
//
// Everything here is side-effect free and unit-tested without mocks: prompt
// construction, the headless argv, narrative parsing, and the deterministic
// assembly of the roll-up itself. The impure half (fanning out per-account runs,
// the catalogue entry, spawning claude) lives in insights-runner.ts.
//
// Design rule, deliberately load-bearing: NUMBERS ARE COMPUTED, PROSE IS MODEL-
// WRITTEN. The synthesis pass is asked only for narrative and is never asked to
// restate a metric, so a roll-up cannot report a value the member accounts did
// not produce. `assembleCrossAccount` builds the comparison table from the
// members' own kpis.json either way, which is also why a failed synthesis
// degrades to a numbers-only roll-up instead of no roll-up at all.

import type {
  CrossAccountAccountSummary,
  CrossAccountComparisonRow,
  CrossAccountInsights,
  InsightsData,
  KpiMetric
} from '../shared/types'

/** A member account that produced KPIs and so takes part in the roll-up. */
export interface CrossAccountMember {
  /** Stable per-roll-up key (A1, A2, …) — the only identifier sent to the model. */
  key: string
  runId: string
  profileId?: string
  accountEmail?: string
  label: string
  kpis: InsightsData
}

/** Concurrent member runs. Each one is a full interactive `claude` PTY plus a
 *  headless KPI extraction, so this stays low on purpose — a "run all" across
 *  five accounts must not put five Claude TUIs on the machine at once. */
export const CROSS_ACCOUNT_MAX_PARALLEL = 2

/** Below this there is nothing to compare, so the roll-up is refused. */
export const CROSS_ACCOUNT_MIN_ACCOUNTS = 2

/** Caps on anything the model hands back, so a runaway reply can't bloat the
 *  catalogue artifact or the UI. Applied at parse time, not render time. */
const MAX_BULLETS = 6
const MAX_BULLET_CHARS = 400

/** Display label for an account in the prompt and the roll-up. Profile name
 *  first (the user renamed it for a reason), then email, then the opaque id. */
export function crossAccountLabel(p: { name?: string; accountEmail?: string; id?: string }): string {
  return p.name?.trim() || p.accountEmail?.trim() || p.id || 'Account'
}

/** Progress line for the fan-out phase. Pure so the wording is testable. */
export function describeCrossAccountFanout(done: number, total: number): string {
  return done >= total
    ? `Step 2/2: Synthesizing the cross-account report (${total} accounts)...`
    : `Step 1/2: Generating account reports (${done}/${total} done)...`
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Resolves in input order
 * and never rejects — `fn` is expected to capture its own failures, matching the
 * runInsights contract (a failed run still resolves with its id).
 */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

// ── The synthesis pass ────────────────────────────────────────────────────────

const CROSS_ACCOUNT_PROMPT_HEAD = `You are comparing Claude Code usage across several accounts belonging to ONE person.
Below is each account's already-extracted KPI JSON. Write the narrative that a
side-by-side comparison table cannot: where the work actually lives, which account
carries the friction, and what one account should copy from another.

Output a JSON object with EXACTLY this structure (no markdown fences, ONLY raw JSON):

{
  "summary": {
    "improvements": ["What is going well across the accounts, with numbers"],
    "regressions": ["What is going badly, naming the account it belongs to"],
    "suggestions": ["Concrete change to make, naming the account it applies to"]
  },
  "accounts": [
    { "key": "A1", "highlights": ["Short bullet about THIS account specifically"] }
  ],
  "crossAccount": {
    "observations": ["A comparison that only makes sense across accounts"],
    "recommendations": ["Something to move, split, or consolidate between accounts"]
  }
}

Rules:
- Use the "key" values exactly as given below. Do not invent keys, do not omit an account.
- 2-4 items per array. Cite real numbers from the data. Refer to accounts by their label.
- Do NOT restate the full metric tables — the UI already shows every metric side by side.
  Your job is the interpretation: ratios, outliers, and what to do about them.
- "observations" must compare accounts to each other, not describe one in isolation.
- Output ONLY valid JSON. No explanation, no markdown.

ACCOUNTS:
`

/**
 * The synthesis prompt. Sends each member's KPI JSON verbatim under its opaque
 * key so the reply can be matched back without relying on the model echoing an
 * email address.
 */
export function buildCrossAccountPrompt(members: CrossAccountMember[]): string {
  const blocks = members.map(
    (m) => `--- key: ${m.key} | label: ${m.label} ---\n${JSON.stringify(m.kpis, null, 2)}`
  )
  return CROSS_ACCOUNT_PROMPT_HEAD + blocks.join('\n\n') + '\n'
}

/**
 * Headless argv for the synthesis pass. Note the absence of `--allowedTools`:
 * the KPI JSON travels in the prompt (stdin), so this step reads no files and
 * needs no tools at all — strictly less privilege than the per-run KPI
 * extraction, which does need `Read`. No `--dangerously-skip-permissions`.
 */
export function buildCrossAccountSpawnArgs(): string[] {
  return ['-p', '--output-format', 'json']
}

/** The narrative half of a roll-up, as returned by the synthesis pass. */
export interface CrossAccountNarrative {
  summary?: { improvements?: string[]; regressions?: string[]; suggestions?: string[] }
  accounts: Array<{ key: string; highlights?: string[] }>
  crossAccount?: { observations?: string[]; recommendations?: string[] }
}

function bullets(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .slice(0, MAX_BULLETS)
    .map((v) => v.trim().slice(0, MAX_BULLET_CHARS))
  return out.length > 0 ? out : undefined
}

/** Greedy outermost-braces extraction — same shape of tolerance as parseKpiOutput. */
function objectFromText(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const parsed = JSON.parse(m[0])
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Pull the narrative out of a `claude -p --output-format json` reply. Handles a
 * direct object, the `{result:"<json>"}` envelope, and prose wrapped around the
 * JSON. Returns null when nothing usable comes back — the caller then falls back
 * to a deterministic roll-up rather than surfacing a half-parsed narrative.
 */
export function parseCrossAccountNarrative(stdout: string): CrossAccountNarrative | null {
  const trimmed = stdout.trim()
  let raw: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed.result === 'string') {
      raw = objectFromText(parsed.result)
    } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>
    }
  } catch {
    raw = objectFromText(trimmed)
  }
  if (!raw) return null

  const accountsRaw = Array.isArray(raw.accounts) ? raw.accounts : null
  const accounts = (accountsRaw ?? [])
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .filter((a) => typeof a.key === 'string' && (a.key as string).trim().length > 0)
    .map((a) => ({ key: (a.key as string).trim(), highlights: bullets(a.highlights) }))

  const summaryRaw = (raw.summary ?? {}) as Record<string, unknown>
  const summary = {
    improvements: bullets(summaryRaw.improvements),
    regressions: bullets(summaryRaw.regressions),
    suggestions: bullets(summaryRaw.suggestions)
  }
  const crossRaw = (raw.crossAccount ?? {}) as Record<string, unknown>
  const crossAccount = {
    observations: bullets(crossRaw.observations),
    recommendations: bullets(crossRaw.recommendations)
  }

  const hasSummary = !!(summary.improvements || summary.regressions || summary.suggestions)
  const hasCross = !!(crossAccount.observations || crossAccount.recommendations)
  const hasHighlights = accounts.some((a) => a.highlights)
  // A reply with keys but no prose anywhere is not a narrative — treat it as a
  // failed pass so the caller degrades honestly instead of rendering blank cards.
  if (!hasSummary && !hasCross && !hasHighlights) return null

  return {
    accounts,
    ...(hasSummary ? { summary } : {}),
    ...(hasCross ? { crossAccount } : {})
  }
}

// ── Deterministic assembly ───────────────────────────────────────────────────

function isMetric(v: unknown): v is KpiMetric {
  return !!v && typeof v === 'object' && typeof (v as KpiMetric).value === 'number' && Number.isFinite((v as KpiMetric).value)
}

/**
 * Line every metric up across accounts, keeping only metrics at least two
 * accounts reported — a single-account metric has nothing to compare against and
 * is already visible in that account's own report. Row metadata (label, format,
 * goodDirection) comes from the first account that carried the metric; values are
 * copied verbatim. Rows are ordered by category, then by how many accounts have
 * the metric (widest coverage first), then by label.
 */
export function buildComparisonRows(members: CrossAccountMember[]): CrossAccountComparisonRow[] {
  const rows = new Map<string, CrossAccountComparisonRow>()

  for (const m of members) {
    const categories = m.kpis?.kpis
    if (!categories || typeof categories !== 'object') continue
    for (const [category, metrics] of Object.entries(categories)) {
      if (!metrics || typeof metrics !== 'object') continue
      for (const [metricKey, metric] of Object.entries(metrics)) {
        if (!isMetric(metric)) continue
        const id = `${category} ${metricKey}`
        let row = rows.get(id)
        if (!row) {
          row = {
            metricKey,
            category,
            label: typeof metric.label === 'string' && metric.label.trim() ? metric.label.trim() : metricKey,
            format: metric.format,
            goodDirection: metric.goodDirection,
            values: []
          }
          rows.set(id, row)
        }
        row.values.push({
          key: m.key,
          profileId: m.profileId,
          accountEmail: m.accountEmail,
          value: metric.value
        })
      }
    }
  }

  const shared = [...rows.values()].filter((r) => r.values.length >= 2)
  for (const row of shared) {
    // Counts add up; percentages and durations do not without weights we don't
    // have, so they get no total rather than a misleading average. An untagged
    // metric gets none either — an untagged rate summed as a count is exactly
    // the kind of invented number this module exists to avoid.
    if (row.format === 'number') {
      row.total = row.values.reduce((sum, v) => sum + v.value, 0)
    }
  }
  return shared.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      b.values.length - a.values.length ||
      a.label.localeCompare(b.label)
  )
}

/**
 * Build the final roll-up. `narrative` null (synthesis failed or unusable) still
 * yields a complete, renderable result — just numbers, flagged
 * `synthesis: 'deterministic'` so the UI can say so rather than implying the
 * model wrote nothing worth showing.
 *
 * No top-level `period` is emitted: the member periods are model-extracted
 * strings that cannot be safely min/max'd, so each account carries its own.
 */
export function assembleCrossAccount(
  members: CrossAccountMember[],
  narrative: CrossAccountNarrative | null
): CrossAccountInsights {
  const byKey = new Map((narrative?.accounts ?? []).map((a) => [a.key, a]))
  const accounts: CrossAccountAccountSummary[] = members.map((m) => ({
    key: m.key,
    runId: m.runId,
    profileId: m.profileId,
    accountEmail: m.accountEmail,
    label: m.label,
    period: m.kpis?.period,
    highlights: byKey.get(m.key)?.highlights
  }))

  return {
    synthesis: narrative ? 'ai' : 'deterministic',
    accounts,
    comparison: buildComparisonRows(members),
    ...(narrative?.summary ? { summary: narrative.summary } : {}),
    ...(narrative?.crossAccount ? { crossAccount: narrative.crossAccount } : {})
  }
}
