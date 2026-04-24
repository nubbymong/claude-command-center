import { describe, it, expect } from 'vitest'
import { parseRepoUrlClient } from '../../../src/renderer/components/session/parseRepoUrlClient'

describe('parseRepoUrlClient', () => {
  it('parses HTTPS', () => {
    expect(parseRepoUrlClient('https://github.com/a/b')).toBe('a/b')
  })
  it('parses HTTPS with .git suffix', () => {
    expect(parseRepoUrlClient('https://github.com/a/b.git')).toBe('a/b')
  })
  it('parses SSH', () => {
    expect(parseRepoUrlClient('git@github.com:a/b.git')).toBe('a/b')
  })
  it('parses SSH URL form', () => {
    expect(parseRepoUrlClient('ssh://git@github.com/a/b.git')).toBe('a/b')
  })
  it('rejects plain http (DNS-spoof risk on local networks)', () => {
    expect(parseRepoUrlClient('http://github.com/a/b')).toBeUndefined()
  })
  it('rejects repo names starting with a dot', () => {
    expect(parseRepoUrlClient('https://github.com/a/.hidden')).toBeUndefined()
  })
  it('rejects invalid owner (leading hyphen)', () => {
    expect(parseRepoUrlClient('https://github.com/-bad/b')).toBeUndefined()
  })
  it('rejects . and .. as repo names', () => {
    expect(parseRepoUrlClient('https://github.com/a/.')).toBeUndefined()
    expect(parseRepoUrlClient('https://github.com/a/..')).toBeUndefined()
  })
  it('returns undefined on non-github', () => {
    expect(parseRepoUrlClient('https://gitlab.com/a/b')).toBeUndefined()
  })
  it('returns undefined on empty', () => {
    expect(parseRepoUrlClient('')).toBeUndefined()
  })
  it('trims whitespace', () => {
    expect(parseRepoUrlClient('  https://github.com/a/b  ')).toBe('a/b')
  })
})
