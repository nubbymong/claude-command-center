// The resume picker reads PATH's folders by the app's own rule.
//
// scripts/resume-picker.js is a plain Node script and cannot import the app's
// PATH walk (src/main/windows-programs.ts), so it carries a copy of the rule.
// This test holds the copy to the app's answer: for the same PATH, both look
// for a program at the same files, in the same order. Pure: the file check
// records each file it is asked about and answers "not there"; nothing starts.
import { describe, it, expect, vi } from 'vitest'
import { findOnWindowsPath, windowsPathFolders } from '../../../src/main/windows-programs'

type Env = Record<string, string | undefined>
// eslint-disable-next-line @typescript-eslint/no-require-imports
const picker = require('../../../scripts/resume-picker.js') as {
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
  expect(findOnWindowsPath(['claude.exe', 'claude.cmd'], env as NodeJS.ProcessEnv, r.isFile, 'name')).toBeNull()
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
    expect(files.length).toBe(2 * windowsPathFolders(env as NodeJS.ProcessEnv).length)
    expect(files).toContain('C:\\Quoted Dir\\claude.exe')
    expect(files).toContain('\\\\srv\\share\\bin\\claude.cmd')
    expect(files.indexOf('C:\\Quoted Dir\\claude.cmd')).toBeGreaterThan(files.indexOf('z:\\lower\\claude.exe'))
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
    expect(findOnWindowsPath(['claude.exe', 'claude.cmd'], ENV as NodeJS.ProcessEnv, a.isFile, 'name')).toBeNull()
    expect(p.asked).toEqual(a.asked)
    expect(p.asked).toEqual(['\\\\down\\share\\claude.exe', 'C:\\a\\claude.exe', '\\\\down\\share\\sub\\claude.exe', 'C:\\a\\claude.cmd'])
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
})
