const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const REPO_RE = /^[A-Za-z0-9._-]+$/
const HTTPS_RE = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i
const SSH_RE = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i

export function parseRepoUrlClient(raw: string): string | undefined {
  const s = (raw ?? '').trim()
  if (!s) return undefined
  const m = s.match(HTTPS_RE) ?? s.match(SSH_RE)
  if (!m) return undefined
  const [, owner, repo] = m
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') {
    return undefined
  }
  return `${owner}/${repo}`
}
