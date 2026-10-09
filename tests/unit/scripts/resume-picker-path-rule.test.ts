// The resume picker reads PATH's folders by the app's own rule.
//
// scripts/resume-picker.js is a plain Node script and cannot import the app's
// PATH walk (src/main/windows-programs.ts), so it carries a copy of the rule.
// This test holds the copy to the app's answer: for the same PATH, both look
// for a program at the same files, in the same order, and for Claude Code by
// the app's own names (claude-cli-probe.ts CLAUDE_WINDOWS_NAMES: claude.exe,
// then claude.cmd, then claude.bat), so the one the app's check finds is the
// one the picker starts. Pure: the file check records each file it is asked
// about and answers from a list written here; nothing starts.
import { describe, it, expect, vi } from 'vitest'
import { findOnWindowsPath, windowsPathFolders } from '../../../src/main/windows-programs'
import { CLAUDE_WINDOWS_NAMES } from '../../../src/main/claude-cli-probe'

type Env = Record<string, string | undefined>
// eslint-disable-next-line @typescript-eslint/no-require-imports
const picker = require('../../../scripts/resume-picker.js') as {
  CLAUDE_WINDOWS_NAMES: readonly string[]
  resolveClaudeCmd: (platform?: string, env?: Env, isFile?: (p: string) => boolean) => string | null
  listWorktrees: (
    cwd: string,
    platform?: string,
    deps?: { spawn?: (file: string, args: string[], opts: Record<string, unknown>) => { status: number | null; stdout?: string }; env?: Env; isFile?: (p: string) => boolean },
  ) => unknown
}

const recorder = (): { asked: string[]; isFile: (p: string) => boolean } => {
  const asked: string[] = []
  return { asked, isFile: (p: string) => { asked.push(p); return false } }
}
/** Every file the picker checks for Claude Code, in order. */
function pickerClaudeFiles(env: Env): string[] {
  const r = recorder()
  expect(picker.resolveClaudeCmd('win32', env, r.isFile)).toBeNull()
  return r.asked
}
/** Every file the app's walk checks for the same names, in the same order. */
function appClaudeFiles(env: Env): string[] {
  const r = recorder()
  expect(findOnWindowsPath(CLAUDE_WINDOWS_NAMES, env as NodeJS.ProcessEnv, r.isFile, 'name')).toBeNull()
  return r.asked
}
function pickerGitFiles(env: Env): string[] {
  const r = recorder()
  picker.listWorktrees('C:\\proj', 'win32', { env, isFile: r.isFile, spawn: () => { throw new Error('nothing may start here') } })
  return r.asked
}
function appGitFiles(env: Env): string[] {
  const r = recorder()
  expect(findOnWindowsPath(['git.exe'], env as NodeJS.ProcessEnv, r.isFile)).toBeNull()
  return r.asked
}

// Folders a lookup reads, and entries it must pass over: relative, the current
// folder, unexpanded variables, quoted and padded entries, trailing dots and
// spaces, either slash, shares (with and without a dot), a lone server, the
// device namespaces, drive-relative and rooted-without-a-drive names.
const ENTRIES = [
  '.', '..', 'rel\\bin', 'bin', '%X%\\cmd', 'C:\\%X%', 'C:\\a%b',
  '"C:\\Quoted Dir"', '  C:\\padded  ', ' "C:\\padded quoted" ', '"C:\\half', 'C:\\x"y', '""',
  'C:\\tools.\\bin.', 'C:\\name..\\x', 'C:\\sp \\x', 'C:\\dot.', 'C:\\', 'C:/fwd/slash', 'C:\\a\\..\\b', 'C:\\trailing\\',
  '\\\\srv\\share\\bin', '//srv/share', '\\\\srv.x\\share', '\\\\srv\\share.\\x.', '\\\\srv', '\\\\srv\\', '\\\\.srv\\share',
  '\\\\?\\C:\\Git', '\\\\.\\C:\\Git', '//?/C:/Git', 'C:x', 'C:', '\\Git', '/Git', 'D:\\x', 'z:/lower',
]

