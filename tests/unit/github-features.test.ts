import { describe, it, expect } from 'vitest'
import type { AuthProfile } from '../../src/shared/github-types'
import {
  AUTH_FEATURE_KEYS,
  FEATURE_CAPABILITIES,
  profileCoversFeature,
  pendingReauth,
  masterState,
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
