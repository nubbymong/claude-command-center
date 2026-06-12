import { z } from 'zod'
import { GITHUB_API_BASE } from '../../shared/github-constants'
import type { AiUsageReport, AiUsageItem } from '../../shared/github-types'
import { redactTokens } from './security/token-redactor'

/**
 * GitHub AI-credits (Copilot) usage data layer.
 *
 * Pulls a personal account's billed AI-credit usage so the renderer can show
 * a "you are being billed beyond your included credits" meter. The headline
 * signal is `totals.billedAmount > 0` — anything above zero means GitHub is
 * charging the user past their plan's included allowance.
 *
 * Two endpoints, same response schema:
 *   - primary  GET /users/{login}/settings/billing/ai_credit/usage      (new plans)
 *   - fallback GET /users/{login}/settings/billing/premium_request/usage (old plans)
 * New-plan accounts return [] from the fallback; old-plan accounts return []
 * from the primary. We try primary first and fall back ONLY when the primary
 * yields an empty usageItems list (or a clean 404), so a populated primary is
 * always preferred.
 *
 * Auth notes (consumed by the later UI batch, see registerAiUsage below):
 *   - classic tokens need the `user` scope
 *   - fine-grained PATs need Account permissions "Plan: read"
 *   - an unauthorized / unscoped token gets 404 here (NOT 403). We treat 404 as
 *     "scope missing or no access" and fail open (return null) rather than
 *     surfacing it as an error — the meter is best-effort.
 *
 * Plan name / included-credit cap / budgets are NOT exposed for personal
 * accounts (org-only API), so the cap is a user setting (copilotIncludedCredits).
 */

const UA = 'ClaudeCommandCenter'

// --- Raw GitHub response schema (the on-the-wire shape) ---------------------
// Coerce numerics: GitHub returns them as JSON numbers, but coercion guards
// against string-typed quantities sneaking through edge caches. Unknown extra
// fields are allowed (GitHub adds columns over time) — zod strips them.
const rawUsageItemSchema = z.object({
  product: z.string().default(''),
  sku: z.string().default(''),
  model: z.string().default(''),
  unitType: z.string().default(''),
  pricePerUnit: z.coerce.number().optional(),
  grossQuantity: z.coerce.number().default(0),
  grossAmount: z.coerce.number().default(0),
  discountQuantity: z.coerce.number().default(0),
  discountAmount: z.coerce.number().default(0),
  netQuantity: z.coerce.number().default(0),
  netAmount: z.coerce.number().default(0),
})

const rawUsageResponseSchema = z.object({
  timePeriod: z
    .object({
      year: z.coerce.number(),
      month: z.coerce.number(),
    })
    .optional(),
  user: z.string().optional(),
  usageItems: z.array(rawUsageItemSchema).default([]),
})

export type RawAiUsageResponse = z.infer<typeof rawUsageResponseSchema>

// --- Normalized output schema (the shape the renderer/store consume) --------
// Exported so callers (and tests) can validate a report end-to-end.
export const aiUsageItemSchema = z.object({
  product: z.string(),
  sku: z.string(),
  model: z.string(),
  unitType: z.string(),
  grossQuantity: z.number(),
  grossAmount: z.number(),
  coveredQuantity: z.number(),
  coveredAmount: z.number(),
  billedQuantity: z.number(),
  billedAmount: z.number(),
}) satisfies z.ZodType<AiUsageItem>

export const aiUsageReportSchema = z.object({
  fetchedAt: z.number(),
  source: z.enum(['ai_credit', 'premium_request']),
  timePeriod: z.object({ year: z.number(), month: z.number() }),
  items: z.array(aiUsageItemSchema),
  totals: z.object({
    grossAmount: z.number(),
    coveredAmount: z.number(),
    billedAmount: z.number(),
  }),
}) satisfies z.ZodType<AiUsageReport>

/**
 * Maps a raw GitHub usage response into the normalized AiUsageReport.
 * Renames discount->covered and net->billed, computes totals, and stamps
 * fetchedAt. `source` records which endpoint produced the rows. Returns null
 * if the raw body doesn't parse (treated as "no data" by callers).
 */
