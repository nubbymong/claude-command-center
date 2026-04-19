import type {
  GitHubConfig,
  PRSnapshot,
  RepoCache,
  ReviewSnapshot,
  SessionGitHubIntegration,
  WorkflowRunSnapshot,
} from '../../../shared/github-types'
import type { CacheStore } from '../cache/cache-store'

type FetchResult<T> =
  | { status: 'unchanged' }
  | { status: 'empty' }
  | { status: 'ok'; data: T }

export interface FetcherContext {
  sessionId: string
  slug: string
  branch: string
}

export interface OrchestratorFetchers {
  pr: (ctx: FetcherContext) => Promise<FetchResult<unknown>>
  runs: (ctx: FetcherContext) => Promise<FetchResult<unknown[]>>
  reviews: (ctx: FetcherContext, prNumber: number) => Promise<FetchResult<unknown[]>>
}

export type SyncState = 'syncing' | 'synced' | 'rate-limited' | 'error' | 'idle'

export interface SyncStateEvent {
  slug: string
  state: SyncState
  at: number
  nextResetAt?: number
}

export interface SyncOrchestratorDeps {
  cacheStore: CacheStore
  getConfig: () => Promise<GitHubConfig | null>
  getTokenForSession: (sessionId: string) => Promise<string | null>
  emitData: (p: { slug: string; data: RepoCache }) => void
  emitSyncState: (p: SyncStateEvent) => void
  fetchers: OrchestratorFetchers
}

export interface RegisterSessionInput {
  sessionId: string
  slug: string
  branch: string
  integration: SessionGitHubIntegration
}

interface SessionState extends RegisterSessionInput {
  timer?: NodeJS.Timeout
  focused: boolean
  lastSync: number
  // Set when a RateLimitError lands; scheduleNext reads it to delay the next
  // attempt until after the reset, then clears on the next successful sync.
  rateLimitedUntil?: number
}

interface RateLimitErrorLike {
  name: string
  resetAt?: number
}

function isRateLimitError(err: unknown): err is RateLimitErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'RateLimitError'
  )
}

export class SyncOrchestrator {
  private sessions = new Map<string, SessionState>()
  private paused = false

  constructor(private deps: SyncOrchestratorDeps) {}

  registerSession(input: RegisterSessionInput): void {
    // Clear any existing timer for this id — re-registering an already-
    // registered session (e.g. after the user edits the slug) must not leak
    // the previous timer, which still holds a closure on the old state.
    const prev = this.sessions.get(input.sessionId)
    if (prev?.timer) clearTimeout(prev.timer)
    this.sessions.set(input.sessionId, { ...input, focused: false, lastSync: 0 })
    void this.scheduleNext(input.sessionId)
  }

  unregisterSession(id: string): void {
    const s = this.sessions.get(id)
    if (s?.timer) clearTimeout(s.timer)
    this.sessions.delete(id)
  }

