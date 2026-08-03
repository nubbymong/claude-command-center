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
//
// Corollary the first cut got wrong: computing the numbers is not enough if the
// ALIGNMENT is asserted without evidence. Two accounts sharing a metricKey are
// not necessarily measuring the same thing, and claiming they are produces a
// false comparison dressed as a measurement. See buildComparisonRows.
//
// The synthesis prompt therefore sends the COMPUTED, ALIGNED table rather than
// each account's raw kpis.json. Measured on real archives that is an ~88%
// smaller payload (30,477 -> 3,619 bytes for two accounts) and a better one: the
// alignment work is already done, and conflicts are flagged instead of hidden.

import type {
  CrossAccountAccountSummary,
  CrossAccountComparisonRow,
  CrossAccountInsights,
  CrossAccountUniqueMetric,
  InsightsData,
  KpiMetric
} from '../shared/types'
import { formatMetricValue, spanDaysFromPeriod, windowsAreComparable } from '../shared/kpi-format'

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

/** Ranked-list entries carried per account (tools, languages, goals). */
const TOP_LIST_LIMIT = 3

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

// ── Deterministic assembly ───────────────────────────────────────────────────

function isMetric(v: unknown): v is KpiMetric {
  return !!v && typeof v === 'object' && typeof (v as KpiMetric).value === 'number' && Number.isFinite((v as KpiMetric).value)
}

/** Label comparison for "are these the same measure?" — case, punctuation and
 *  spacing differences are wording noise; anything else is a real disagreement. */
function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function metricLabel(metric: KpiMetric, metricKey: string): string {
  return typeof metric.label === 'string' && metric.label.trim() ? metric.label.trim() : metricKey
}

/** Walk every (category, metricKey, metric) triple a member reported. */
function forEachMetric(
  member: CrossAccountMember,
  fn: (category: string, metricKey: string, metric: KpiMetric) => void
): void {
  const categories = member.kpis?.kpis
  if (!categories || typeof categories !== 'object') return
  for (const [category, metrics] of Object.entries(categories)) {
    if (!metrics || typeof metrics !== 'object') continue
    for (const [metricKey, metric] of Object.entries(metrics)) {
      if (!isMetric(metric)) continue
      fn(category, metricKey, metric)
    }
  }
}

interface RowDraft {
  row: CrossAccountComparisonRow
  labels: Map<string, string> // normalized -> first raw spelling seen
  formats: Set<string>
  directions: Set<string>
}

/**
 * Line every metric up across accounts.
 *
 * Merging is by `category + metricKey` AND AGREEMENT. Two accounts sharing a key
 * are only asserted to be measuring the same thing when their labels agree
 * (ignoring wording noise) and their formats agree. When they do not, the row is
 * still emitted — the values are real — but it is marked (`labelVariants` /
 * `formatVariants`), displayed by its raw key, and carries no total, so the
 * renderer can show the numbers without claiming they are comparable.
 *
 * This is the fix for a live defect. Real archives have both accounts reporting
 * `Outcomes.successRate`: one means "Fully Achieved Rate" (0.4231), the other
 * "Mostly or Fully Achieved Rate" (0.787). First-member-wins labelling rendered
 * the second account as the better performer at 78.7% "fully achieved" when its
 * actual fully-achieved rate was 0.128 — the worse of the two — because that
 * account's own `fullyAchievedRate` key had no counterpart and was dropped.
 *
 * `goodDirection` disagreement clears the direction entirely: otherwise which
 * account gets painted green depends on member ORDER, which is non-determinism
 * in rendered output.
 *
 * @param allowTotals pass false when the accounts cover materially different
 *        windows; no row then carries a total, because summing a 23-day count
 *        with a 35-day count produces a number that means nothing.
 */
