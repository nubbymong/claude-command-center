// Additive, shape-detected migration to the per-account toggle model
// (spec 2026-06-13 section 2). HARD CONSTRAINTS:
//  - never bump schemaVersion (GitHubConfigStore discards the whole config
//    on version mismatch, so a bump would nuke profiles on downgrade)
//  - never delete or rewrite the legacy featureToggles field
//  - aiUsageEnabled comes from the SEPARATE settings config file; it is read
//    once here and ignored forever after (the flag itself is left in place).
import type { AuthProfile, GitHubAuthFeatureKey, GitHubConfig } from '../../shared/github-types'
import {
  DEFAULT_APP_WIDE_TOGGLES,
  DEFAULT_AUTH_FEATURE_TOGGLES,
} from '../../shared/github-constants'
import { AUTH_FEATURE_KEYS } from '../../shared/github-features'

export interface MigrateResult {
  config: GitHubConfig
  changed: boolean
}

export function migrateGitHubConfig(
  cfg: GitHubConfig,
  opts: { aiUsageEnabled: boolean },
): MigrateResult {
  // Shape detection: featureDefaults is written last below, so its presence
  // means a previous run completed. Profile-level maps may exist without it
  // (interrupted run, or a future build wrote them); those are preserved.
  // A config with only ONE of the two root fields re-enters and has BOTH
  // recomputed from the legacy values — deliberate: the single atomic write
  // below means that state can only come from a hand-edited file, and
  // recomputing beats trusting half a migration.
  if (cfg.featureDefaults && cfg.appWideToggles) return { config: cfg, changed: false }

  const legacy = cfg.featureToggles ?? {}
  const authBase: Record<GitHubAuthFeatureKey, boolean> = { ...DEFAULT_AUTH_FEATURE_TOGGLES }
  for (const k of AUTH_FEATURE_KEYS) {
    if (k in legacy) authBase[k] = Boolean((legacy as Record<string, boolean>)[k])
  }

  const profileIds = Object.keys(cfg.authProfiles)
  const authProfiles: Record<string, AuthProfile> = {}
  profileIds.forEach((id, i) => {
    const p = cfg.authProfiles[id]
    authProfiles[id] = {
      ...p,
      featureToggles: p.featureToggles ?? {
        ...authBase,
        // mirrors today's behavior: the meter used the first profile
        aiCredits: opts.aiUsageEnabled && i === 0,
      },
    }
  })

  const config: GitHubConfig = {
    ...cfg,
    authProfiles,
    appWideToggles: cfg.appWideToggles ?? {
      localGit: (legacy as Record<string, boolean>).localGit ?? DEFAULT_APP_WIDE_TOGGLES.localGit,
      sessionContext:
        (legacy as Record<string, boolean>).sessionContext ?? DEFAULT_APP_WIDE_TOGGLES.sessionContext,
    },
    featureDefaults: {
      ...authBase,
      // aiCredits never existed in the legacy schema, so any authBase
      // derivation for it is meaningless — this expression intentionally
      // replaces it. Zero profiles: park the intent so the first added
      // account inherits it.
      aiCredits: opts.aiUsageEnabled && profileIds.length === 0,
    },
  }
  return { config, changed: true }
}
