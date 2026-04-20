import type {
  GitHubConfig,
  NotificationSummary,
} from '../../../shared/github-types'
import { DEFAULT_SYNC_INTERVALS } from '../../../shared/github-constants'
import type { CacheStore } from '../cache/cache-store'
import type { RateLimitShield } from '../client/rate-limit-shield'
import type { EtagCache } from '../client/etag-cache'
import { fetchNotifications } from '../client/rest-fallback'

/**
 * Profile-scoped GitHub /notifications poller. One instance per handler
 * lifetime; profiles register/unregister as they gain/lose the
 * `notifications` capability.
 *
 * Each profile runs its own setTimeout chain keyed by profileId — keeping
 * them independent means a slow or rate-limited profile can't stall other
 * profiles' polls. Intervals come from `GitHubConfig.syncIntervals.notificationsSec`
 * (falling back to DEFAULT_SYNC_INTERVALS.notificationsSec) and are
 * re-read on every tick so renderer changes to
 * sync intervals take effect immediately.
 *
 * Persisted notification items live in
 * `cacheStore.notificationsByProfile[profileId]`. ETags are tracked
 * separately in the in-memory `EtagCache`, so 304 responses can keep
 * using the existing persisted payload for the current process lifetime
 * without re-downloading it.
 *
 * NOTE on register-time behavior: a newly registered profile emits any
 * persisted items immediately (so the panel paints from cache while the
 * network call is in flight), then runs a one-shot fetch so fresh data
 * lands within seconds instead of waiting a full interval. Subsequent
 * ticks honor the interval.
 */

export interface NotificationsPollerDeps {
  cacheStore: CacheStore
  getConfig: () => Promise<GitHubConfig | null>
  getToken: (profileId: string) => Promise<string | null>
  shield: RateLimitShield
  etags: EtagCache
  emitNotifications: (p: {
    profileId: string
    items: NotificationSummary[]
  }) => void
}

interface RawNotification {
  id: string
  reason?: string
  unread?: boolean
  updated_at?: string
  subject?: {
    title?: string
    url?: string
    type?: string
  }
  repository?: {
    full_name?: string
  }
}

/**
 * Convert a /notifications subject URL (which is an api.github.com URL)
 * into a web URL suitable for shell.openExternal. Returns null when the
 * input isn't convertible to a github.com web URL — those rows are then
 * dropped in mapOne. We refuse to return api.github.com URLs here because
 * openExternal on them lands users on a JSON response that may prompt
 * for auth; dropping the row is a better UX than surfacing a broken link.
 */
function toNotificationWebUrl(apiOrWebUrl?: string): string | null {
  if (!apiOrWebUrl) return null
  let parsed: URL
  try {
    parsed = new URL(apiOrWebUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.hostname === 'github.com' || parsed.hostname === 'www.github.com') {
    return parsed.toString()
  }
  const m = apiOrWebUrl.match(
    /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)(?:\/)?$/,
  )
  if (m) {
    const kind = m[3] === 'pulls' ? 'pull' : 'issues'
    return `https://github.com/${m[1]}/${m[2]}/${kind}/${m[4]}`
  }
  return null
}

function mapOne(raw: RawNotification): NotificationSummary | null {
  if (!raw.id) return null
  const url = toNotificationWebUrl(raw.subject?.url)
  if (!url) return null
  return {
    id: raw.id,
    type: (raw.reason ?? 'subscribed') as NotificationSummary['type'],
    repo: raw.repository?.full_name ?? '',
    title: raw.subject?.title ?? '',
    url,
    unread: raw.unread !== false,
    updatedAt: raw.updated_at ? Date.parse(raw.updated_at) : Date.now(),
  }
}

function mapMany(raw: unknown[]): NotificationSummary[] {
  const items: NotificationSummary[] = []
  for (const r of raw) {
    const m = mapOne(r as RawNotification)
    if (m) items.push(m)
  }
  return items
}

interface ProfileState {
  profileId: string
  timer?: NodeJS.Timeout
}

export class NotificationsPoller {
  private profiles = new Map<string, ProfileState>()
  private paused = false
  private stopped = false

  constructor(private deps: NotificationsPollerDeps) {}

