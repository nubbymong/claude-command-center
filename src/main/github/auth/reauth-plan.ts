// Pure per-profile re-auth planner. No IPC, no electron — unit-testable in
// isolation. Turns a profile + its enabled features into the kind-specific
// next step: oauth -> the scope union to request; pat/gh-cli -> inline copy.
import type { AuthProfile, GitHubAuthFeatureKey, ReauthPlan } from '../../../shared/github-types'
import { additiveScopesForPendingFeatures, repoModeForProfile } from '../../../shared/github-features'

function fmtScopes(scopes: string[]): string {
  return scopes.map((s) => `\`${s}\``).join(', ')
}

export function reauthPlanForProfile(
  p: AuthProfile,
  defaults?: Partial<Record<GitHubAuthFeatureKey, boolean>>,
): ReauthPlan {
  const scopes = additiveScopesForPendingFeatures(p, defaults)
  switch (p.kind) {
    case 'oauth':
      return { kind: 'oauth', mode: repoModeForProfile(p), scopes }
    case 'pat-classic':
      return {
        kind: 'pat-classic',
        scopes,
        instruction:
          scopes.length > 0
            ? `Edit this classic token and add the ${fmtScopes(scopes)} scope${scopes.length > 1 ? 's' : ''}, then re-save it here.`
            : 'This classic token already has every scope its enabled features need.',
      }
    case 'pat-fine-grained':
      // The only fine-grained-relevant pending capability is `plan`, which maps
      // to the Account permission "Plan: read" (not an OAuth scope).
      return {
        kind: 'pat-fine-grained',
        scopes,
        instruction:
          scopes.length > 0
            ? 'Edit this fine-grained token and add Account permissions Plan: read, then re-save it here.'
            : 'This fine-grained token already has every permission its enabled features need.',
      }
    case 'gh-cli':
      return {
        kind: 'gh-cli',
        scopes,
        command:
          scopes.length > 0
            ? `gh auth refresh -h github.com -s ${scopes.join(' ')}`
            : 'gh auth refresh -h github.com',
      }
  }
}
