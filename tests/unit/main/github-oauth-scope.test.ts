import { describe, it, expect } from 'vitest'
import { buildOAuthScopeString } from '../../../src/main/github/auth/oauth-scope'

describe('buildOAuthScopeString', () => {
  it('unions extras onto the private base, deduped, preserving read:org/workflow/notifications', () => {
    const s = buildOAuthScopeString('private', ['user']).split(' ')
    expect(s).toContain('repo')
    expect(s).toContain('read:org')
    expect(s).toContain('notifications')
    expect(s).toContain('workflow')
    expect(s).toContain('user')
    expect(new Set(s).size).toBe(s.length) // deduped
  })

  it('no extras returns exactly the base', () => {
    expect(buildOAuthScopeString('public', [])).toBe('public_repo read:org notifications workflow')
  })

  it('does not duplicate an extra that already exists in the base', () => {
    const s = buildOAuthScopeString('private', ['repo']).split(' ')
    expect(s.filter((x) => x === 'repo')).toHaveLength(1)
    expect(new Set(s).size).toBe(s.length)
  })

  it('preserves base-then-extras order for the public mode', () => {
    expect(buildOAuthScopeString('public', ['user'])).toBe(
      'public_repo read:org notifications workflow user',
    )
  })

  it('ignores empty-string extras', () => {
    expect(buildOAuthScopeString('public', ['', '  '.trim()])).toBe(
      'public_repo read:org notifications workflow',
    )
  })
})
