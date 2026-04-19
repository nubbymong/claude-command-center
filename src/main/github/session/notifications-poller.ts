import type {
  GitHubConfig,
  NotificationSummary,
} from '../../../shared/github-types'
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
 * (fallback 300s) and are re-read on every tick so renderer changes to
 * sync intervals take effect immediately.
 *
 * Persistence lives in `cacheStore.notificationsByProfile[profileId]` with
 * an optional etag so 304 responses keep the existing payload without
 * re-downloading it.
 *
 * NOTE on register-time behavior: a newly registered profile runs an
 * immediate one-shot fetch so the panel has data within seconds instead
 * of waiting a full interval. Subsequent ticks honor the interval.
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

function mapOne(raw: RawNotification): NotificationSummary | null {
  if (!raw.id) return null
  // html_url isn't returned on the /notifications endpoint; we translate the
  // API url to a web url so the "open" button lands on github.com. If the
  // shape doesn't match the expected pattern we keep the api url — openExternal
  // still works, just lands in the less-useful API view.
  const apiUrl = raw.subject?.url
  let url = apiUrl ?? ''
  if (apiUrl) {
    const m = apiUrl.match(
      /api\.github\.com\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)/,
    )
    if (m) {
      const kind = m[3] === 'pulls' ? 'pull' : 'issues'
      url = `https://github.com/${m[1]}/${m[2]}/${kind}/${m[4]}`
    }
  }
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
    // Immediate first fetch so the panel populates without waiting for the
    // full interval. finally → scheduleNext mirrors the orchestrator pattern.
    if (!this.paused) {
      void this.doPoll(profileId).finally(() => void this.scheduleNext(profileId))
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
    const intervalSec = cfg?.syncIntervals.notificationsSec ?? 300
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

      let items: NotificationSummary[] | null = null
      if (r.status === 'ok') {
        items = mapMany(r.data)
      }
      // 304 => keep existing cached items; nothing to persist.

      if (items) {
        await this.deps.cacheStore.update(async (cache) => {
          cache.notificationsByProfile[profileId] = {
            lastFetched: Date.now(),
            items: items as NotificationSummary[],
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