export function buildComparisonRows(
  members: CrossAccountMember[],
  allowTotals = true
): CrossAccountComparisonRow[] {
  const drafts = new Map<string, RowDraft>()

  for (const m of members) {
    forEachMetric(m, (category, metricKey, metric) => {
      const id = `${category} ${metricKey}`
      const label = metricLabel(metric, metricKey)
      let draft = drafts.get(id)
      if (!draft) {
        draft = {
          row: {
            metricKey,
            category,
            label,
            format: metric.format,
            goodDirection: metric.goodDirection,
            values: []
          },
          labels: new Map(),
          formats: new Set(),
          directions: new Set()
        }
        drafts.set(id, draft)
      }
      const norm = normalizeLabel(label)
      if (!draft.labels.has(norm)) draft.labels.set(norm, label)
      draft.formats.add(metric.format ?? 'none')
      draft.directions.add(metric.goodDirection ?? 'none')
      draft.row.values.push({
        key: m.key,
        profileId: m.profileId,
        accountEmail: m.accountEmail,
        value: metric.value
      })
    })
  }

  const shared: CrossAccountComparisonRow[] = []
  for (const draft of drafts.values()) {
    if (draft.row.values.length < 2) continue
    const row = draft.row

    if (draft.labels.size > 1) {
      // Same key, different claim about what it measures. Show the raw key so
      // neither account's wording is presented as the shared truth.
      row.labelVariants = [...draft.labels.values()].sort((a, b) => a.localeCompare(b))
      row.label = row.metricKey
    }
    if (draft.formats.size > 1) {
      row.formatVariants = [...draft.formats].filter(
        (f): f is 'number' | 'percent' | 'duration' => f === 'number' || f === 'percent' || f === 'duration'
      )
      row.format = undefined
    }
    if (draft.directions.size > 1) {
      row.directionConflict = true
      row.goodDirection = undefined
    }

    // Counts add up; percentages and durations do not without weights we do not
    // have, so they get no total rather than a misleading average. An untagged
    // metric gets none either — an untagged rate summed as a count is exactly
    // the kind of invented number this module exists to avoid. Neither does a
    // row whose accounts disagree on what it measures, nor any row at all when
    // the reporting windows are of different lengths.
    if (allowTotals && row.format === 'number' && !row.labelVariants && !row.formatVariants) {
      row.total = row.values.reduce((sum, v) => sum + v.value, 0)
    }
    shared.push(row)
  }

  return shared.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      b.values.length - a.values.length ||
      a.label.localeCompare(b.label)
  )
}

/**
 * Metrics exactly one account reported. Measured on real archives these are the
 * MAJORITY of the union (59 of 88 across two accounts), because the extraction
 * step names keys freely: `commandFailed` vs `errorCommandFailed`,
 * `environmentIssue` vs `environmentIssues`. Some of that gap is genuine
 * account difference and some is extraction drift, but either way dropping it
 * silently discards most of the data, so it is kept, shown, and sent to the
 * synthesis pass. "Only A2 has any subagent calls" can be the single most
 * useful sentence in the report, and it lives here.
 */
export function collectUniqueMetrics(members: CrossAccountMember[]): CrossAccountUniqueMetric[] {
  const seen = new Map<
    string,
    Array<{ key: string; category: string; metricKey: string; metric: KpiMetric }>
  >()

  for (const m of members) {
    forEachMetric(m, (category, metricKey, metric) => {
      const id = `${category} ${metricKey}`
      const entry = { key: m.key, category, metricKey, metric }
      const list = seen.get(id)
      if (list) list.push(entry)
      else seen.set(id, [entry])
    })
  }

  const unique: CrossAccountUniqueMetric[] = []
  for (const list of seen.values()) {
    if (list.length !== 1) continue
    const [only] = list
    unique.push({
      key: only.key,
      category: only.category,
      metricKey: only.metricKey,
      label: metricLabel(only.metric, only.metricKey),
      value: only.metric.value,
      format: only.metric.format
    })
  }
  return unique.sort(
    (a, b) =>
      a.key.localeCompare(b.key) ||
      a.category.localeCompare(b.category) ||
      a.label.localeCompare(b.label)
  )
}

