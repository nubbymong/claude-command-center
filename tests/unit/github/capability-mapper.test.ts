import { describe, it, expect } from 'vitest'
import { scopesToCapabilities } from '../../../src/main/github/auth/capability-mapper'

describe('scopesToCapabilities', () => {
  it('classic repo → six caps including checks', () => {
    expect(scopesToCapabilities('classic', ['repo']).sort()).toEqual(
      ['actions', 'checks', 'contents', 'issues', 'pulls', 'statuses'].sort(),
    )
  })
  it('classic public_repo equivalent to repo', () => {
    expect(scopesToCapabilities('classic', ['public_repo']).sort()).toEqual(
      ['actions', 'checks', 'contents', 'issues', 'pulls', 'statuses'].sort(),
    )
  })
  it('notifications scope adds notifications capability', () => {
    const caps = scopesToCapabilities('classic', ['repo', 'notifications'])
    expect(caps).toContain('notifications')
  })
  it('fine-grained pull_requests → pulls only', () => {
    expect(scopesToCapabilities('fine-grained', ['pull_requests'])).toEqual(['pulls'])
  })
  it('fine-grained NEVER grants checks even with full set', () => {
    const caps = scopesToCapabilities('fine-grained', [
      'pull_requests',
      'issues',
      'contents',
      'statuses',
      'actions',
    ])
    expect(caps).not.toContain('checks')
    expect(caps).not.toContain('notifications')
  })
  it('oauth treated as classic scopes', () => {
    expect(scopesToCapabilities('oauth', ['public_repo', 'notifications']).sort()).toEqual(
      ['actions', 'checks', 'contents', 'issues', 'notifications', 'pulls', 'statuses'].sort(),
    )
  })
  it('gh-cli uses classic mapping', () => {
    expect(scopesToCapabilities('gh-cli', ['repo']).length).toBe(6)
  })
  it('deduplicates overlapping scopes', () => {
    const caps = scopesToCapabilities('classic', ['repo', 'public_repo'])
    expect(new Set(caps).size).toBe(caps.length)
  })
  it('empty scopes → empty caps', () => {
    expect(scopesToCapabilities('classic', [])).toEqual([])
  })
  it('ignores prototype-chain keys (toString, hasOwnProperty, __proto__)', () => {
    expect(() =>
      scopesToCapabilities('classic', ['toString', 'hasOwnProperty', '__proto__', 'constructor']),
    ).not.toThrow()
    expect(
      scopesToCapabilities('classic', ['toString', 'hasOwnProperty', '__proto__']),
    ).toEqual([])
  })
  it('ignores unknown scopes silently', () => {
    expect(scopesToCapabilities('fine-grained', ['not_a_real_permission'])).toEqual([])
  })
})
