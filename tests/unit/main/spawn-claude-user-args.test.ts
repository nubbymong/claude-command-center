// A Claude Code session's extra CLI arguments on its launch line
// (buildClaudeLaunchCommand, claudeUserArgsOnLine). They come after every
// option of the app's own, on every route. On Windows PowerShell reads the
// line, and each word is single-quoted, so PowerShell hands Claude Code each
// word exactly as written. Elsewhere a POSIX shell reads the words as they
// are. Pure; nothing is started (the PowerShell run of the same lines is
// spawn-claude-user-args-powershell.test.ts, CI and VM only).
import { describe, it, expect } from 'vitest'
import { buildClaudeLaunchCommand, claudeUserArgsOnLine } from '../../../src/main/spawn-claude-command'

const UUID = '11111111-2222-3333-4444-555555555555'
const APP = " --settings 'C:\\res\\s.json' --mcp-config 'C:\\res\\m.json'"
const base = {
  cwd: 'C:\\work\\demo',
  claudeBin: 'C:\\Tools\\claude.exe',
  extraFlags: APP,
  agentsFlag: '',
  useResumePicker: false,
  pickerScript: null as string | null,
}

describe('claudeUserArgsOnLine', () => {
  it('Windows: each word single-quoted, one space before each', () => {
    expect(claudeUserArgsOnLine('--add-dir=C:\\x  --allowedTools=Bash,Edit -d', true))
      .toBe(" '--add-dir=C:\\x' '--allowedTools=Bash,Edit' '-d'")
  })
  it('elsewhere: the words as they are', () => {
    expect(claudeUserArgsOnLine('--add-dir=/srv  --allowedTools=Bash,Edit -d', false)).toBe(' --add-dir=/srv --allowedTools=Bash,Edit -d')
  })
  it('none, blank or absent: nothing', () => {
    for (const v of [undefined, '', '   ']) {
      expect(claudeUserArgsOnLine(v, true)).toBe('')
      expect(claudeUserArgsOnLine(v, false)).toBe('')
    }
  })
  it('Windows: a single quote of any kind PowerShell reads stays inside its word', () => {
    // Never let through by the rule's characters; quoted all the same.
    expect(claudeUserArgsOnLine("a'b a\u2019b", true)).toBe(" 'a''b' 'a\u2019\u2019b'")
  })
})

describe('the launch line places the user\'s words after the app\'s options, quoted word by word on Windows', () => {
  const words = ',--resume 1kb,x --add-dir=C:\\x'
  const quoted = " ',--resume' '1kb,x' '--add-dir=C:\\x'"
  const routes: Array<[string, Partial<typeof base> & { resumeUuid?: string }]> = [
    ['a fresh launch', {}],
    ['an exact resume', { resumeUuid: UUID }],
    ['the resume picker', { useResumePicker: true, pickerScript: 'C:\\res\\resume-picker.js' }],
    ['the picker\'s fallback (no picker script)', { useResumePicker: true, pickerScript: null }],
  ]
  for (const [name, extra] of routes) {
    it(`win32, ${name}`, () => {
      const line = buildClaudeLaunchCommand({ ...base, ...extra, platform: 'win32', userArgs: words })
      expect(line.endsWith(`${APP}${quoted}; exit`), line).toBe(true)
    })
    it(`posix, ${name}`, () => {
      const line = buildClaudeLaunchCommand({ ...base, ...extra, platform: 'posix', userArgs: '--add-dir=/srv -d' })
      expect(line.endsWith(`${APP} --add-dir=/srv -d; exit`), line).toBe(true)
    })
  }
  it('without user words the line is the app\'s alone', () => {
    for (const platform of ['win32', 'posix']) {
      const line = buildClaudeLaunchCommand({ ...base, platform })
      expect(line.endsWith(`${APP}; exit`), line).toBe(true)
    }
  })
  it('an opening prompt stays last', () => {
    const line = buildClaudeLaunchCommand({ ...base, platform: 'win32', userArgs: '--verbose', askPrompt: true })
    expect(line).toMatch(/ '--verbose' -- \S+; exit$/)
  })
})