/**
 * Top N entries of each ranked list an account reported. The previous cut dropped
 * `lists` entirely — not just from the prompt but from the persisted artifact — so
 * a fact like "only one account works in Rust" was unrecoverable from a roll-up.
 */
export function topLists(
  kpis: InsightsData,
  limit = TOP_LIST_LIMIT
): Record<string, Array<{ name: string; count: number }>> | undefined {
  const lists = kpis?.lists
  if (!lists || typeof lists !== 'object') return undefined
  const out: Record<string, Array<{ name: string; count: number }>> = {}
  for (const [name, items] of Object.entries(lists)) {
    if (!Array.isArray(items)) continue
    const trimmed = items
      .filter(
        (i) => i && typeof i.name === 'string' && typeof i.count === 'number' && Number.isFinite(i.count)
      )
      .slice(0, limit)
      .map((i) => ({ name: i.name, count: i.count }))
    if (trimmed.length > 0) out[name] = trimmed
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Build the final roll-up. `narrative` null (synthesis failed or unusable) still
 * yields a complete, renderable result — just numbers, flagged
 * `synthesis: 'deterministic'` so the UI can say so rather than implying the
 * model wrote nothing worth showing.
 *
 * No top-level `period` is emitted: the member periods are model-extracted
 * strings that cannot be safely min/max'd, so each account carries its own, plus
 * a `spanDays` computed from the dates (period.days is ACTIVE days, not the
 * window — measured: a 23-day span reported as `days: 10`).
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
    spanDays: spanDaysFromPeriod(m.kpis?.period),
    topLists: topLists(m.kpis),
    highlights: byKey.get(m.key)?.highlights
  }))

  const windowsComparable = windowsAreComparable(accounts.map((a) => a.spanDays))

  return {
    synthesis: narrative ? 'ai' : 'deterministic',
    accounts,
    comparison: buildComparisonRows(members, windowsComparable),
    uniqueMetrics: collectUniqueMetrics(members),
    windowsComparable,
    ...(narrative?.summary ? { summary: narrative.summary } : {}),
    ...(narrative?.crossAccount ? { crossAccount: narrative.crossAccount } : {})
  }
}

// ── The synthesis pass ────────────────────────────────────────────────────────

const CROSS_ACCOUNT_PROMPT_HEAD = `You are comparing Claude Code usage across several accounts belonging to ONE person.
Below is a PRE-COMPUTED, PRE-ALIGNED comparison: every metric two or more accounts
reported, side by side; the metrics only ONE account reported; and each account's
top tools, languages and goals. Every number below is already correct and final.

Your job is the interpretation the table cannot do for itself: where the work
actually lives, which account carries the friction, and what one account should
copy from another.

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
- Use the "key" values exactly as listed under ACCOUNTS. Do not invent keys, do not
  omit an account. Refer to accounts by their label in the prose.
- 2-4 items per array. Every bullet names at least one account and cites at least
  one number that appears below.
- Never introduce a number that is not below, and never recompute or re-round one.
  When you state a ratio or delta ("3x more", "half as many"), give the two raw
  numbers behind it so it can be checked: "3.2x more Bash calls (1255 vs 392)".
- Do NOT walk the table restating rows. The UI already shows every row. Cite a
  number only in service of an interpretation.
- A row marked "~" means the accounts used DIFFERENT WORDING for that metric key,
  so it may not be the same measure; both wordings are listed under LABEL
  CONFLICTS. Read both before comparing, and if they are not the same measure,
  say so instead of drawing a false comparison.
- An account-unique metric is not noise. It appears in no comparison row and
  nowhere else in the UI, so it often outranks a shared metric: "only A2 has any
  subagent calls" can be the most useful sentence in the report.
- The accounts' reporting windows differ in length (see ACCOUNTS). Normalise
  before comparing raw counts, and say when you have.
- "observations" must compare two or more accounts. A fact about one account alone
  belongs in that account's "highlights".
- Output ONLY valid JSON. No explanation, no markdown.

`

