export type TkProvider = 'claude' | 'codex'

/**
 * Whose usage a row is (usage track MP9): `''` not recorded; `codex:external`
 * this computer's own Codex sign-in (~/.codex, or an inherited CODEX_HOME);
 * `<provider>:<accountId>` an account the app manages. `''` rather than NULL
 * inside every key: SQLite upserts never match NULLs.
 */
export type TkAccountKey = string
export const TK_ACCOUNT_NOT_RECORDED = ''
export const TK_CODEX_EXTERNAL = 'codex:external'
const TK_ACCOUNT_KEY_RE = /^(claude|codex):[A-Za-z0-9_-]{1,128}$/
/** A well-formed account key: not recorded, or a provider and an id. */
export function tkAccountKeyOk(key: unknown): key is TkAccountKey {
  return key === TK_ACCOUNT_NOT_RECORDED || (typeof key === 'string' && TK_ACCOUNT_KEY_RE.test(key))
}
/** An account's key: its provider and its opaque id; not recorded when
 *  either is not well formed. */
export function tkAccountKey(provider: TkProvider, accountId: string | null | undefined): TkAccountKey {
  // No id joins as `<provider>:`, which is not well formed.
  const key = [provider, accountId ?? ''].join(':')
  return tkAccountKeyOk(key) ? key : TK_ACCOUNT_NOT_RECORDED
}
/** A transcript folder and whose sessions it holds. */
export interface TkSessionsRoot { dir: string; accountKey: TkAccountKey }

/** A Claude session id as its transcript file names it, exactly: a lower-case
 *  UUID (usage track MP10). */
const TK_SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export function tkSessionUuidOk(id: unknown): id is string {
  return typeof id === 'string' && TK_SESSION_UUID_RE.test(id)
}
/** An account a Claude session can be attributed to (MP10): a Claude
 *  account's key, never "not recorded" and never another provider's. */
export function tkClaudeAccountKeyOk(key: unknown): key is TkAccountKey {
  return typeof key === 'string' && key.startsWith('claude:') && tkAccountKeyOk(key)
}

/** One billable unit, normalized across providers. */
export interface TkEvent {
  dedupKey: string        // claude: `c:${messageId}:${requestId}`  codex: `x:${sessionId}:${ordinal}`
  sessionId: string
  provider: TkProvider
  model: string           // raw, for display
  priceModel: string      // canonical pricing key, for the SQL cost join
  ts: number              // epoch ms
  cwd: string             // '' if unknown on this line
  inTok: number
  outTok: number
  cacheReadTok: number
  cacheCreateTok: number
  /** Whose usage (MP9); absent = not recorded. Stamped at ingest from the
   *  folder the transcript came from. */
  accountKey?: TkAccountKey
}

/** Per-1M-token USD pricing (cacheWrite is 0 for codex). */
export interface TkPricing { input: number; output: number; cacheRead: number; cacheWrite: number }

export interface TkConfigDim { configId: string; label: string; workingDirectory: string }

/** Summary payload — constant size regardless of corpus. */
/** The headline figures; costs cover models with a price only (MP11). */
export interface TkKpis {
  lifeToDateCostUsd: number
  last7dCostUsd: number
  prev7dCostUsd: number
  cacheEfficiencyPct: number
  cacheSavingsUsd: number
}

export interface TkSummary {
  kpis: TkKpis
  /** Usage track MP11: the same figures for each provider. */
  kpisByProvider: Record<TkProvider, TkKpis>
  /** Priced models only; `byProvider` splits each day (MP11). */
  dailySeries: Array<{ day: string; costUsd: number; byProvider: Record<TkProvider, number> }>
  /** `costUsd` is null for a model with no price (MP11), never 0. */
  modelSplit: Array<{ model: string; costUsd: number | null; tokens: number }>
  /** MP11: the models in these figures that have no price, with their
   *  provider and tokens; their cost is in no figure. */
  unpriced: Array<{ model: string; provider: TkProvider; tokens: number }>
  cacheSplit: { inputUsd: number; outputUsd: number; cacheReadUsd: number; cacheCreateUsd: number }
  costByConfig: Array<{ configId: string | null; label: string; costUsd: number; sessions: number }>
  heatmap: Array<{ bucket: number; tokens: number }>
}

export interface TkSessionRow {
  sessionId: string
  provider: TkProvider
  configId: string | null
  configLabel: string
  model: string
  /** Null when none of its models has a price (MP11). */
  costUsd: number | null
  /** Tokens of its models that have no price (MP11); 0 when all are priced. */
  unpricedTokens: number
  inTok: number
  outTok: number
  cacheReadTok: number
  cacheCreateTok: number
  msgCount: number
  lastTs: number
  /** Whose session (MP9): '' not recorded. */
  accountKey: TkAccountKey
}

export interface TkSessionsPage {
  rows: TkSessionRow[]
  nextCursor: { lastTs: number; sessionId: string } | null
}

export interface TkSessionDetail extends TkSessionRow {
  firstTs: number
  projectDir: string
  byModel: Array<{ model: string; costUsd: number | null; inTok: number; outTok: number; cacheReadTok: number; cacheCreateTok: number; msgCount: number }>
}

export interface TkIndexStatus {
  firstIndexComplete: boolean
  indexing: boolean
  filesDone: number
  filesTotal: number
  eventsTotal: number
  lastIndexAt: number | null
  /** Files the index could not open or read at all. They do NOT hold the index
   *  back — gating on one unreadable file left a first index unfinished for the
   *  life of the install — so this is how the user learns something is missing. */
  filesFailed?: number
  /** Non-null when the worker reported a fatal/uncorrelated error (e.g. a failed
   *  DB open). The renderer surfaces this instead of an endless 'indexing' state. */
  error?: string | null
  /** Usage track MP9: the one-off attribution of stored history to accounts,
   *  while it runs: re-reading the Codex history (files done of total), then
   *  rebuilding the daily and hourly rollups (rows done of total). Totals are
   *  whole throughout; only the split by provider and account is incomplete. */
  accountReread?: TkAccountReread | null
}

export interface TkAccountReread { stage: 'reread' | 'rebuild'; done: number; total: number }

/** An account present in the stored usage (MP9). */
export interface TkAccountPresent { provider: TkProvider; accountKey: TkAccountKey }

/** `provider` and `accountKey` (MP9): only that provider's, or that account's,
 *  usage; `accountKey: ''` is the usage not recorded to any account. */
export interface TkSummaryFilter { configId?: string | null; from?: number; to?: number; model?: string; provider?: TkProvider; accountKey?: TkAccountKey }
export interface TkSessionsQuery extends TkSummaryFilter { search?: string; cursor?: { lastTs: number; sessionId: string } | null; limit?: number }
