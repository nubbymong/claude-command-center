import { githubFetch, type GithubFetchOptions } from './github-fetch'

type Opts = Pick<GithubFetchOptions, 'tokenFn' | 'shield' | 'etags'>

/**
 * REST fallback for the GraphQL PR card query. Used when the configured
 * auth profile lacks GraphQL permissions (e.g. fine-grained PAT with only
 * narrow scopes) — the orchestrator falls back per endpoint and logs once.
 *
 * Every helper here returns a discriminated result so the orchestrator can
 * differentiate:
 *   - 'unchanged' (304)       — keep the existing cache entry
 *   - 'empty'                 — no matching resource (e.g. no open PR)
 *   - 'ok' + data             — usable payload
 */

export async function fetchPRByBranch(
  slug: string,
  branch: string,
  opts: Opts,
): Promise<
  | { status: 'unchanged' }
  | { status: 'empty' }
  | { status: 'ok'; data: unknown }
> {
  const [owner] = slug.split('/')
  const head = `${encodeURIComponent(owner)}:${encodeURIComponent(branch)}`
  const r = await githubFetch(
    `/repos/${slug}/pulls?head=${head}&state=open`,
    opts,
  )
  if (r.status === 304) return { status: 'unchanged' }
  if (!r.ok) return { status: 'empty' }
  const arr = (await r.json()) as unknown[]
  return arr[0] ? { status: 'ok', data: arr[0] } : { status: 'empty' }
}

export async function fetchWorkflowRuns(
  slug: string,
  branch: string,
  opts: Opts,
): Promise<{ status: 'unchanged' } | { status: 'ok'; data: unknown[] }> {
  const r = await githubFetch(
    `/repos/${slug}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=10`,
    opts,
  )
  if (r.status === 304) return { status: 'unchanged' }
  if (!r.ok) return { status: 'ok', data: [] }
  const body = (await r.json()) as { workflow_runs?: unknown[] }
  return { status: 'ok', data: body.workflow_runs ?? [] }
}

export async function fetchPRReviews(slug: string, pr: number, opts: Opts) {
  const r = await githubFetch(`/repos/${slug}/pulls/${pr}/reviews`, opts)
  if (r.status === 304) return { status: 'unchanged' as const }
  if (!r.ok) return { status: 'ok' as const, data: [] as unknown[] }
  return { status: 'ok' as const, data: (await r.json()) as unknown[] }
}

export async function fetchPRReviewComments(slug: string, pr: number, opts: Opts) {
  const r = await githubFetch(`/repos/${slug}/pulls/${pr}/comments`, opts)
  if (r.status === 304) return { status: 'unchanged' as const }
  if (!r.ok) return { status: 'ok' as const, data: [] as unknown[] }
  return { status: 'ok' as const, data: (await r.json()) as unknown[] }
}

export async function fetchRepoMergeSettings(slug: string, opts: Opts) {
  const r = await githubFetch(`/repos/${slug}`, opts)
  if (r.status === 304) return { status: 'unchanged' as const }
  if (!r.ok) return { status: 'empty' as const }
  const j = (await r.json()) as {
    allow_merge_commit?: boolean
    allow_squash_merge?: boolean
    allow_rebase_merge?: boolean
  }
  const methods: Array<'merge' | 'squash' | 'rebase'> = []
  if (j.allow_merge_commit) methods.push('merge')
  if (j.allow_squash_merge) methods.push('squash')
  if (j.allow_rebase_merge) methods.push('rebase')
  return { status: 'ok' as const, data: { allowedMergeMethods: methods } }
}

export async function fetchNotifications(
  opts: Opts,
): Promise<
  | { status: 'unchanged' }
  | { status: 'error'; httpStatus: number }
  | { status: 'ok'; data: unknown[] }
> {
  const r = await githubFetch('/notifications', opts)
  if (r.status === 304) return { status: 'unchanged' }
  // Prior impl returned { status: 'ok', data: [] } on non-200, which made
  // the poller wipe the previously-good cache on a transient 403/502.
  // Distinguishing 'error' keeps the last good payload visible until a
  // real fresh response arrives.
  if (!r.ok) return { status: 'error', httpStatus: r.status }
  return { status: 'ok', data: (await r.json()) as unknown[] }
}