  registerProfile(profileId: string): void {
    if (this.stopped) return
    if (this.profiles.has(profileId)) return
    const state: ProfileState = { profileId }
    this.profiles.set(profileId, state)
    // Emit whatever is already on disk FIRST so the panel paints from
    // cache immediately on register. Without this, if the first network
    // poll returns 304 (nothing new since last run) or a transient
    // non-200, the renderer store would stay empty until a real 'ok'
    // tick — which could be up to a full sync interval away.
    void this.emitCachedItems(profileId)
    // Immediate first fetch so the panel populates without waiting for the
    // full interval. finally → scheduleNext mirrors the orchestrator pattern.
    if (!this.paused) {
      void this.doPoll(profileId).finally(() => void this.scheduleNext(profileId))
    }
  }

  private async emitCachedItems(profileId: string): Promise<void> {
    try {
      const cache = await this.deps.cacheStore.load()
      const entry = cache.notificationsByProfile[profileId]
      if (entry && entry.items.length > 0) {
        this.deps.emitNotifications({ profileId, items: entry.items })
      }
    } catch {
      // Cache read can't meaningfully fail here (the orchestrator has
      // already loaded the store at handler-init time); swallow and
      // let the live fetch provide data.
    }
  }

  unregisterProfile(profileId: string): void {
    const s = this.profiles.get(profileId)
    if (s?.timer) clearTimeout(s.timer)
    this.profiles.delete(profileId)
  }

  pause(): void {
    this.paused = true
    // Cancel all armed timers. Same motivation as the orchestrator's pause():
    // a scheduleNext from just before pause() flipped could still fire and
    // hit the network post-pause. Clearing here makes pause immediate.
    this.profiles.forEach((s) => {
      if (s.timer) {
        clearTimeout(s.timer)
        s.timer = undefined
      }
    })
  }

  resume(): void {
    this.paused = false
    this.profiles.forEach((s) => void this.scheduleNext(s.profileId))
  }

  stop(): void {
    this.stopped = true
    this.pause()
    this.profiles.clear()
  }

  async syncNow(profileId: string): Promise<void> {
    if (this.stopped) return
    await this.doPoll(profileId)
  }

  /**
   * Diff current registrations against a desired set and register/unregister
   * to match. Idempotent — intended to be called whenever the authoritative
   * set of notifications-capable profile ids changes (profile added, profile
   * removed, capabilities re-scanned). Avoids the caller needing to track
   * which profiles the poller already knows about.
   */
  syncTo(wanted: Set<string>): void {
    if (this.stopped) return
    for (const id of Array.from(this.profiles.keys())) {
      if (!wanted.has(id)) this.unregisterProfile(id)
    }
    for (const id of wanted) this.registerProfile(id)
  }

  private async scheduleNext(profileId: string): Promise<void> {
    if (this.paused || this.stopped) return
    const s = this.profiles.get(profileId)
    if (!s) return
    if (s.timer) clearTimeout(s.timer)
    const cfg = await this.deps.getConfig()
    // Re-check after the await: unregisterProfile could have happened
    // while getConfig was in flight. Leaking a setTimeout here would
    // wedge a profile's poller that's supposed to be stopped.
    const current = this.profiles.get(profileId)
    if (!current || current !== s) return
    // Use the shared default so first-launch (null config) polls at the
    // same cadence as every other sync interval definition in the repo.
    // Previously the hardcoded 300 diverged from DEFAULT_SYNC_INTERVALS.
    const intervalSec =
      cfg?.syncIntervals.notificationsSec ?? DEFAULT_SYNC_INTERVALS.notificationsSec
    s.timer = setTimeout(() => {
      void this.doPoll(profileId).finally(() => void this.scheduleNext(profileId))
    }, intervalSec * 1000)
  }

  private async doPoll(profileId: string): Promise<void> {
    const state = this.profiles.get(profileId)
    if (!state) return
    const token = await this.deps.getToken(profileId)
    if (!token) return

    try {
      const r = await fetchNotifications({
        tokenFn: async () => token,
        shield: this.deps.shield,
        etags: this.deps.etags,
      })

      // Only 'ok' writes to cache. 'unchanged' (304) preserves the previous
      // payload; 'error' (non-200) preserves it too, so a transient 403/502
      // doesn't wipe good items from the UI and force a full refetch.
      if (r.status === 'ok') {
        const items = mapMany(r.data)
        await this.deps.cacheStore.update(async (cache) => {
          cache.notificationsByProfile[profileId] = {
            lastFetched: Date.now(),
            items,
          }
        })
        this.deps.emitNotifications({ profileId, items })
      }
    } catch {
      // Silent-fail: RateLimitError is handled by the shield (it throttles
      // the bucket), auth errors are surfaced via the profile's lastAuthErrorAt
      // on next test, and transient network errors are retried on the next tick.
    }
  }
}
