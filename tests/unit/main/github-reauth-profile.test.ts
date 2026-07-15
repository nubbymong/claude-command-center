import { describe, it, expect } from 'vitest'
import { reauthPlanForProfile } from '../../../src/main/github/auth/reauth-plan'
import { DEFAULT_AUTH_FEATURE_TOGGLES } from '../../../src/shared/github-constants'
import type { AuthProfile } from '../../../src/shared/github-types'

// Mirrors the factory in tests/unit/github-features.test.ts so every fixture is
// a type-valid AuthProfile.
function base(over: Partial<AuthProfile>): AuthProfile {
  return {
    id: 'p1', kind: 'oauth', label: 'x', username: 'x',
    scopes: [], capabilities: [], createdAt: 0, lastVerifiedAt: 0,
    expiryObservable: false,
    ...over,
  }
}

// aiCredits ON, everything else default. With a profile that holds every
// capability EXCEPT `plan`, only aiCredits stays pending → the additive scope
// delta is exactly ['user'] for the standard cases.
const defs = { ...DEFAULT_AUTH_FEATURE_TOGGLES, aiCredits: true }

describe('reauthPlanForProfile', () => {
  it('oauth + aiCredits pending → oauth plan whose scopes include user', () => {
    const p = base({ kind: 'oauth', scopes: ['repo', 'read:org'], capabilities: ['pulls', 'issues', 'actions', 'notifications'], featureToggles: { ...defs } })
    const plan = reauthPlanForProfile(p, defs)
    expect(plan.kind).toBe('oauth')
    if (plan.kind === 'oauth') {
      expect(plan.mode).toBe('private')
      expect(plan.scopes).toContain('user')
    }
  })
  it('oauth public mode when the profile lacks repo', () => {
    const p = base({ kind: 'oauth', scopes: ['public_repo'], capabilities: [], featureToggles: { ...defs } })
    const plan = reauthPlanForProfile(p, defs)
    expect(plan.kind === 'oauth' && plan.mode).toBe('public')
  })
  it('pat-classic → instruction mentions the user scope', () => {
    const p = base({ kind: 'pat-classic', scopes: ['repo'], capabilities: ['pulls', 'issues', 'actions', 'notifications'], featureToggles: { ...defs } })
    const plan = reauthPlanForProfile(p, defs)
    expect(plan.kind).toBe('pat-classic')
    if (plan.kind === 'pat-classic') expect(plan.instruction).toContain('user')
  })
  it('pat-fine-grained → instruction mentions Plan: read', () => {
    const p = base({ kind: 'pat-fine-grained', scopes: [], capabilities: ['pulls', 'issues', 'actions'], featureToggles: { ...defs } })
    const plan = reauthPlanForProfile(p, defs)
    if (plan.kind === 'pat-fine-grained') expect(plan.instruction).toContain('Plan: read')
  })
  it('gh-cli → the exact gh auth refresh command computed from the scope delta', () => {
    const p = base({ kind: 'gh-cli', scopes: ['repo'], capabilities: ['pulls', 'issues', 'actions', 'notifications'], featureToggles: { ...defs } })
    const plan = reauthPlanForProfile(p, defs)
    expect(plan.kind === 'gh-cli' && plan.command).toBe('gh auth refresh -h github.com -s user')
  })
})
