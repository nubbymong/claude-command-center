import { GITHUB_OWNER_REGEX, GITHUB_REPO_NAME_REGEX } from '../../../shared/github-constants'

/**
 * Validates a GitHub `owner/repo` slug against GitHub's actual naming rules.
 * Returns true only for slugs we would be safe to interpolate into API URLs.
 */
export function validateSlug(slug: unknown): slug is string {
  if (typeof slug !== 'string') return false
  const parts = slug.split('/')
  if (parts.length !== 2) return false
  const [owner, repo] = parts
  if (!owner || !repo) return false
  // Match GitHub's real rules: reject dot-only names, names starting with '.',
  // and names ending in '.git' (case-insensitive).
  if (/^\.+$/.test(repo)) return false
  if (repo.startsWith('.')) return false
  if (/\.git$/i.test(repo)) return false
  if (!GITHUB_OWNER_REGEX.test(owner)) return false
  if (!GITHUB_REPO_NAME_REGEX.test(repo)) return false
  return true
}

/**
 * Parses a slug string into `{owner, repo}` if valid, else null.
 */
export function parseSlug(slug: string): { owner: string; repo: string } | null {
  if (!validateSlug(slug)) return null
  const [owner, repo] = slug.split('/')
  return { owner, repo }
}
