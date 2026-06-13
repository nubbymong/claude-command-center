import { describe, it, expect } from 'vitest'
import type { AuthProfile } from '../../src/shared/github-types'
import { DEFAULT_AUTH_FEATURE_TOGGLES } from '../../src/shared/github-constants'
import {
  AUTH_FEATURE_KEYS,
  FEATURE_CAPABILITIES,
  profileCoversFeature,
  effectiveToggle,
  effectiveToggleMap,
  pendingReauth,
  masterState,
  additiveScopesForPendingFeatures,
  repoModeForProfile,
} from '../../src/shared/github-features'

function profile(over: Partial<AuthProfile>): AuthProfile {
  return {
    id: 'p1', kind: 'oauth', label: 'x', username: 'x',
    scopes: [], capabilities: [], createdAt: 0, lastVerifiedAt: 0,
    expiryObservable: false,
    ...over,
  }
}

describe('feature registry', () => {
  it('covers all six auth features', () => {
    expect(AUTH_FEATURE_KEYS).toEqual(
      ['activePR', 'ci', 'reviews', 'linkedIssues', 'notifications', 'aiCredits'])
    for (const k of AUTH_FEATURE_KEYS) expect(FEATURE_CAPABILITIES[k].length).toBeGreaterThan(0)
  })
  it('aiCredits requires the plan capability', () => {
    expect(FEATURE_CAPABILITIES.aiCredits).toEqual(['plan'])
  })
})

describe('profileCoversFeature / pendingReauth', () => {
  it('covered when every required capability is granted', () => {
    const p = profile({ capabilities: ['pulls'] })
    expect(profileCoversFeature(p, 'activePR')).toBe(true)
    expect(profileCoversFeature(p, 'ci')).toBe(false)
  })
  it('pendingReauth lists enabled-but-uncovered features only', () => {
    const p = profile({
      capabilities: ['pulls'],
      featureToggles: { activePR: true, ci: true, reviews: false, linkedIssues: false, notifications: true, aiCredits: false },
    })
    expect(pendingReauth(p)).toEqual(['ci', 'notifications'])
  })
  it('profiles without a featureToggles map fall back to the provided defaults', () => {
    const p = profile({ capabilities: [] })
    expect(pendingReauth(p, { activePR: true, ci: false, reviews: false, linkedIssues: false, notifications: false, aiCredits: false }))
      .toEqual(['activePR'])
  })
  it('no toggles map and no defaults means nothing pending', () => {
    expect(pendingReauth(profile({}))).toEqual([])
  })
})

describe('effectiveToggle', () => {
  const defaults = { activePR: false, ci: true, reviews: false, linkedIssues: false, notifications: false, aiCredits: false }
  it('own map wins over defaults', () => {
    const p = profile({ featureToggles: { activePR: true, ci: false, reviews: false, linkedIssues: false, notifications: false, aiCredits: false } })
    expect(effectiveToggle(p, 'activePR', defaults)).toBe(true)
    expect(effectiveToggle(p, 'ci', defaults)).toBe(false)
  })
  it('a partially populated map falls through to defaults for missing keys', () => {
    // Runtime reality after a partial migration or manual config edit: the
    // type says full Record, the file may disagree. The ?? chain handles it.
    const p = profile({ featureToggles: { activePR: true } as unknown as AuthProfile['featureToggles'] })
    expect(effectiveToggle(p, 'activePR', defaults)).toBe(true)
    expect(effectiveToggle(p, 'ci', defaults)).toBe(true) // from defaults
    expect(effectiveToggle(p, 'reviews', defaults)).toBe(false)
  })
  it('absent map and absent defaults mean off', () => {
    expect(effectiveToggle(profile({}), 'activePR')).toBe(false)
  })
})

describe('effectiveToggleMap', () => {
  const defaults = { activePR: false, ci: true, reviews: false, linkedIssues: false, notifications: false, aiCredits: false }
  it('returns a full map over every auth feature key', () => {
    expect(Object.keys(effectiveToggleMap(profile({}), defaults)).sort())
      .toEqual([...AUTH_FEATURE_KEYS].sort())
  })
  it('own map wins, missing keys fall through to defaults, else off', () => {
    const p = profile({ featureToggles: { activePR: true } as unknown as AuthProfile['featureToggles'] })
    expect(effectiveToggleMap(p, defaults)).toEqual({
      activePR: true, // own map
      ci: true, // from defaults
      reviews: false, // from defaults
      linkedIssues: false,
      notifications: false,
      aiCredits: false,
    })
  })
  it('no map and no defaults means every key off', () => {
    expect(effectiveToggleMap(profile({}))).toEqual({
      activePR: false, ci: false, reviews: false, linkedIssues: false, notifications: false, aiCredits: false,
    })
  })
})

describe('masterState', () => {
  const defaults = { activePR: true, ci: true, reviews: true, linkedIssues: true, notifications: true, aiCredits: false }
  const on = profile({ id: 'a', featureToggles: { ...defaults, aiCredits: true } })
  const off = profile({ id: 'b', featureToggles: { ...defaults, activePR: false, aiCredits: false } })
  it('on when every profile has it on', () => {
    expect(masterState([on, off], defaults, 'ci')).toBe('on')
  })
  it('off when every profile has it off', () => {
    expect(masterState([off], defaults, 'aiCredits')).toBe('off')
  })
  it('mixed when profiles disagree', () => {
    expect(masterState([on, off], defaults, 'activePR')).toBe('mixed')
    expect(masterState([on, off], defaults, 'aiCredits')).toBe('mixed')
  })
  it('zero profiles reads featureDefaults', () => {
    expect(masterState([], defaults, 'activePR')).toBe('on')
    expect(masterState([], defaults, 'aiCredits')).toBe('off')
  })
  it('profiles missing the map inherit defaults for the comparison', () => {
    expect(masterState([profile({}), on], defaults, 'ci')).toBe('on')
  })
})

describe('additiveScopesForPendingFeatures', () => {
  const defs = { ...DEFAULT_AUTH_FEATURE_TOGGLES, aiCredits: true }
  it('returns [user] when aiCredits is enabled but plan capability is missing', () => {
    const p = profile({ capabilities: ['pulls', 'issues', 'actions', 'notifications'], featureToggles: { ...defs } })
    expect(additiveScopesForPendingFeatures(p, defs)).toEqual(['user'])
  })
  it('returns [] when every enabled feature is already covered', () => {
    const p = profile({ capabilities: ['pulls', 'issues', 'actions', 'notifications', 'plan'], featureToggles: { ...defs } })
    expect(additiveScopesForPendingFeatures(p, defs)).toEqual([])
  })
  it('never returns a scope the profile already holds', () => {
    // aiCredits is still PENDING (no `plan` capability), so `user` is a genuine
    // candidate scope — but the profile already holds it, so the dedup guard
    // (`!have.has(scope)`) must drop it: nothing additive.
    const p = profile({
      scopes: ['user'],
      capabilities: ['pulls', 'issues', 'actions', 'notifications'],
      featureToggles: { ...defs },
    })
    expect(additiveScopesForPendingFeatures(p, defs)).toEqual([])
  })
})

describe('repoModeForProfile', () => {
  it('private when the profile holds repo', () => {
    expect(repoModeForProfile(profile({ scopes: ['repo'] }))).toBe('private')
  })
  it('public otherwise', () => {
    expect(repoModeForProfile(profile({ scopes: ['public_repo'] }))).toBe('public')
  })
})
