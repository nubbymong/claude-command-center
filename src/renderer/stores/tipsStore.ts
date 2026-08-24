/**
 * Tips Store — tracks feature usage and manages the intelligent tip display.
 *
 * Persisted to usage-tracking.json via saveConfigNow.
 */
import { create } from 'zustand'
import { saveConfigNow } from '../utils/config-saver'
import { TIPS_LIBRARY, Tip, TipContent } from '../tips-library'

/** Single feature usage event */
export interface FeatureUsage {
  firstSeenAt: number
  lastUsedAt: number
  count: number
}

/** Complete usage tracking state (persisted) */
export interface UsageTracking {
  /** Feature ID → usage event */
  features: Record<string, FeatureUsage>
  /** Tip ID → timestamp first shown */
  tipsShown: Record<string, number>
  /** Tip ID → timestamp user dismissed permanently */
  tipsDismissed: Record<string, number>
  /** Tip ID → timestamp user acted on (clicked action button) */
  tipsActed: Record<string, number>
}

export interface TipsState {
  tracking: UsageTracking
  isLoaded: boolean

  /** In-memory session state (not persisted) */
  currentTipId: string | null
  silencedUntilRestart: boolean

  hydrate: (tracking: UsageTracking) => void
  recordUsage: (featureId: string) => void
  dismissTip: (tipId: string) => void
  markTipActed: (tipId: string) => void
  silenceUntilRestart: () => void
  pickNextTip: () => void
  /** Record that a tip actually REACHED THE SCREEN. Called by whatever draws it,
   *  never by whatever chooses it -- see pickNextTip. */
  markTipShown: (tipId: string) => void
  getCurrentTip: () => { tip: Tip; content: TipContent } | null
}

const EMPTY_TRACKING: UsageTracking = {
  features: {},
  tipsShown: {},
  tipsDismissed: {},
  tipsActed: {},
}

/** A UsageTracking whose four maps all exist, whatever shape arrived. */
export function normaliseTracking(raw: unknown): UsageTracking {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const map = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, never>) : {})
  return {
    features: map(obj.features),
    tipsShown: map(obj.tipsShown),
    tipsDismissed: map(obj.tipsDismissed),
    tipsActed: map(obj.tipsActed),
  } as UsageTracking
}

/**
 * Every feature id THIS BUILD can still write, as one list.
 *
 * `VIEW_FEATURE_IDS` is imported by App.tsx and is the only place the view →
 * feature mapping lives. The rest are recorded from literal call sites; they are
 * repeated here because the prune below needs to know what is still live, and a
 * grep is not something the code can do at runtime.
 *
 * ADD AN ID HERE WHEN YOU ADD A trackUsage CALL. Forgetting is not silent: the
 * prune drops rows nothing can write and no tip refers to, so an id missing from
 * this list would have its row deleted on the next launch, and the round-trip
 * test below fails on any literal call site that is not represented.
 */
export const VIEW_FEATURE_IDS: Readonly<Record<string, string>> = {
  memory: 'memory.memory-page',
  tokenomics: 'tokenomics.dashboard',
  vision: 'vision.toggle-vision',
  insights: 'advanced.insights',
  logs: 'advanced.log-viewer',
  'cloud-agents': 'agents.cloud-agent-dispatch',
}

const DIRECT_FEATURE_IDS: readonly string[] = [
  'sessions.create-config',
  'sessions.pin-config',
  'sessions.duplicate-config',
  'sessions.effort-level',
  'sessions.session-type',
  'commands.create-command',
  'commands.command-sections',
  'commands.ctrl-click-args',
  'security.encrypted-notes',
  'webview.opened',
  'productivity.statusline-config',
  'github.signed-in',
  'github.panel-toggled',
  'github.rate-limit-seen',
  'github.session-enabled',
  'github.session-context-seen',
  'github.ai-usage-enabled',
  'agents.agent-teams',
  'canvas.opened',
  'sessions.codex-config',
  'accounts.switch-session-account',
]

/**
 * Every id this build can actually RECORD. Anything else in a user's file is a
 * row for a feature that no longer exists.
 *
 * Deliberately does NOT fold in the ids the tips library gates on. Doing that
 * was the first cut and it quietly destroyed the one test worth having: if the
 * set contains every id the library mentions, then "is every id the library
 * mentions in the set" is true by construction, and a tip gated on something
 * nothing writes sails through. The library is CHECKED against this set, so it
 * must not be a member of it.
 */