function metricCell(value: number, format?: string): string {
  return formatMetricValue(value, format)
}

function renderAccountsBlock(data: CrossAccountInsights): string {
  const lines = data.accounts.map((a) => {
    const period = a.period?.start && a.period?.end ? ` ${a.period.start}..${a.period.end}` : ''
    const span = a.spanDays != null ? ` (${a.spanDays}d window)` : ' (window length unknown)'
    return `${a.key} = ${a.label}${period}${span}`
  })
  if (!data.windowsComparable) {
    // Say WHICH problem it is. "Windows differ in length" and "a window could not
    // be determined" call for different caution from the model, and telling it the
    // wrong one is itself a fidelity loss.
    const unknown = data.accounts.some((a) => a.spanDays == null)
    lines.push(
      unknown
        ? 'NOTE: at least one reporting window could not be determined, so no row carries a total and raw counts may not be comparable.'
        : 'NOTE: these windows differ materially in length, so no row carries a total and raw counts are not directly comparable.'
    )
  }
  return 'ACCOUNTS:\n' + lines.join('\n')
}

function renderSharedBlock(data: CrossAccountInsights): string {
  if (data.comparison.length === 0) {
    return 'SHARED METRICS: none — no metric was reported by two or more accounts.'
  }
  const keys = data.accounts.map((a) => a.key)
  const header = `category | metric (better) | ${keys.join(' | ')} | total`
  const rows = data.comparison.map((r) => {
    const byKey = new Map(r.values.map((v) => [v.key, v.value]))
    const cells = keys.map((k) => {
      const v = byKey.get(k)
      return v == null ? '-' : metricCell(v, r.format)
    })
    const better = r.goodDirection && r.goodDirection !== 'neutral' ? r.goodDirection : '-'
    const flag = r.labelVariants || r.formatVariants ? '~ ' : ''
    const total = r.total != null ? metricCell(r.total, r.format) : '-'
    return `${r.category} | ${flag}${r.label} (${better}) | ${cells.join(' | ')} | ${total}`
  })
  return 'SHARED METRICS (reported by 2+ accounts):\n' + header + '\n' + rows.join('\n')
}

function renderConflictsBlock(data: CrossAccountInsights): string {
  const conflicted = data.comparison.filter((r) => r.labelVariants || r.formatVariants)
  if (conflicted.length === 0) return ''
  const lines = conflicted.map((r) => {
    const parts: string[] = []
    if (r.labelVariants) parts.push(`wording: ${r.labelVariants.map((l) => `"${l}"`).join(' vs ')}`)
    if (r.formatVariants) parts.push(`unit: ${r.formatVariants.join(' vs ')}`)
    return `~ ${r.category}.${r.metricKey} -> ${parts.join('; ')}`
  })
  return 'LABEL CONFLICTS (may not be the same measure):\n' + lines.join('\n')
}

function renderUniqueBlock(data: CrossAccountInsights): string {
  if (data.uniqueMetrics.length === 0) return ''
  const byAccount = new Map<string, string[]>()
  for (const u of data.uniqueMetrics) {
    const entry = `${u.label}=${metricCell(u.value, u.format)}`
    const list = byAccount.get(u.key)
    if (list) list.push(entry)
    else byAccount.set(u.key, [entry])
  }
  const lines = [...byAccount.entries()].map(([key, entries]) => `${key} only: ${entries.join(', ')}`)
  return 'ACCOUNT-UNIQUE METRICS (reported by exactly one account):\n' + lines.join('\n')
}

function renderTopListsBlock(data: CrossAccountInsights): string {
  const lines: string[] = []
  for (const a of data.accounts) {
    if (!a.topLists) continue
    const parts = Object.entries(a.topLists).map(
      ([name, items]) => `${name}=[${items.map((i) => `${i.name} ${i.count}`).join(', ')}]`
    )
    if (parts.length > 0) lines.push(`${a.key}: ${parts.join(' ')}`)
  }
  if (lines.length === 0) return ''
  return `TOP LISTS (top ${TOP_LIST_LIMIT} each):\n` + lines.join('\n')
}

