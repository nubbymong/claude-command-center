// Pure OAuth scope-string builder. No IPC, no electron imports — so it is unit
// testable in isolation and reusable by both the GITHUB_OAUTH_START handler and
// the upcoming per-profile re-auth path (which computes a scope union from the
// profile's pending features).
import { OAUTH_SCOPES_PRIVATE, OAUTH_SCOPES_PUBLIC } from '../../../shared/github-constants'

/**
 * Build the space-separated OAuth scope string for a sign-in / re-auth flow.
 *
 * The base scopes for the chosen repo-visibility mode are ALWAYS retained in
 * their declared order (so `read:org`, `notifications`, and `workflow` are never
 * dropped); `extraScopes` are unioned on AFTER the base, deduped, with any empty
 * strings filtered out.
 *
 * `buildOAuthScopeString('public', [])` returns exactly the public base string.
 */
export function buildOAuthScopeString(
  mode: 'public' | 'private',
  extraScopes: string[],
): string {
  const base = mode === 'private' ? OAUTH_SCOPES_PRIVATE : OAUTH_SCOPES_PUBLIC
  const union = new Set<string>(base.split(/\s+/))
  for (const scope of extraScopes) union.add(scope)
  return Array.from(union)
    .filter((s) => s.length > 0)
    .join(' ')
}