export function knownFeatureIds(): Set<string> {
  return new Set<string>([...Object.values(VIEW_FEATURE_IDS), ...DIRECT_FEATURE_IDS])
}

/**
 * Drop usage rows for features that no longer exist.
 *
 * By RULE rather than by a hand-written list of retired ids. A list would have to
 * be guessed from memory of what the app used to have -- and a guessed id that
 * never existed makes a prune that cannot fire, which is worse than no prune at
 * all because it reads as if it were doing something. The rule is checkable
 * against a real file: on this machine it drops `hooks.gateway-seen`, a row from
 * the removed hooks gateway, and leaves all thirteen live ones alone.
 *
 * Returns the SAME object when there is nothing to drop, so hydrate does not
 * write a file on every launch for no reason. The write-back is deliberate:
 * pruning in memory but not on disk would resurrect the rows on the next load.
 */
export function pruneRetiredFeatures(tracking: UsageTracking): UsageTracking {
  const known = knownFeatureIds()
  const dead = Object.keys(tracking.features ?? {}).filter((id) => !known.has(id))
  if (dead.length === 0) return tracking
  const features = { ...tracking.features }
  for (const id of dead) delete features[id]
  const next = { ...tracking, features }
  saveConfigNow('usageTracking', next)
  return next
}

/** Decide which content variant to show for a tip given usage state */
function resolveContent(tip: Tip, tracking: UsageTracking): TipContent | null {
  // Check excludes — if the user has done something that makes this tip irrelevant
  if (tip.excludes && tip.excludes.some((f) => (tracking.features ?? {})[f])) {
    return tip.variants.postUse ?? null
  }
  // Check requires — user must have done prerequisite
  if (tip.requires && !tip.requires.every((f) => (tracking.features ?? {})[f])) {
    return null
  }
  return tip.variants.primary
}

/**
 * How many tips this user has never had surfaced, and could still see: not
 * permanently dismissed, never yet shown, and currently relevant (their
 * requires/excludes resolve to real content).
 *
 * `tipsShown` is now stamped by whoever DRAWS the tip (`markTipShown`, called
 * from the dock row's render effect), not by whoever picks it -- so this counts
 * tips that have never been put on screen. It still is not "unread" in the
 * strict sense: a rendered row you never looked at is counted as shown, which is
 * the closest the renderer can honestly get. Hence "new", not "unread".
 */
export function countUnseenTips(tracking: UsageTracking): number {
  return TIPS_LIBRARY.filter((tip) => {
    if ((tracking.tipsDismissed ?? {})[tip.id]) return false
    if ((tracking.tipsShown ?? {})[tip.id]) return false
    return resolveContent(tip, tracking) !== null
  }).length
}

/** Pick the best tip to show given current state */
function selectNextTip(tracking: UsageTracking, excludeId?: string): Tip | null {
  const MIN_REPEAT_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

  const candidates = TIPS_LIBRARY.filter((tip) => {
    if (excludeId && tip.id === excludeId) return false
    // Skip permanently dismissed
    if ((tracking.tipsDismissed ?? {})[tip.id]) return false
    // Skip recently shown unless it's been 7+ days
    const shownAt = (tracking.tipsShown ?? {})[tip.id]
    if (shownAt && Date.now() - shownAt < MIN_REPEAT_MS) return false
    // Must have resolvable content (passes requires/excludes)
    const content = resolveContent(tip, tracking)
    if (!content) return false
    return true
  })

  if (candidates.length === 0) return null

  // Sort by: (1) priority, (2) simple before advanced, (3) random
  const complexityWeight = { simple: 0, intermediate: 1, advanced: 2 }
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority
    const cw = complexityWeight[a.complexity] - complexityWeight[b.complexity]
    if (cw !== 0) return cw
    return Math.random() - 0.5
  })

  return candidates[0]
}

