export type TkProvider = 'claude' | 'codex'

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
}

/** Per-1M-token USD pricing (cacheWrite is 0 for codex). */
export interface TkPricing { input: number; output: number; cacheRead: number; cacheWrite: number }

export interface TkConfigDim { configId: string; label: string; workingDirectory: string }

/** Summary payload — constant size regardless of corpus. */
export interface TkSummary {
  kpis: {
    lifeToDateCostUsd: number
    last7dCostUsd: number
    prev7dCostUsd: number
    cacheEfficiencyPct: number
    cacheSavingsUsd: number
  }
  dailySeries: Array<{ day: string; costUsd: number }>
  modelSplit: Array<{ model: string; costUsd: number; tokens: number }>
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
  costUsd: number
  inTok: number
  outTok: number
  cacheReadTok: number
  cacheCreateTok: number
  msgCount: number
  lastTs: number
}

export interface TkSessionsPage {
  rows: TkSessionRow[]
  nextCursor: { lastTs: number; sessionId: string } | null
}

export interface TkSessionDetail extends TkSessionRow {
  firstTs: number
  projectDir: string
  byModel: Array<{ model: string; costUsd: number; inTok: number; outTok: number; cacheReadTok: number; cacheCreateTok: number; msgCount: number }>
}

export interface TkIndexStatus {
  firstIndexComplete: boolean
  indexing: boolean
  filesDone: number
  filesTotal: number
  eventsTotal: number
  lastIndexAt: number | null
  /** Non-null when the worker reported a fatal/uncorrelated error (e.g. a failed
   *  DB open). The renderer surfaces this instead of an endless 'indexing' state. */
  error?: string | null
}

export interface TkSummaryFilter { configId?: string | null; from?: number; to?: number; model?: string }
export interface TkSessionsQuery extends TkSummaryFilter { search?: string; cursor?: { lastTs: number; sessionId: string } | null; limit?: number }
