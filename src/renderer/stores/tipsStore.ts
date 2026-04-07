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
  getCurrentTip: () => { tip: Tip; content: TipContent } | null
}

const EMPTY_TRACKING: UsageTracking = {
  features: {},
  tipsShown: {},
  tipsDismissed: {},
  tipsActed: {},
}

/** Decide which content variant to show for a tip given usage state */
function resolveContent(tip: Tip, tracking: UsageTracking): TipContent | null {
  // Check excludes — if the user has done something that makes this tip irrelevant
  if (tip.excludes && tip.excludes.some((f) => tracking.features[f])) {
    return tip.variants.postUse ?? null
  }
  // Check requires — user must have done prerequisite
  if (tip.requires && !tip.requires.every((f) => tracking.features[f])) {
    return null
  }
  return tip.variants.primary
}

/** Pick the best tip to show given current state */
function selectNextTip(tracking: UsageTracking, excludeId?: string): Tip | null {
  const MIN_REPEAT_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

  const candidates = TIPS_LIBRARY.filter((tip) => {
    if (excludeId && tip.id === excludeId) return false
    // Skip permanently dismissed
    if (tracking.tipsDismissed[tip.id]) return false
    // Skip recently shown unless it's been 7+ days
    const shownAt = tracking.tipsShown[tip.id]
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

  hydrate: (tracking) => set({ tracking: tracking || EMPTY_TRACKING, isLoaded: true }),

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
      return { tracking }
    })
  },

  silenceUntilRestart: () => set({ silencedUntilRestart: true, currentTipId: null }),

  pickNextTip: () => {
    const state = get()
    if (state.silencedUntilRestart) return
    const excludeId = state.currentTipId || undefined
    const tip = selectNextTip(state.tracking, excludeId)
    if (tip) {
      set((s) => {
        const tracking = {
          ...s.tracking,
          tipsShown: { ...s.tracking.tipsShown, [tip.id]: Date.now() },
        }
        saveConfigNow('usageTracking', tracking)
        return { tracking, currentTipId: tip.id }
      })
    } else {
      set({ currentTipId: null })
    }
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