export const useTipsStore = create<TipsState>((set, get) => ({
  tracking: EMPTY_TRACKING,
  isLoaded: false,
  currentTipId: null,
  silencedUntilRestart: false,

  // Whatever arrives becomes a VALID UsageTracking: a corrupt or partial
  // usage-tracking.json is coerced to a plain object (or {}) by hydration, and
  // an object with no maps used to pass straight through -- then the dock's
  // render called countUnseenTips on it, threw, and the app-wide ErrorBoundary
  // took the whole window down on every launch (ADR-009 pass, beta.16). Each
  // missing map is filled; a non-object map is dropped.
  hydrate: (tracking) =>
    set({ tracking: pruneRetiredFeatures(normaliseTracking(tracking)), isLoaded: true }),

  recordUsage: (featureId) => {
    set((state) => {
      const now = Date.now()
      const existing = state.tracking.features[featureId]
      const features = {
        ...state.tracking.features,
        [featureId]: existing
          ? { ...existing, lastUsedAt: now, count: existing.count + 1 }
          : { firstSeenAt: now, lastUsedAt: now, count: 1 },
      }
      const tracking = { ...state.tracking, features }
      saveConfigNow('usageTracking', tracking)
      return { tracking }
    })
  },

  dismissTip: (tipId) => {
    set((state) => {
      const tracking = {
        ...state.tracking,
        tipsDismissed: { ...state.tracking.tipsDismissed, [tipId]: Date.now() },
      }
      saveConfigNow('usageTracking', tracking)
      return { tracking, currentTipId: state.currentTipId === tipId ? null : state.currentTipId }
    })
  },

  markTipActed: (tipId) => {
    set((state) => {
      const tracking = {
        ...state.tracking,
        tipsActed: { ...state.tracking.tipsActed, [tipId]: Date.now() },
      }
      saveConfigNow('usageTracking', tracking)
      // Acknowledging ADVANCES the rotation; it never empties it. This used to
      // null currentTipId with no successor, and because the dock row only
      // renders while a current tip exists, one "Got it" (or Discuss, or the
      // tip's action button) hid the ENTIRE tip row for the rest of the
      // session — read as the panel vanishing (owner bug, 2026-08-24). The
      // acted tip itself cannot bounce straight back: it was stamped shown
      // when drawn, and selectNextTip skips shown-within-7-days (plus the
      // explicit exclude here).
      const advance = state.currentTipId === tipId && !state.silencedUntilRestart
      const next = advance ? selectNextTip(tracking, tipId) : null
      return {
        tracking,
        currentTipId: advance ? (next ? next.id : null) : state.currentTipId,
      }
    })
  },

  silenceUntilRestart: () => set({ silencedUntilRestart: true, currentTipId: null }),

  pickNextTip: () => {
    const state = get()
    if (state.silencedUntilRestart) return
    const excludeId = state.currentTipId || undefined
    const tip = selectNextTip(state.tracking, excludeId)
    // Picking is NOT showing. This used to stamp tipsShown right here, about two
    // seconds after launch, whether or not anything ever rendered -- and a
    // stamped tip does not come back for seven days. Launch onto a page tab
    // instead of a session, or with the sidebar collapsed and the pane closed,
    // and the tip was burnt without a single pixel of it reaching the screen.
    // The stamp now belongs to whoever actually draws it: markTipShown.
    set({ currentTipId: tip ? tip.id : null })
  },

  markTipShown: (tipId) => {
    set((state) => {
      // Idempotent, and deliberately keeps the FIRST timestamp: this runs from a
      // render effect, so it fires again on every remount, and refreshing the
      // stamp would keep pushing the seven-day window out and stop the tip ever
      // rotating away.
      if (state.tracking.tipsShown[tipId]) return state
      const tracking = {
        ...state.tracking,
        tipsShown: { ...state.tracking.tipsShown, [tipId]: Date.now() },
      }
      saveConfigNow('usageTracking', tracking)
      return { tracking }
    })
  },

  getCurrentTip: () => {
    const state = get()
    if (!state.currentTipId) return null
    const tip = TIPS_LIBRARY.find((t) => t.id === state.currentTipId)
    if (!tip) return null
    const content = resolveContent(tip, state.tracking)
    if (!content) return null
    return { tip, content }
  },
}))

/**
 * Helper: call this in key places throughout the app to track feature usage.
 * Example: trackUsage('sessions.create-config') after addConfig()
 */
export function trackUsage(featureId: string): void {
  useTipsStore.getState().recordUsage(featureId)
}

// Expose for dev/test access via window.__TIPS_STORE__
if (typeof window !== 'undefined') {
  ;(window as any).__TIPS_STORE__ = useTipsStore
}
