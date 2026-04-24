import { describe, it, expect, vi } from 'vitest'
import {
  detectRepoFromSshSession,
  posixShellEscape,
} from '../../../src/main/github/session/ssh-repo-detector'

describe('posixShellEscape', () => {
  it('wraps plain paths in single quotes', () => {
    expect(posixShellEscape('/home/x/repo')).toBe(`'/home/x/repo'`)
  })
  it('escapes embedded single quotes', () => {
    expect(posixShellEscape(`it's`)).toBe(`'it'\\''s'`)
  })
  it('neutralizes command substitution', () => {
    // Single quotes disable $() expansion — the payload becomes a literal
    // path string to git, never a shell command.
    expect(posixShellEscape(`$(rm -rf ~)`)).toBe(`'$(rm -rf ~)'`)
  })
})

describe('detectRepoFromSshSession', () => {
  it('parses URL from between sentinels', async () => {
    const send = vi.fn().mockResolvedValue(
      [
        'some terminal noise',
        '__CC_GIT_START__',
        'https://github.com/a/b.git',
        '__CC_GIT_END__',
        'more noise',
      ].join('\n'),
    )
    expect(await detectRepoFromSshSession('sid', '/home/x', send)).toBe('a/b')
  })

  it('returns null when sentinel missing', async () => {
    const send = vi.fn().mockResolvedValue('no sentinels here')
    expect(await detectRepoFromSshSession('sid', '/x', send)).toBeNull()
  })

  it('returns null on sendOneShot rejection', async () => {
    const send = vi.fn().mockRejectedValue(new Error('timeout'))
    expect(await detectRepoFromSshSession('sid', '/x', send)).toBeNull()
  })

  it('returns null when between-sentinels text is not a github url', async () => {
    const send = vi.fn().mockResolvedValue(
      ['__CC_GIT_START__', 'https://gitlab.com/a/b.git', '__CC_GIT_END__'].join('\n'),
    )
    expect(await detectRepoFromSshSession('sid', '/x', send)).toBeNull()
  })

  it('hands sendOneShot a single escaped interpolation of cwd', async () => {
    const send = vi.fn().mockResolvedValue('__CC_GIT_START__\n\n__CC_GIT_END__')
    await detectRepoFromSshSession('sid', `/home/x; rm -rf ~`, send)
    const cmd = send.mock.calls[0][1] as string
    // cwd must be single-quote wrapped so the rogue semicolon can't escape
    // the git argument list and execute as a separate shell command.
    expect(cmd).toContain(`'/home/x; rm -rf ~'`)
    expect(cmd).toMatch(/^echo __CC_GIT_START__; git -C '[^']*' remote get-url origin/)
  })
})
