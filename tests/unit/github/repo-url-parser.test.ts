import { describe, it, expect } from 'vitest'
import { parseRepoUrl } from '../../../src/main/github/security/repo-url-parser'

describe('parseRepoUrl', () => {
  it('HTTPS', () => {
    expect(parseRepoUrl('https://github.com/nubbymong/claude-command-center')).toBe(
      'nubbymong/claude-command-center',
    )
  })
  it('HTTPS with .git', () => {
    expect(parseRepoUrl('https://github.com/a/b.git')).toBe('a/b')
  })
  it('SSH git@', () => {
    expect(parseRepoUrl('git@github.com:a/b.git')).toBe('a/b')
  })
  it('ssh:// URL', () => {
    expect(parseRepoUrl('ssh://git@github.com/a/b.git')).toBe('a/b')
  })
  it('trims whitespace', () => {
    expect(parseRepoUrl('  https://github.com/a/b\n')).toBe('a/b')
  })
  it('returns null for non-github', () => {
    expect(parseRepoUrl('https://gitlab.com/a/b')).toBeNull()
    expect(parseRepoUrl('git@gitlab.com:a/b.git')).toBeNull()
  })
  it('returns null for plain http:// (DNS-spoof defense)', () => {
    expect(parseRepoUrl('http://github.com/a/b')).toBeNull()
  })
  it('returns null for subdomain-evasion tricks', () => {
    expect(parseRepoUrl('https://github.com.evil.com/a/b')).toBeNull()
    expect(parseRepoUrl('https://evil.github.com/a/b')).toBeNull()
    expect(parseRepoUrl('https://raw.github.com/a/b')).toBeNull()
  })
  it('returns null for userinfo-bypass attempts', () => {
    // https://username@host/... — GitHub URL regex must not accept 'github.com@...'
    expect(parseRepoUrl('https://github.com@evil.com/a/b')).toBeNull()
  })
  it('returns null for invalid slug', () => {
    expect(parseRepoUrl('https://github.com/-bad/x')).toBeNull()
  })
  it('returns null for empty / non-string', () => {
    expect(parseRepoUrl('')).toBeNull()
    expect(parseRepoUrl('   ')).toBeNull()
    // @ts-expect-error runtime guard
    expect(parseRepoUrl(null)).toBeNull()
  })
})