export function normalizeAiUsage(
  raw: unknown,
  source: AiUsageReport['source'],
  now: number = Date.now(),
): AiUsageReport | null {
  const parsed = rawUsageResponseSchema.safeParse(raw)
  if (!parsed.success) return null
  const data = parsed.data

  const items: AiUsageItem[] = data.usageItems.map((it) => ({
    product: it.product,
    sku: it.sku,
    model: it.model,
    unitType: it.unitType,
    grossQuantity: it.grossQuantity,
    grossAmount: it.grossAmount,
    coveredQuantity: it.discountQuantity,
    coveredAmount: it.discountAmount,
    billedQuantity: it.netQuantity,
    billedAmount: it.netAmount,
  }))

  const totals = items.reduce(
    (acc, it) => {
      acc.grossAmount += it.grossAmount
      acc.coveredAmount += it.coveredAmount
      acc.billedAmount += it.billedAmount
      return acc
    },
    { grossAmount: 0, coveredAmount: 0, billedAmount: 0 },
  )

  // GitHub omits timePeriod on some empty responses — default to the current
  // calendar month so the report is always well-formed for the UI.
  const d = new Date(now)
  const timePeriod = data.timePeriod ?? {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
  }

  return {
    fetchedAt: now,
    source,
    timePeriod,
    items,
    totals,
  }
}

// Per-session "logged once" guard so a 404/network failure logs a single line
// rather than one per 60-minute poll. Reset only on process restart.
let loggedFailureThisSession = false

function logOnce(message: string, logFn: (line: string) => void): void {
  if (loggedFailureThisSession) return
  loggedFailureThisSession = true
  logFn(redactTokens(`[copilot-usage] ${message}`))
}

/** Test-only: reset the once-per-session failure log guard. */
export function __resetUsageLogGuard(): void {
  loggedFailureThisSession = false
}

export interface FetchAiUsageOptions {
  /** Resolves the GitHub token to authorize with. */
  tokenFn: () => Promise<string>
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable clock for deterministic fetchedAt in tests. */
  now?: () => number
  /** Injectable logger; defaults to console.warn (wrapped in redactTokens). */
  logFn?: (line: string) => void
}

type EndpointResult =
  | { kind: 'ok'; body: unknown }
  | { kind: 'empty' } // 200 but no usage rows, OR a 404 (try fallback)
  | { kind: 'fail' } // network / non-404 error (fail open, stop)

async function fetchEndpoint(
  login: string,
  segment: 'ai_credit' | 'premium_request',
  opts: Required<Pick<FetchAiUsageOptions, 'tokenFn' | 'fetchImpl' | 'logFn'>>,
): Promise<EndpointResult> {
  const url = `${GITHUB_API_BASE}/users/${encodeURIComponent(
    login,
  )}/settings/billing/${segment}/usage`
  let resp: Response
  try {
    const token = await opts.tokenFn()
    resp = await opts.fetchImpl(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': UA,
      },
    })
  } catch (err) {
    logOnce(
      `network failure contacting ${segment} usage: ${
        err instanceof Error ? err.message : String(err)
      }`,
      opts.logFn,
    )
    return { kind: 'fail' }
  }

  // 404 = unauthorized/unscoped token, or no access. Non-fatal: treat as
  // "nothing here, try the fallback endpoint".
  if (resp.status === 404) {
    logOnce(
      `${segment} usage returned 404 (token likely missing 'user' scope / 'Plan: read')`,
      opts.logFn,
    )
    return { kind: 'empty' }
  }
  if (!resp.ok) {
    logOnce(`${segment} usage returned HTTP ${resp.status}`, opts.logFn)
    return { kind: 'fail' }
  }

  let body: unknown
  try {
    body = await resp.json()
  } catch (err) {
    logOnce(
      `failed to parse ${segment} usage body: ${
        err instanceof Error ? err.message : String(err)
      }`,
      opts.logFn,
    )
    return { kind: 'fail' }
  }

  const parsed = rawUsageResponseSchema.safeParse(body)
  if (!parsed.success) return { kind: 'fail' }
  // Empty usageItems on the primary = old-plan account; signal the caller to
  // try the fallback. A populated list short-circuits the fallback.
  if (parsed.data.usageItems.length === 0) return { kind: 'empty' }
  return { kind: 'ok', body }
}

/**
 * Fetches the AI-credits usage report for a personal account.
 *
 * Tries the primary `ai_credit` endpoint; if it returns no rows (or a 404),
 * falls back to `premium_request`. Returns null on total failure (network,
 * non-404 HTTP, both endpoints empty) — the meter is best-effort and fails
 * open. Failures log ONCE per process via the redacting logger.
 */
