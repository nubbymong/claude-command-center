// The status line command is set up only from folder paths the shell reads as
// nothing but a path. A resources folder path (or the session's status-file
// path) holding `$`, a backtick, `"` or a control character, on Windows `%` or
// `!`, elsewhere a backslash, gets no status line command; every ordinary path,
// spaces included, keeps today's exact command on both platforms. Pure: the
// platform is the test's.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ platform: 'linux' as NodeJS.Platform }))
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const platform = (): NodeJS.Platform => h.platform
  return { ...real, platform, default: { ...real, platform } }
})

const { buildStatuslineSetting } = await import('../../../../src/main/providers/claude/statusline-command')

const ch = (code: number): string => String.fromCharCode(code)

beforeEach(() => { h.platform = 'linux' })

describe('a resources folder path the shell would read as more than a path', () => {
  const refusedEverywhere: Array<[string, string]> = [
    ['a dollar sign', 'res$x'],
    ['a backtick', `res${ch(96)}x`],
    ['a double quote', 'res"x'],
    ['a line feed', `res${ch(10)}x`],
    ['a carriage return', `res${ch(13)}x`],
  ]
  for (const [what, name] of refusedEverywhere) {
    it(`POSIX: ${what} gives no status line command`, () => {
      h.platform = 'linux'
      expect(buildStatuslineSetting(`/home/me/${name}`, 'sid-1', '/home/me/.claude/ccc-status-sid-1.url')).toBeNull()
    })
    it(`Windows: ${what} gives no status line command`, () => {
      h.platform = 'win32'
      expect(buildStatuslineSetting(`C:\\Users\\me\\${name}`, 'sid-1', 'C:\\Users\\me\\.claude\\ccc-status-sid-1.url')).toBeNull()
    })
  }

  it('POSIX: a backslash gives no status line command', () => {
    h.platform = 'linux'
    expect(buildStatuslineSetting('/home/me/res\\x', 'sid-1')).toBeNull()
  })

  for (const [what, name] of [['a percent sign', 'res%x'], ['an exclamation mark', 'res!x']]) {
    it(`Windows: ${what} gives no status line command`, () => {
      h.platform = 'win32'
      expect(buildStatuslineSetting(`C:\\Users\\me\\${name}`, 'sid-1')).toBeNull()
    })
  }

  it('the status-file path is held to the same rule', () => {
    h.platform = 'linux'
    expect(buildStatuslineSetting('/home/me/res', 'sid-1', '/home/$me/.claude/ccc-status-sid-1.url')).toBeNull()
    h.platform = 'win32'
    expect(buildStatuslineSetting('C:\\res', 'sid-1', 'C:\\Users\\%me\\.claude\\ccc-status-sid-1.url')).toBeNull()
  })
})

describe('an ordinary path keeps today\'s exact command', () => {
  it('POSIX, with spaces', () => {
    h.platform = 'linux'
    expect(buildStatuslineSetting('/home/me/My Resources', 'sid-1', '/home/me/.claude/ccc-status-sid-1.url')).toEqual({
      type: 'command',
      command: 'node "/home/me/My Resources/scripts/claude-multi-statusline.js" sid-1 "/home/me/.claude/ccc-status-sid-1.url"',
    })
    expect(buildStatuslineSetting('/home/me/My Resources')).toEqual({
      type: 'command',
      command: 'node "/home/me/My Resources/scripts/claude-multi-statusline.js"',
    })
  })

  it('Windows, with spaces (backslashes doubled as before)', () => {
    h.platform = 'win32'
    expect(buildStatuslineSetting('C:\\Users\\me\\My Resources', 'sid-1', 'C:\\Users\\me\\.claude\\ccc-status-sid-1.url')).toEqual({
      type: 'command',
      command: 'node "C:\\\\Users\\\\me\\\\My Resources\\\\scripts\\\\claude-multi-statusline.js" sid-1 "C:\\\\Users\\\\me\\\\.claude\\\\ccc-status-sid-1.url"',
    })
  })
})