  setFocus(id: string, focused: boolean): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.focused = focused
    void this.scheduleNext(id)
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    this.sessions.forEach((_, id) => void this.scheduleNext(id))
  }

  isPaused(): boolean {
    return this.paused
  }

  async syncNow(sessionId: string): Promise<void> {
    await this.doSync(sessionId)
  }

  private async scheduleNext(id: string): Promise<void> {
    if (this.paused) return
    const s = this.sessions.get(id)
    if (!s) return
    if (s.timer) clearTimeout(s.timer)

    // Rate-limit backoff wins over normal interval. Otherwise the outer
    // `finally(() => scheduleNext)` after doSync would replace the reset-
    // based wait with the normal interval and defeat the shield entirely.
    let delayMs: number
    const now = Date.now()
    if (s.rateLimitedUntil && now < s.rateLimitedUntil) {
      delayMs = Math.max(s.rateLimitedUntil - now + 1000, 1000)
    } else {
      const cfg = await this.deps.getConfig()
      const intervalSec = s.focused
        ? cfg?.syncIntervals.activeSessionSec ?? 60
        : cfg?.syncIntervals.backgroundSec ?? 300
      delayMs = intervalSec * 1000
    }

    s.timer = setTimeout(() => {
      void this.doSync(id).finally(() => void this.scheduleNext(id))
    }, delayMs)
  }

  private async doSync(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return

    this.deps.emitSyncState({ slug: s.slug, state: 'syncing', at: Date.now() })

    const cache = await this.deps.cacheStore.load()
    const existing: RepoCache = cache.repos[s.slug] ?? {
      etags: {},
      lastSynced: 0,
      accessedAt: 0,
    }

    const ctx: FetcherContext = {
      sessionId: s.sessionId,
      slug: s.slug,
      branch: s.branch,
    }

    try {
      const prR = await this.deps.fetchers.pr(ctx)
      if (prR.status === 'ok') {
        existing.pr = mapPR(prR.data)
      } else if (prR.status === 'empty') {
        // RepoCache.pr is optional; use undefined (not null) so render code
        // only has one "no PR" sentinel to handle.
        existing.pr = undefined
      }
      // 'unchanged' intentionally leaves existing.pr alone — that's the
      // whole point of the 304 path; we preserve what the previous sync
      // loaded rather than blanking the card while polling.

      const runsR = await this.deps.fetchers.runs(ctx)
      if (runsR.status === 'ok') {
        existing.actions = mapRuns(runsR.data)
      }

      if (existing.pr) {
        const revR = await this.deps.fetchers.reviews(ctx, existing.pr.number)
        if (revR.status === 'ok') {
          existing.reviews = mapReviews(revR.data)
        }
      }

      existing.lastSynced = Date.now()
      existing.accessedAt = Date.now()
      cache.repos[s.slug] = existing
      // True access-order LRU: move the slug to the most-recent end every
      // access. Previous impl only appended on first use, so hot repos kept
      // their original position and were wrongly evicted as "oldest".
      const lruIndex = cache.lru.indexOf(s.slug)
      if (lruIndex !== -1) cache.lru.splice(lruIndex, 1)
      cache.lru.push(s.slug)
      await this.deps.cacheStore.save(cache)

      this.deps.emitData({ slug: s.slug, data: existing })
      this.deps.emitSyncState({ slug: s.slug, state: 'synced', at: Date.now() })
      s.lastSync = Date.now()
      // Clear any prior rate-limit deadline — we just succeeded.
      s.rateLimitedUntil = undefined
    } catch (err: unknown) {
      if (isRateLimitError(err)) {
        // Record the deadline; scheduleNext honors it. Don't arm a timer
        // here directly — the outer `finally(() => scheduleNext)` would
        // race and clobber it. rateLimitedUntil is cleared on next success.
        s.rateLimitedUntil = err.resetAt
        this.deps.emitSyncState({
          slug: s.slug,
          state: 'rate-limited',
          at: Date.now(),
          nextResetAt: err.resetAt,
        })
      } else {
        this.deps.emitSyncState({ slug: s.slug, state: 'error', at: Date.now() })
      }
    }
  }
}

interface RawPR {
  number: number
  title: string
  state: PRSnapshot['state']
  draft?: boolean
  user?: { login?: string; avatar_url?: string }
  created_at: string
  updated_at: string
  mergeable?: boolean | null
  html_url: string
}

function mapPR(raw: unknown): PRSnapshot {
  const r = raw as RawPR
  return {
    number: r.number,
    title: r.title,
    state: r.state,
    draft: !!r.draft,
    author: r.user?.login ?? 'unknown',
    authorAvatarUrl: r.user?.avatar_url,
    createdAt: Date.parse(r.created_at),
    updatedAt: Date.parse(r.updated_at),
    mergeableState:
      r.mergeable === null || r.mergeable === undefined
        ? 'unknown'
        : r.mergeable
        ? 'clean'
        : 'conflict',
    url: r.html_url,
  }
}

interface RawRun {
  id: number
  name?: string
  workflow_id?: number
  status: WorkflowRunSnapshot['status']
  conclusion?: WorkflowRunSnapshot['conclusion']
  html_url: string
}

function mapRuns(raw: unknown[]): WorkflowRunSnapshot[] {
  return (raw as RawRun[]).map((r) => ({
    id: r.id,
    workflowName: r.name ?? String(r.workflow_id ?? 'workflow'),
    status: r.status,
    conclusion: r.conclusion ?? null,
    url: r.html_url,
  }))
}

interface RawReview {
  id: number
  user?: { login?: string; avatar_url?: string }
  state: ReviewSnapshot['state']
}

function mapReviews(raw: unknown[]): ReviewSnapshot[] {
  return (raw as RawReview[]).map((rv) => ({
    id: rv.id,
    reviewer: rv.user?.login ?? 'unknown',
    reviewerAvatarUrl: rv.user?.avatar_url,
    state: rv.state,
    threads: [],
  }))
}
