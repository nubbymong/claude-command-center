import { describe, it, expect } from 'vitest'
import type { GitHubConfig, AuthProfile } from '../../src/shared/github-types'
import { migrateGitHubConfig } from '../../src/main/github/github-config-migrate'

function legacyProfile(id: string): AuthProfile {
  return {
    id, kind: 'oauth', label: id, username: id, scopes: ['repo'],
    capabilities: ['pulls'], createdAt: 0, lastVerifiedAt: 0, expiryObservable: false,
  }
}
function legacyConfig(profileIds: string[]): GitHubConfig {
  return {
    schemaVersion: 1,
    authProfiles: Object.fromEntries(profileIds.map((id) => [id, legacyProfile(id)])),
    featureToggles: {
      activePR: true, ci: false, reviews: true, linkedIssues: true,
      notifications: false, localGit: true, sessionContext: false,
    },
    syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 180 },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
  }
}

describe('migrateGitHubConfig', () => {
  it('copies legacy auth toggles onto every profile and into featureDefaults', () => {
    const { config, changed } = migrateGitHubConfig(legacyConfig(['a', 'b']), { aiUsageEnabled: false })
    expect(changed).toBe(true)
    for (const id of ['a', 'b']) {
      expect(config.authProfiles[id].featureToggles).toEqual({
        activePR: true, ci: false, reviews: true, linkedIssues: true,
        notifications: false, aiCredits: false,
      })
    }
    expect(config.featureDefaults).toEqual({
      activePR: true, ci: false, reviews: true, linkedIssues: true,
      notifications: false, aiCredits: false,
    })
  })
  it('moves localGit/sessionContext into appWideToggles and keeps the legacy field intact', () => {
    const { config } = migrateGitHubConfig(legacyConfig(['a']), { aiUsageEnabled: false })
    expect(config.appWideToggles).toEqual({ localGit: true, sessionContext: false })
    expect(config.featureToggles).toEqual(legacyConfig(['a']).featureToggles) // untouched for downgrade
    expect(config.schemaVersion).toBe(1) // NEVER bumped (downgrade discards on mismatch)
  })
  it('maps the settings AI flag onto the FIRST profile only', () => {
    const { config } = migrateGitHubConfig(legacyConfig(['a', 'b']), { aiUsageEnabled: true })
    expect(config.authProfiles['a'].featureToggles?.aiCredits).toBe(true)
    expect(config.authProfiles['b'].featureToggles?.aiCredits).toBe(false)
    expect(config.featureDefaults?.aiCredits).toBe(false)
  })
  it('zero profiles with the AI flag set parks intent in featureDefaults', () => {
    const { config } = migrateGitHubConfig(legacyConfig([]), { aiUsageEnabled: true })
    expect(config.featureDefaults?.aiCredits).toBe(true)
  })
  it('is idempotent: a migrated config returns changed=false and identical content', () => {
    const first = migrateGitHubConfig(legacyConfig(['a']), { aiUsageEnabled: true })
    const second = migrateGitHubConfig(first.config, { aiUsageEnabled: false }) // flag flip must NOT re-apply
    expect(second.changed).toBe(false)
    expect(second.config).toEqual(first.config)
  })
  it('partially-new shape (profile maps but no featureDefaults) completes without clobbering profile maps', () => {
    const cfg = legacyConfig(['a'])
    cfg.authProfiles['a'].featureToggles = {
      activePR: false, ci: false, reviews: false, linkedIssues: false, notifications: false, aiCredits: true,
    }
    const { config, changed } = migrateGitHubConfig(cfg, { aiUsageEnabled: false })
    expect(changed).toBe(true)
    expect(config.authProfiles['a'].featureToggles?.aiCredits).toBe(true) // preserved
    expect(config.featureDefaults).toBeDefined()
  })
  it('one root field present without the other re-enters and recomputes BOTH from legacy values', () => {
    // Only reachable via a hand-edited file (the real write is atomic).
    // Deliberate semantics: recompute beats trusting half a migration —
    // the pre-existing featureDefaults is replaced, not preserved.
    const cfg = legacyConfig(['a'])
    cfg.featureDefaults = {
      activePR: false, ci: false, reviews: false, linkedIssues: false, notifications: false, aiCredits: true,
    }
    const { config, changed } = migrateGitHubConfig(cfg, { aiUsageEnabled: false })
    expect(changed).toBe(true)
    expect(config.appWideToggles).toEqual({ localGit: true, sessionContext: false })
    expect(config.featureDefaults).toEqual({
      activePR: true, ci: false, reviews: true, linkedIssues: true,
      notifications: false, aiCredits: false, // recomputed from legacy + flag, hand-edit discarded
    })
  })
})