describe('the picker reads PATH\'s folders by the app\'s own rule', () => {
  it('looks for Claude Code by the app\'s own names, in the app\'s order: claude.exe, claude.cmd, claude.bat', () => {
    expect([...picker.CLAUDE_WINDOWS_NAMES]).toEqual([...CLAUDE_WINDOWS_NAMES])
    expect([...picker.CLAUDE_WINDOWS_NAMES]).toEqual(['claude.exe', 'claude.cmd', 'claude.bat'])
  })

  it('each entry: the picker checks the files the app\'s walk checks', () => {
    for (const entry of ENTRIES) {
      expect(pickerClaudeFiles({ PATH: entry }), JSON.stringify(entry)).toEqual(appClaudeFiles({ PATH: entry }))
      expect(pickerGitFiles({ PATH: entry }), JSON.stringify(entry)).toEqual(appGitFiles({ PATH: entry }))
    }
  })

  it('a whole PATH: the same files, in the same order', () => {
    const env = { Path: ENTRIES.join(';') }
    const files = pickerClaudeFiles(env)
    expect(files).toEqual(appClaudeFiles(env))
    expect(pickerGitFiles(env)).toEqual(appGitFiles(env))
    // Not empty by accident: the folders the rule keeps are all asked about.
    expect(files.length).toBe(3 * windowsPathFolders(env as NodeJS.ProcessEnv).length)
    expect(files).toContain('C:\\Quoted Dir\\claude.exe')
    expect(files).toContain('\\\\srv\\share\\bin\\claude.cmd')
    expect(files).toContain('\\\\srv\\share\\bin\\claude.bat')
    expect(files.indexOf('C:\\Quoted Dir\\claude.cmd')).toBeGreaterThan(files.indexOf('z:\\lower\\claude.exe'))
    expect(files.indexOf('C:\\Quoted Dir\\claude.bat')).toBeGreaterThan(files.indexOf('z:\\lower\\claude.cmd'))
  })

  it('PATH is read under any spelling of its name, the exact one first', () => {
    for (const env of [{ Path: 'C:\\a' }, { path: 'C:\\a' }, { PATH: 'C:\\a', Path: 'C:\\b' }, { Path: 'C:\\b', PATH: 'C:\\a' }, { PATH: undefined, Path: 'C:\\b' }, {}] as Env[]) {
      expect(pickerClaudeFiles(env), JSON.stringify(env)).toEqual(appClaudeFiles(env))
      expect(pickerGitFiles(env), JSON.stringify(env)).toEqual(appGitFiles(env))
    }
  })
})

