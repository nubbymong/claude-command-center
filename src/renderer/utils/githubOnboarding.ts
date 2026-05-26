import type { GitHubConfig } from '../../shared/github-types'

export interface OnboardingGateInput {
  /** Hydrated GitHub config, or null before it loads. */
  githubConfig: GitHubConfig | null
  /** Per-session dismissal guard (survives re-render, resets on reload). */
  dismissedThisSession: boolean
  /** Current app version (esbuild `__APP_VERSION__` at the call site). */
  appVersion: string
  /** True while the Claude CLI first-run setup is still pending. */
  needsCliSetup: boolean
}

/**
 * Decides whether the GitHub first-run onboarding modal is due right now.
 *
 * Extracted from App.tsx so the gate is unit-testable. The ordering matters:
 *
 *  1. No config yet              -> not due (still hydrating)
 *  2. Dismissed this session     -> not due
 *  3. Has any auth profile       -> not due (UAT R2 fix: the user already set
 *     up GitHub, so never nag again even across version bumps -- the installed
 *     and dev apps share a config dir and the version thrashes, which used to
 *     defeat the seenOnboardingVersion check and re-fire the modal every launch)
 *  4. Opted out permanently      -> not due
 *  5. Already seen this version  -> not due
 *  6. CLI setup still pending     -> not due (don't stack first-run modals)
 *  7. otherwise                  -> due
 */
export function isGitHubOnboardingDue(input: OnboardingGateInput): boolean {
  const { githubConfig, dismissedThisSession, appVersion, needsCliSetup } = input
  if (!githubConfig) return false
  if (dismissedThisSession) return false
  if (Object.keys(githubConfig.authProfiles ?? {}).length > 0) return false
  if (githubConfig.seenOnboardingVersion === 'permanent') return false
  if (githubConfig.seenOnboardingVersion === appVersion) return false
  if (needsCliSetup) return false
  return true
}
