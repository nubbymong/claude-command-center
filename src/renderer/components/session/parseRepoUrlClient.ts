import {
  GITHUB_OWNER_REGEX,
  GITHUB_REPO_NAME_REGEX,
} from '../../../shared/github-constants'

// https only — plain http:// on GitHub is a DNS-spoof risk on local networks.
// Mirrors src/main/github/security/repo-url-parser.ts so the client never
// accepts a value the main-process parser will later reject.
const HTTPS_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i
const SSH_RE = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i
const SSH_URL_RE = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i

export function parseRepoUrlClient(raw: string): string | undefined {
  const s = (raw ?? '').trim()
  if (!s) return undefined
  const m = s.match(HTTPS_RE) ?? s.match(SSH_RE) ?? s.match(SSH_URL_RE)
  if (!m) return undefined
  const [, owner, repo] = m
  // Reject rules mirror slug-validator: dot-only names, leading-dot names,
  // and names that still end in ".git" after the optional trailing-suffix
  // strip in the regex (rare, but possible with e.g. `repo.git.git`).
  if (/^\.+$/.test(repo)) return undefined
  if (repo.startsWith('.')) return undefined
  if (/\.git$/i.test(repo)) return undefined
  if (!GITHUB_OWNER_REGEX.test(owner) || !GITHUB_REPO_NAME_REGEX.test(repo)) {
    return undefined
  }
  return `${owner}/${repo}`
}
