import { describe, it, expect, vi } from 'vitest'
import { detectRepoFromCwd } from '../../../src/main/github/session/repo-detector'

describe('detectRepoFromCwd', () => {
  it('parses git remote output', async () => {
    const run = vi.fn().mockResolvedValue('https://github.com/a/b.git\n')
    expect(await detectRepoFromCwd('/x', run)).toBe('a/b')
  })
  it('returns null on git error', async () => {
    const run = vi.fn().mockRejectedValue(new Error('no git'))
    expect(await detectRepoFromCwd('/x', run)).toBeNull()
  })
  it('returns null for non-github remote', async () => {
    const run = vi.fn().mockResolvedValue('https://gitlab.com/a/b.git\n')
    expect(await detectRepoFromCwd('/x', run)).toBeNull()
  })
  it('parses SSH remote', async () => {
    const run = vi.fn().mockResolvedValue('git@github.com:a/b.git\n')
    expect(await detectRepoFromCwd('/x', run)).toBe('a/b')
  })
})
