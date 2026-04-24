import { describe, it, expect, vi } from 'vitest'
import {
  parseGhAuthStatus,
  ghAuthToken,
  ghAuthStatus,
} from '../../../src/main/github/auth/gh-cli-delegate'

describe('parseGhAuthStatus', () => {
  it('extracts usernames from multi-account output', () => {
    const out = [
      'github.com',
      '  ✓ Logged in to github.com account nubbymong (keyring)',
      '  - Active account: true',
      '  ✓ Logged in to github.com account personal (keyring)',
    ].join('\n')
    expect(parseGhAuthStatus(out)).toEqual(['nubbymong', 'personal'])
  })
  it('returns [] when not logged in', () => {
    expect(parseGhAuthStatus('You are not logged into any GitHub hosts.')).toEqual([])
  })
  it('ignores non-github.com hosts', () => {
    const out = [
      '  ✓ Logged in to github.com account nubby (keyring)',
      '  ✓ Logged in to ghe.example.com account other (keyring)',
    ].join('\n')
    expect(parseGhAuthStatus(out)).toEqual(['nubby'])
  })
})

describe('ghAuthToken', () => {
  it('runs gh auth token --user X', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: 'gho_xyz\n', stderr: '', code: 0 })
    const tok = await ghAuthToken('nubbymong', run)
    expect(run).toHaveBeenCalledWith(['auth', 'token', '--user', 'nubbymong'])
    expect(tok).toBe('gho_xyz')
  })
  it('throws on non-zero exit', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: '', stderr: 'no such user', code: 1 })
    await expect(ghAuthToken('bad', run)).rejects.toThrow(/no such user|exit/i)
  })
  it('throws on spawn error', async () => {
    const run = vi.fn().mockRejectedValue(new Error('ENOENT'))
    await expect(ghAuthToken('x', run)).rejects.toThrow(/ENOENT/)
  })
})

describe('ghAuthStatus', () => {
  it('parses account list when gh writes to stderr (normal exit=0 path)', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '✓ Logged in to github.com account nubby (keyring)',
      code: 0,
    })
    expect(await ghAuthStatus(run)).toEqual(['nubby'])
  })
  it('tolerates non-zero exit and still parses accounts from stderr', async () => {
    // `gh auth status` can exit non-zero when some hosts are authed and
    // others aren't. ghAuthStatus should still return the github.com accounts.
    const run = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '✓ Logged in to github.com account nubby (keyring)',
      code: 1,
    })
    expect(await ghAuthStatus(run)).toEqual(['nubby'])
  })
  it('returns [] when gh is missing', async () => {
    const run = vi.fn().mockRejectedValue(new Error('spawn gh ENOENT'))
    expect(await ghAuthStatus(run)).toEqual([])
  })
})