/**
 * The synthesis prompt. Sends the COMPUTED comparison — not each member's raw
 * kpis.json — under opaque per-roll-up keys, so the reply can be matched back
 * without the model echoing an email address.
 *
 * Sending the aligned table instead of N raw blobs is both smaller (measured
 * ~88% fewer bytes for two real accounts) and better: the model no longer has to
 * align metrics itself across blobs tens of thousands of tokens apart, the
 * key->label->window mapping sits at the top instead of scattered through the
 * payload, and label conflicts are declared rather than left to be guessed at.
 */
export function buildCrossAccountPrompt(members: CrossAccountMember[]): string {
  return buildCrossAccountPromptFrom(assembleCrossAccount(members, null))
}

/** Prompt body for an already-assembled roll-up. Split out so the prompt is
 *  testable against a fixed CrossAccountInsights without re-deriving it. */
export function buildCrossAccountPromptFrom(data: CrossAccountInsights): string {
  const blocks = [
    renderAccountsBlock(data),
    renderSharedBlock(data),
    renderConflictsBlock(data),
    renderUniqueBlock(data),
    renderTopListsBlock(data)
  ].filter((b) => b.length > 0)
  return CROSS_ACCOUNT_PROMPT_HEAD + blocks.join('\n\n') + '\n'
}

/**
 * Headless argv for the synthesis pass. Note the absence of `--allowedTools`:
 * the comparison travels in the prompt (stdin), so this step reads no files and
 * needs no tools at all — strictly less privilege than the per-run KPI
 * extraction, which does need `Read`. No `--dangerously-skip-permissions`.
 *
 * `--strict-mcp-config` with no `--mcp-config` beside it loads NO MCP servers.
 * That is the cost fix: a headless `claude -p` otherwise pulls in the account's
 * whole mirrored global config, measured at 10 MCP servers plus 41 skills on a
 * real profile — 41,714 tokens of overhead become 14,395 once the built-in tool
 * schemas go too. Verified empirically, not inferred.
 *
 * `--tools ""` is what would drop those remaining schemas here, since this pass
 * needs no tools at all (`--allowedTools` only gates the permission prompt; it
 * does not unload definitions). It cannot be passed yet: spawnClaudeHeadless runs
 * with `shell: true`, which concatenates argv without quoting, so an empty
 * argument vanishes and `--tools` swallows the next flag. Tracked separately —
 * do not add it here until the spawner quotes its arguments.
 */
export function buildCrossAccountSpawnArgs(): string[] {
  return ['-p', '--strict-mcp-config', '--output-format', 'json']
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
    // Truncation gets an ellipsis: without one, a cut bullet renders as a
    // sentence fragment presented to the user as a finding.
    .map((v) => {
      const t = v.trim()
      return t.length > MAX_BULLET_CHARS ? t.slice(0, MAX_BULLET_CHARS - 1) + '…' : t
    })
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

/**
 * Attach a model-written narrative to an already-assembled roll-up. Used by the
 * runner so the comparison is computed ONCE and fed to both the prompt and the
 * final artifact — the model sees exactly the table the user will see.
 */
export function withNarrative(
  data: CrossAccountInsights,
  narrative: CrossAccountNarrative | null
): CrossAccountInsights {
  if (!narrative) return data
  const byKey = new Map(narrative.accounts.map((a) => [a.key, a]))
  return {
    ...data,
    synthesis: 'ai',
    accounts: data.accounts.map((a) => ({ ...a, highlights: byKey.get(a.key)?.highlights })),
    ...(narrative.summary ? { summary: narrative.summary } : {}),
    ...(narrative.crossAccount ? { crossAccount: narrative.crossAccount } : {})
  }
}
