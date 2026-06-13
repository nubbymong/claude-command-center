// src/shared/github-features.ts
// Single source of truth for auth-feature requirements and the pure
// derivations the settings UI, badge sources, and runtime gating build on
// (spec 2026-06-13 sections 2, 4). Pure module: no stores, no IPC.
import type { AuthProfile, Capability, GitHubAuthFeatureKey } from './github-types'
import { DEFAULT_AUTH_FEATURE_TOGGLES } from './github-constants'

// Order follows DEFAULT_AUTH_FEATURE_TOGGLES declaration order and is part
// of the contract: pendingReauth output (and any UI listing built on this)
// renders in this order. Reordering the constant reorders consumers; the
// registry test locks the expected sequence.
export const AUTH_FEATURE_KEYS = Object.keys(
  DEFAULT_AUTH_FEATURE_TOGGLES,
) as GitHubAuthFeatureKey[]

export const FEATURE_CAPABILITIES: Record<GitHubAuthFeatureKey, Capability[]> = {
  activePR: ['pulls'],
  ci: ['actions'],
  reviews: ['pulls'],
  linkedIssues: ['issues'],
  notifications: ['notifications'],
  aiCredits: ['plan'],
}

export function profileCoversFeature(p: AuthProfile, key: GitHubAuthFeatureKey): boolean {
  return FEATURE_CAPABILITIES[key].every((c) => p.capabilities.includes(c))
}

/** Effective per-account toggle: the profile's own map, else the defaults
 * the caller passes (GitHubConfig.featureDefaults), else off. */
export function effectiveToggle(
  p: AuthProfile,
  key: GitHubAuthFeatureKey,
  defaults?: Partial<Record<GitHubAuthFeatureKey, boolean>>,
): boolean {
  return p.featureToggles?.[key] ?? defaults?.[key] ?? false
}

/** Full effective per-account map (every auth feature key), for
 * read-modify-write call sites that must write complete maps. */
export function effectiveToggleMap(
  p: AuthProfile,
  defaults?: Partial<Record<GitHubAuthFeatureKey, boolean>>,
): Record<GitHubAuthFeatureKey, boolean> {
  return Object.fromEntries(
    AUTH_FEATURE_KEYS.map((k) => [k, effectiveToggle(p, k, defaults)]),
  ) as Record<GitHubAuthFeatureKey, boolean>
}

/** Features switched on for this account that its scopes cannot power yet.
 * Derived, never stored: self-clears when a re-auth updates capabilities. */
export function pendingReauth(
  p: AuthProfile,
  defaults?: Partial<Record<GitHubAuthFeatureKey, boolean>>,
): GitHubAuthFeatureKey[] {
  return AUTH_FEATURE_KEYS.filter(
    (k) => effectiveToggle(p, k, defaults) && !profileCoversFeature(p, k),
  )
}

export type MasterToggleState = 'on' | 'off' | 'mixed'

export function masterState(
  profiles: AuthProfile[],
  defaults: Record<GitHubAuthFeatureKey, boolean>,
  key: GitHubAuthFeatureKey,
): MasterToggleState {
  if (profiles.length === 0) return defaults[key] ? 'on' : 'off'
  const vals = profiles.map((p) => effectiveToggle(p, key, defaults))
  if (vals.every(Boolean)) return 'on'
  if (vals.every((v) => !v)) return 'off'
  return 'mixed'
}
