import { describe, it, expect, vi } from 'vitest'
import { readLocalGitState } from '../../../src/main/github/session/local-git-reader'

describe('readLocalGitState', () => {
  it('parses branch + ahead/behind + status + stash + recent commits', async () => {
    // Porcelain format: XY<space>filename where X=index column, Y=worktree column.
    //   'M  src/a.ts'  → index modified → staged
    //   '?? new.ts'    → untracked
    //   'A  staged.ts' → index added → staged
    const run = vi.fn()
      .mockResolvedValueOnce('feature/x\n')
      .mockResolvedValueOnce('3\t1\n')
      .mockResolvedValueOnce('M  src/a.ts\n?? new.ts\nA  staged.ts\n M wd.ts\n')
      .mockResolvedValueOnce('stash@{0}: one\nstash@{1}: two\n')
      .mockResolvedValueOnce('abc123abc|fix thing|1700000000\n')
    const state = await readLocalGitState('/tmp', run)
    expect(state.branch).toBe('feature/x')
    expect(state.ahead).toBe(3)
    expect(state.behind).toBe(1)
    expect(state.staged).toEqual(expect.arrayContaining(['src/a.ts', 'staged.ts']))
    expect(state.unstaged).toContain('wd.ts')
    expect(state.untracked).toContain('new.ts')
    expect(state.stashCount).toBe(2)
    expect(state.recentCommits[0].sha).toBe('abc123a')
  })

  it('falls back to empty state when not a repo', async () => {
    const run = vi.fn().mockRejectedValue(new Error('not a git repo'))
    const s = await readLocalGitState('/tmp', run)
    expect(s.branch).toBeUndefined()
    expect(s.ahead).toBe(0)
    expect(s.behind).toBe(0)
    expect(s.staged).toEqual([])
  })

  it('tolerates missing upstream (ahead/behind stay 0)', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce('main\n')
      .mockRejectedValueOnce(new Error('no upstream configured'))
      .mockResolvedValueOnce('') // empty status
      .mockResolvedValueOnce('') // empty stash
      .mockResolvedValueOnce('') // empty log
    const s = await readLocalGitState('/tmp', run)
    expect(s.branch).toBe('main')
    expect(s.ahead).toBe(0)
    expect(s.behind).toBe(0)
  })
})
