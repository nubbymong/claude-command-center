import { describe, it, expect } from 'vitest'
import { isGitHubOnboardingDue } from '../../../src/renderer/utils/githubOnboarding'
import type { GitHubConfig } from '../../../src/shared/github-types'

const VERSION = '1.5.4-beta'

function baseConfig(over: Partial<GitHubConfig> = {}): GitHubConfig {
  return {
    schemaVersion: 1,
    authProfiles: {},
    featureToggles: {} as GitHubConfig['featureToggles'],
    syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 120 },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
    ...over,
  }
}

const defaults = { dismissedThisSession: false, appVersion: VERSION, needsCliSetup: false }

describe('isGitHubOnboardingDue', () => {
  it('is due on a fresh config with no auth profiles and no seen version', () => {
    expect(isGitHubOnboardingDue({ ...defaults, githubConfig: baseConfig() })).toBe(true)
  })

  it('is NOT due once any auth profile exists (UAT R2 fix)', () => {
    const cfg = baseConfig({
      authProfiles: {
        p1: { id: 'p1', label: 'me', kind: 'oauth', createdAt: 1 } as any,
      },
    })
    expect(isGitHubOnboardingDue({ ...defaults, githubConfig: cfg })).toBe(false)
  })

  it('stays suppressed with an auth profile even on a NEW version (the re-fire bug)', () => {
    const cfg = baseConfig({
      authProfiles: { p1: { id: 'p1' } as any },
      seenOnboardingVersion: '1.0.0-old',
    })
    // appVersion differs from seenOnboardingVersion -- old behaviour re-fired here.
    expect(isGitHubOnboardingDue({ ...defaults, githubConfig: cfg, appVersion: '2.0.0-new' })).toBe(false)
  })

  it('is NOT due before config hydrates', () => {
    expect(isGitHubOnboardingDue({ ...defaults, githubConfig: null })).toBe(false)
  })

  it('is NOT due when dismissed this session', () => {
    expect(isGitHubOnboardingDue({ ...defaults, githubConfig: baseConfig(), dismissedThisSession: true })).toBe(false)
  })

  it('is NOT due when opted out permanently', () => {
    const cfg = baseConfig({ seenOnboardingVersion: 'permanent' })
    expect(isGitHubOnboardingDue({ ...defaults, githubConfig: cfg })).toBe(false)
  })

  it('is NOT due when the current version was already seen', () => {
    const cfg = baseConfig({ seenOnboardingVersion: VERSION })
    expect(isGitHubOnboardingDue({ ...defaults, githubConfig: cfg })).toBe(false)
  })

  it('is NOT due while CLI setup is still pending', () => {
    expect(isGitHubOnboardingDue({ ...defaults, githubConfig: baseConfig(), needsCliSetup: true })).toBe(false)
  })
})
