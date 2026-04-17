import { describe, it, expect } from 'vitest'
import { validateSlug, parseSlug } from '../../../src/main/github/security/slug-validator'

describe('validateSlug', () => {
  it('accepts valid slugs', () => {
    expect(validateSlug('nubbymong/claude-command-center')).toBe(true)
    expect(validateSlug('123/repo')).toBe(true)
    expect(validateSlug('owner/my.repo')).toBe(true)
  })
  it('rejects bare . and .. as repo names', () => {
    expect(validateSlug('owner/.')).toBe(false)
    expect(validateSlug('owner/..')).toBe(false)
  })
  it('rejects missing or extra slashes', () => {
    expect(validateSlug('no-slash')).toBe(false)
    expect(validateSlug('a/b/c')).toBe(false)
  })
  it('rejects empty parts', () => {
    expect(validateSlug('/repo')).toBe(false)
    expect(validateSlug('owner/')).toBe(false)
    expect(validateSlug('')).toBe(false)
  })
  it('rejects consecutive dashes / leading / trailing dashes in owner', () => {
    expect(validateSlug('a--b/r')).toBe(false)
    expect(validateSlug('-owner/r')).toBe(false)
    expect(validateSlug('owner-/r')).toBe(false)
  })
  it('rejects owner longer than 39 chars', () => {
    expect(validateSlug('a'.repeat(40) + '/r')).toBe(false)
  })
  it('rejects non-string inputs', () => {
    expect(validateSlug(null)).toBe(false)
    expect(validateSlug(123)).toBe(false)
    expect(validateSlug(undefined)).toBe(false)
  })
})

describe('parseSlug', () => {
  it('returns owner/repo on valid', () => {
    expect(parseSlug('nubbymong/x')).toEqual({ owner: 'nubbymong', repo: 'x' })
  })
  it('returns null on invalid', () => {
    expect(parseSlug('invalid')).toBeNull()
  })
})
