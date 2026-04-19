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
  emitData: (p: { slug: string; data: RepoCache }) => void
  emitSyncState: (p: SyncStateEvent) => void
  fetchers: OrchestratorFetchers
  /**
   * Optional per-session branch refresher. Called immediately before each
   * sync so a `git checkout` away from the branch registered at session-
   * setup time doesn't leave the orchestrator polling the stale branch's
   * PR / runs / reviews. Return `null` to keep the last known value (e.g.
   * on transient git failure).
   */
  getBranch?: (sessionId: string) => Promise<string | null>
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
    const isFirst = !prev
    this.sessions.set(input.sessionId, { ...input, focused: false, lastSync: 0 })
    if (isFirst && !this.paused) {
      // Kick off an immediate sync on first registration so the panel has
      // data to show instead of sitting at 'idle' for 60-300s. doSync's
      // finally chains to scheduleNext which arms the normal interval.
      void this.doSync(input.sessionId).finally(() =>
        void this.scheduleNext(input.sessionId),
      )
    } else {
      void this.scheduleNext(input.sessionId)
    }
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
    // Cancel any in-flight timers. Without this, the last scheduleNext()
    // already armed a setTimeout that fires even after pause() flips the
    // flag — doSync then runs because pause is only checked before arming,
    // not before execution. Clearing here makes "Pause syncs" effective
    // immediately.
    this.sessions.forEach((s) => {
      if (s.timer) {
        clearTimeout(s.timer)
        s.timer = undefined
      }
    })
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
      // Re-check after the await: unregisterSession could have run while
      // getConfig was in flight. If we leaked a setTimeout here the timer
      // would fire against a stale SessionState and the orchestrator would
      // keep doing background work for a session that no longer exists.
      const current = this.sessions.get(id)
      if (!current || current !== s) return
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

    // Refresh the branch if the host provided a resolver. Without this,
    // the orchestrator would keep polling whatever branch was active at
    // registration time even after the user `git checkout`s elsewhere.
    if (this.deps.getBranch) {
      try {
        const fresh = await this.deps.getBranch(s.sessionId)
        if (fresh) s.branch = fresh
      } catch {
        /* leave s.branch alone on transient failure */
      }
    }

    const ctx: FetcherContext = {
      sessionId: s.sessionId,
      slug: s.slug,
      branch: s.branch,
    }

    // Run the fetches outside the cache mutex — network I/O shouldn't block
    // other sessions' cache reads — and commit the result atomically via
    // update(). Prior impl loaded the cache, did all fetches, then saved
    // the snapshot; two concurrent sessions could both load the same base
    // and the later save clobbered the earlier session's updates.
    let emitted: RepoCache | null = null
    try {
      const prR = await this.deps.fetchers.pr(ctx)
      const runsR = await this.deps.fetchers.runs(ctx)

      // Peek at the current cache to know if we already have a PR number
      // (for the reviews follow-up call when the PR fetch is 'unchanged').
      const peeked = await this.deps.cacheStore.load()
      const prior: RepoCache = peeked.repos[s.slug] ?? {
        etags: {},
        lastSynced: 0,
        accessedAt: 0,
      }

      // Determine the PR we'll use for the reviews call. 'ok' and 'unchanged'
      // both keep a PR; 'empty' clears it.
      let prForReviews: number | undefined
      if (prR.status === 'ok') prForReviews = (prR.data as { number?: number }).number
      else if (prR.status === 'unchanged') prForReviews = prior.pr?.number

      let revR: FetchResult<unknown[]> | null = null
      if (prForReviews !== undefined) {
        revR = await this.deps.fetchers.reviews(ctx, prForReviews)
      }

      await this.deps.cacheStore.update(async (cache) => {
        const existing: RepoCache = cache.repos[s.slug] ?? {
          etags: {},
          lastSynced: 0,
          accessedAt: 0,
        }
        if (prR.status === 'ok') {
          existing.pr = mapPR(prR.data)
        } else if (prR.status === 'empty') {
          // RepoCache.pr is optional; use undefined (not null) so render
          // code only has one "no PR" sentinel. Reviews are PR-derived so
          // clear them too — otherwise a merged branch keeps stale reviews.
          existing.pr = undefined
          existing.reviews = undefined
        }
        // 'unchanged' intentionally leaves existing.pr alone — the point
        // of the 304 path is to preserve what the previous sync loaded.

        if (runsR.status === 'ok') {
          existing.actions = mapRuns(runsR.data)
        }

        if (revR && revR.status === 'ok') {
          existing.reviews = mapReviews(revR.data)
        }

        existing.lastSynced = Date.now()
        existing.accessedAt = Date.now()
        cache.repos[s.slug] = existing
        // True access-order LRU: move the slug to the most-recent end every
        // access. Previous impl only appended on first use, so hot repos
        // kept their original position and got evicted as "oldest".
        const lruIndex = cache.lru.indexOf(s.slug)
        if (lruIndex !== -1) cache.lru.splice(lruIndex, 1)
        cache.lru.push(s.slug)
        emitted = existing
      })

      if (emitted) {
        this.deps.emitData({ slug: s.slug, data: emitted })
      }
      this.deps.emitSyncState({ slug: s.slug, state: 'synced', at: Date.now() })
      s.lastSync = Date.now()
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