// A folder that does not answer: its check throws. Both walks then pass that
// folder over for every later name; a file that is simply not there is no such
// failure, so its folder is still asked for the next name.
describe('a PATH folder that does not answer is asked once, as the app\'s walk asks it', () => {
  const ENV = { PATH: '\\\\down\\share;C:\\a;\\\\down\\share\\sub' }
  const throwing = (): { asked: string[]; isFile: (p: string) => boolean } => {
    const asked: string[] = []
    return { asked, isFile: (p: string) => { asked.push(p); if (p.startsWith('\\\\down\\')) throw new Error('does not answer'); return false } }
  }

  it('the picker checks the files the app\'s walk checks, a folder that throws once', () => {
    const p = throwing()
    expect(picker.resolveClaudeCmd('win32', ENV, p.isFile)).toBeNull()
    const a = throwing()
    expect(findOnWindowsPath(CLAUDE_WINDOWS_NAMES, ENV as NodeJS.ProcessEnv, a.isFile, 'name')).toBeNull()
    expect(p.asked).toEqual(a.asked)
    expect(p.asked).toEqual(['\\\\down\\share\\claude.exe', 'C:\\a\\claude.exe', '\\\\down\\share\\sub\\claude.exe', 'C:\\a\\claude.cmd', 'C:\\a\\claude.bat'])
  })

  it('the picker\'s own check: a file not there leaves its folder asked for the next name', () => {
    // The file checks are answered here: nothing on disk is read.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs = require('fs') as typeof import('fs')
    const asked: string[] = []
    const stat = vi.spyOn(nodeFs, 'statSync').mockImplementation(((p: string) => {
      asked.push(p)
      if (p.startsWith('\\\\down\\')) throw Object.assign(new Error('does not answer'), { code: 'EIO' })
      if (p === 'C:\\a\\claude.cmd') return { isFile: () => true }
      throw Object.assign(new Error('not there'), { code: p.endsWith('sub\\claude.exe') ? 'ENOTDIR' : 'ENOENT' })
    }) as never)
    try {
      expect(picker.resolveClaudeCmd('win32', { PATH: '\\\\down\\share;C:\\b\\sub;C:\\a' })).toBe('C:\\a\\claude.cmd')
      expect(asked).toEqual(['\\\\down\\share\\claude.exe', 'C:\\b\\sub\\claude.exe', 'C:\\a\\claude.exe', 'C:\\b\\sub\\claude.cmd', 'C:\\a\\claude.cmd'])
    } finally {
      stat.mockRestore()
    }
  })

  it('the picker\'s own check finds a claude.bat once no folder holds claude.exe or claude.cmd', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs = require('fs') as typeof import('fs')
    const asked: string[] = []
    const stat = vi.spyOn(nodeFs, 'statSync').mockImplementation(((p: string) => {
      asked.push(p)
      if (p.startsWith('\\\\down\\')) throw Object.assign(new Error('does not answer'), { code: 'EIO' })
      if (p === 'C:\\a\\claude.bat') return { isFile: () => true }
      throw Object.assign(new Error('not there'), { code: 'ENOENT' })
    }) as never)
    try {
      expect(picker.resolveClaudeCmd('win32', { PATH: '\\\\down\\share;C:\\b\\sub;C:\\a' })).toBe('C:\\a\\claude.bat')
      expect(asked).toEqual([
        '\\\\down\\share\\claude.exe', 'C:\\b\\sub\\claude.exe', 'C:\\a\\claude.exe',
        'C:\\b\\sub\\claude.cmd', 'C:\\a\\claude.cmd',
        'C:\\b\\sub\\claude.bat', 'C:\\a\\claude.bat',
      ])
    } finally {
      stat.mockRestore()
    }
  })
})

// The answer itself: for the same PATH and the same files, the picker starts
// the Claude Code the app's check finds (spawn.ts findClaudeOnWindows walks
// CLAUDE_WINDOWS_NAMES in name order with findOnWindowsPath).
describe('the picker finds the Claude Code the app finds', () => {
  const PATH = '.;rel\\bin;C:\\bat;C:\\npm;C:\\native'
  const layouts: Array<{ files: string[]; expected: string | null }> = [
    // A claude.bat alone, in a folder PATH names: found.
    { files: ['C:\\bat\\claude.bat'], expected: 'C:\\bat\\claude.bat' },
    // claude.cmd in any folder before claude.bat in an earlier one.
    { files: ['C:\\bat\\claude.bat', 'C:\\npm\\claude.cmd'], expected: 'C:\\npm\\claude.cmd' },
    // The native claude.exe in any folder before both.
    { files: ['C:\\bat\\claude.bat', 'C:\\npm\\claude.cmd', 'C:\\native\\claude.exe'], expected: 'C:\\native\\claude.exe' },
    { files: ['C:\\bat\\claude.bat', 'C:\\native\\claude.exe'], expected: 'C:\\native\\claude.exe' },
    // A claude.bat in the current folder or a relative one is never read.
    { files: ['claude.bat', '.\\claude.bat', 'rel\\bin\\claude.bat'], expected: null },
    { files: ['rel\\bin\\claude.bat', 'C:\\npm\\claude.bat'], expected: 'C:\\npm\\claude.bat' },
    { files: [], expected: null },
  ]

  it('each layout: the same full path, or nothing for both', () => {
    for (const { files, expected } of layouts) {
      const isFile = (p: string) => files.includes(p)
      const app = findOnWindowsPath(CLAUDE_WINDOWS_NAMES, { PATH } as NodeJS.ProcessEnv, isFile, 'name')
      expect(app, JSON.stringify(files)).toBe(expected)
      expect(picker.resolveClaudeCmd('win32', { PATH }, isFile), JSON.stringify(files)).toBe(app)
    }
  })
})
