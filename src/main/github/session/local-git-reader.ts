import type { LocalGitState } from '../../../shared/github-types'
import type { RunGit } from './repo-detector'

const EMPTY: LocalGitState = {
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  stashCount: 0,
  recentCommits: [],
}

/**
 * Reads a local git repo's working-tree state via a caller-provided runner.
 *
 * Each git invocation is guarded independently: the branch must succeed for
 * the function to return populated data at all; ahead/behind, stash, and
 * recent-commits failures degrade to defaults so a repo with no upstream
 * or no stash still produces a useful state.
 *
 * Porcelain status parsing follows the canonical `XY filename` format where
 * X is the index column (staged) and Y is the worktree column (unstaged).
 */
export async function readLocalGitState(cwd: string, run: RunGit): Promise<LocalGitState> {
  try {
    const branch = (await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()

    let ahead = 0
    let behind = 0
    try {
      const ab = (
        await run(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
      ).trim()
      const parts = ab.split(/\s+/)
      ahead = Number(parts[0]) || 0
      behind = Number(parts[1]) || 0
    } catch {
      /* no upstream configured — leave defaults */
    }

    const status = await run(cwd, ['status', '--porcelain'])
    const staged: string[] = []
    const unstaged: string[] = []
    const untracked: string[] = []
    for (const line of status.split('\n')) {
      if (!line) continue
      const prefix = line.slice(0, 2)
      const file = line.slice(3)
      if (prefix === '??') {
        untracked.push(file)
      } else {
        // X column (index) → staged; Y column (worktree) → unstaged.
        // A non-space char in X means there's a staged change;
        // a non-space char in Y means there's a worktree change.
        if (prefix[0] !== ' ' && prefix[0] !== '?') staged.push(file)
        if (prefix[1] !== ' ' && prefix[1] !== '?') unstaged.push(file)
      }
    }

    let stashCount = 0
    try {
      const stashList = (await run(cwd, ['stash', 'list'])).trim()
      stashCount = stashList ? stashList.split('\n').length : 0
    } catch {
      /* no stash — leave 0 */
    }

    let recentCommits: LocalGitState['recentCommits'] = []
    try {
      const log = await run(cwd, ['log', '-5', '--format=%H|%s|%ct'])
      recentCommits = log
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [sha, subject, ct] = l.split('|')
          return { sha: sha.slice(0, 7), subject, at: Number(ct) * 1000 }
        })
    } catch {
      /* no commits yet — leave empty */
    }

    return { branch, ahead, behind, staged, unstaged, untracked, stashCount, recentCommits }
  } catch {
    return EMPTY
  }
}