export async function fetchAiUsage(
  login: string,
  options: FetchAiUsageOptions,
): Promise<AiUsageReport | null> {
  if (!login || typeof login !== 'string') return null
  const now = options.now ?? Date.now
  const epOpts = {
    tokenFn: options.tokenFn,
    fetchImpl: options.fetchImpl ?? fetch,
    // eslint-disable-next-line no-console
    logFn: options.logFn ?? ((line: string) => console.warn(line)),
  }

  // Primary endpoint (new plans). A populated list short-circuits the fallback.
  const primary = await fetchEndpoint(login, 'ai_credit', epOpts)
  if (primary.kind === 'ok') {
    return normalizeAiUsage(primary.body, 'ai_credit', now())
  }
  // primary 'empty' (old-plan account or 404) -> try the fallback endpoint.
  // primary 'fail' (network/5xx) usually means connectivity is down, but we
  // still try the fallback once; its own failure collapses to null below.
  const fallback = await fetchEndpoint(login, 'premium_request', epOpts)
  if (fallback.kind === 'ok') {
    return normalizeAiUsage(fallback.body, 'premium_request', now())
  }
  return null
}

// --- Polling scheduler ------------------------------------------------------
//
// Refreshes on explicit request + every refreshIntervalMs (default 60 min)
// while enabled, and pushes each fresh report to the renderer. No poll runs
// while disabled. The scheduler owns no auth/login resolution itself — those
// are injected so the IPC layer can wire in the active profile's token + login.

export const AI_USAGE_REFRESH_MS = 60 * 60 * 1000 // 60 minutes

export interface AiUsageSchedulerDeps {
  /** Resolves the login + token to fetch for, or null if unavailable. */
  resolve: () => Promise<{ login: string; tokenFn: () => Promise<string> } | null>
  /** True while the meter is enabled (githubAiUsageEnabled). Re-read each tick. */
  isEnabled: () => boolean
  /** Push a fresh (or cleared) report to the renderer. */
  emit: (report: AiUsageReport | null) => void
  /** Refresh cadence; defaults to AI_USAGE_REFRESH_MS. */
  refreshIntervalMs?: number
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch
  /** Injectable logger for tests. */
  logFn?: (line: string) => void
}

export class AiUsageScheduler {
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  private latest: AiUsageReport | null = null
  private inFlight: Promise<AiUsageReport | null> | null = null

  constructor(private deps: AiUsageSchedulerDeps) {}

  /** Latest cached report (or null if never fetched / disabled). */
  getLatest(): AiUsageReport | null {
    return this.latest
  }

  /**
   * Starts the periodic refresh loop. No-op (and clears any cached report) when
   * disabled — the loop arms only while isEnabled() is true. Idempotent.
   */
  start(): void {
    if (this.stopped) return
    if (!this.deps.isEnabled()) {
      // Disabled: ensure nothing is armed and the cache is cleared so the UI
      // never shows stale numbers after the user turns the meter off.
      this.clearTimer()
      this.latest = null
      return
    }
    // Immediate first refresh so the panel populates without waiting a full
    // hour, then schedule the recurring tick.
    void this.refresh().finally(() => this.scheduleNext())
  }

  /** Stops the loop and clears the armed timer. */
  stop(): void {
    this.clearTimer()
  }

  /** Permanent teardown — no further refreshes regardless of enable state. */
  dispose(): void {
    this.stopped = true
    this.clearTimer()
  }

  /**
   * Forces an immediate refresh and returns the report. Honors the disabled
   * state (returns null without a network call). Coalesces concurrent callers
   * onto a single in-flight fetch.
   */
  async refresh(): Promise<AiUsageReport | null> {
    if (this.stopped || !this.deps.isEnabled()) {
      this.latest = null
      return null
    }
    if (this.inFlight) return this.inFlight
    this.inFlight = this.doFetch().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async doFetch(): Promise<AiUsageReport | null> {
    const target = await this.deps.resolve().catch(() => null)
    if (!target) {
      // No usable auth profile/login yet. Don't clobber a previously good
      // report — leave the cache intact and try again next tick.
      return this.latest
    }
    const report = await fetchAiUsage(target.login, {
      tokenFn: target.tokenFn,
      fetchImpl: this.deps.fetchImpl,
      logFn: this.deps.logFn,
    })
    // A null result (404/network) preserves the prior cached report rather
    // than wiping the meter on a transient failure.
    if (report) {
      this.latest = report
      this.deps.emit(report)
    }
    return report ?? this.latest
  }

  private scheduleNext(): void {
    if (this.stopped) return
    if (!this.deps.isEnabled()) {
      this.clearTimer()
      return
    }
    this.clearTimer()
    const interval = this.deps.refreshIntervalMs ?? AI_USAGE_REFRESH_MS
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => this.scheduleNext())
    }, interval)
    // Don't keep the event loop alive solely for the usage poll.
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}
