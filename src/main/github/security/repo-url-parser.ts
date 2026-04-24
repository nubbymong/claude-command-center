import { validateSlug } from './slug-validator'

// https only — plain http:// enables DNS-spoof attacks on local networks.
const HTTPS_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i
const SSH_RE = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i
const SSH_URL_RE = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i

export function parseRepoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  const m = s.match(HTTPS_RE) ?? s.match(SSH_RE) ?? s.match(SSH_URL_RE)
  if (!m) return null
  const slug = `${m[1]}/${m[2]}`
  return validateSlug(slug) ? slug : null
}
