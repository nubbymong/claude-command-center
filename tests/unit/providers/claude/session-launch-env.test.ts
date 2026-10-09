// A local Claude session's environment (buildClaudeLocalSpawn).
//
// On Windows the session's shell starts Claude Code in the project folder,
// and when Claude Code is a command shim (npm's claude.cmd) that shim starts
// further programs by a bare name (`node`). Those programs come only from the
// folders PATH names, never from the project folder: the session's
// environment carries NoDefaultCurrentDirectoryInExePath, in one spelling.
// A terminal tab is the user's own shell and keeps the environment it is
// given.
//
// The environment, the shell and the elevated helper's lookup come from the
// env the caller passes, never from this process's own: each case below
// passes a synthetic one and sets a different value on this process, and
// every case but the Ask/picker one compares the whole result.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const host = vi.hoisted(() => ({ platform: 'win32' as NodeJS.Platform }))
vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>()
  return { ...real, platform: () => host.platform }
})
// The elevated tab's program lookup answers from the env it is handed: a
// program in the synthetic PATH folder, nothing anywhere else.
vi.mock('../../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../src/main/windows-programs')>()
  return {
    ...real,
    findOnWindowsPath: (names: readonly string[], env: NodeJS.ProcessEnv) =>
      env.Path === 'C:\\SourceTools' && names.includes('gsudo.exe') ? 'C:\\SourceTools\\gsudo.exe' : null,
  }
})

const { buildClaudeLocalSpawn } = await import('../../../../src/main/providers/claude/spawn')

const BASE_OPTS = { sessionId: 'ses-1', cwd: 'C:\\work\\project', cols: 80, rows: 24 }

// What the app itself adds to every local session under BASE_OPTS.
const APP_OWNED = {
  CLAUDE_MULTI_SESSION_ID: 'ses-1',
  CLAUDE_CODE_DISABLE_MOUSE: '1',
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
  CLAUDE_CODE_DISABLE_MOUSE_CLICKS: '1',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
}

const WIN_SOURCE: Readonly<Record<string, string>> = Object.freeze({
  SystemRoot: 'D:\\SourceWindows',
  Path: 'C:\\SourceTools',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  CCC_TEST_ONLY_IN_SOURCE: 'from-source',
})
const SOURCE_SHELL = 'D:\\SourceWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

const LOOKUP_SETTING = 'NoDefaultCurrentDirectoryInExePath'

const saved = { SystemRoot: process.env.SystemRoot, SHELL: process.env.SHELL, marker: process.env.CCC_TEST_ONLY_IN_PROCESS }
function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  host.platform = 'win32'
  // This process's own values differ from the synthetic env's, so a builder
  // that reads them instead is visible in the result.
  process.env.SystemRoot = 'C:\\ProcessWindows'
  process.env.SHELL = '/opt/process/bin/fish'
  process.env.CCC_TEST_ONLY_IN_PROCESS = 'from-process'
})
afterEach(() => {
  restore('SystemRoot', saved.SystemRoot)
  restore('SHELL', saved.SHELL)
  restore('CCC_TEST_ONLY_IN_PROCESS', saved.marker)
})

describe('a Windows Claude session finds the programs its launcher names only in the folders PATH names', () => {
  it('the session environment carries the setting that keeps the project folder out of program lookup', () => {
    const built = buildClaudeLocalSpawn({ ...BASE_OPTS }, WIN_SOURCE)
    expect(built).toEqual({
      cmd: SOURCE_SHELL,
      args: [],
      env: { ...WIN_SOURCE, ...APP_OWNED, [LOOKUP_SETTING]: '1' },
    })
  })

  it('the setting is one spelling: an inherited one in another case is replaced', () => {
    for (const inherited of ['NODEFAULTCURRENTDIRECTORYINEXEPATH', 'nodefaultcurrentdirectoryinexepath']) {
      const source = { ...WIN_SOURCE, [inherited]: '' }
      const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS }, source)
      expect(env, inherited).toEqual({ ...WIN_SOURCE, ...APP_OWNED, [LOOKUP_SETTING]: '1' })
    }
  })

  it('an Ask launch and a picker launch get the same setting', () => {
    for (const extra of [{ askPrompt: 'what does this project do' }, { useResumePicker: true }]) {
      const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, ...extra }, WIN_SOURCE)
      expect(env[LOOKUP_SETTING], JSON.stringify(extra)).toBe('1')
    }
  })
})

describe('a Windows Claude session\'s PATH names only fully qualified folders', () => {
  // Every kind of entry a user's PATH can hold: the current folder, folders
  // named relative to it, a drive-relative and a rooted one, an empty one, a
  // %-entry left unexpanded, a device path, and the fully qualified forms
  // (a drive, a share by either slash, a quoted or padded one).
  const MIXED = [
    '.', 'tools', '.\\bin', '..\\up', 'node_modules\\.bin', 'C:rel', '\\rooted', '', '  ', '%LOCALAPPDATA%\\bin',
    '\\\\?\\C:\\dev', '\\\\.\\pipe\\x', '\\\\server',
    'C:\\Tools', ' D:\\Padded ', '"E:\\Quoted Dir"', '\\\\server\\share\\bin', '//srv/share/git', 'C:/fwd/slash', 'C:\\Tools.',
  ].join(';')
  const KEPT = 'C:\\Tools;D:\\Padded;E:\\Quoted Dir;\\\\server\\share\\bin;//srv/share/git;C:/fwd/slash;C:\\Tools.'

  it('every other entry is left out, the rest kept in order as a PATH walk reads them', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS }, { ...WIN_SOURCE, Path: MIXED })
    expect(env).toEqual({ ...WIN_SOURCE, ...APP_OWNED, Path: KEPT, [LOOKUP_SETTING]: '1' })
  })

  it('every spelling of the variable is filtered, and one left with no such folder is dropped', () => {
    const source: Record<string, string> = { ...WIN_SOURCE, Path: '.;C:\\Tools', PATH: 'tools;\\\\server\\share', path: '.;relative' }
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS }, source)
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH').sort()).toEqual(['PATH', 'Path'])
    expect(env.Path).toBe('C:\\Tools')
    expect(env.PATH).toBe('\\\\server\\share')
    expect(source.path).toBe('.;relative')
  })

  it('entry by entry: kept, trimmed and unquoted, exactly when the shared folder rule takes it', async () => {
    const { windowsPathFolderIsFullyQualified } = await import('../../../../src/main/providers/windows-path-names')
    for (const entry of MIXED.split(';')) {
      let dir = entry.trim()
      if (dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1).trim()
      const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS }, { ...WIN_SOURCE, Path: entry })
      expect(env.Path, JSON.stringify(entry)).toBe(windowsPathFolderIsFullyQualified(dir) ? dir : undefined)
    }
  })

  it('a terminal tab keeps its PATH as given', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true }, { ...WIN_SOURCE, Path: MIXED })
    expect(env.Path).toBe(MIXED)
  })
})

describe('a terminal tab keeps the environment it is given', () => {
  it('a plain tab: the user\'s own lookup rules, the shell from the env passed in', () => {
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true }, WIN_SOURCE)).toEqual({
      cmd: SOURCE_SHELL,
      args: [],
      env: { ...WIN_SOURCE, ...APP_OWNED },
    })
  })

  it('an elevated tab: its helper is found in the env passed in, and the env is the user\'s own', () => {
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true, elevated: true }, WIN_SOURCE)).toEqual({
      cmd: 'C:\\SourceTools\\gsudo.exe',
      args: [SOURCE_SHELL],
      env: { ...WIN_SOURCE, ...APP_OWNED },
    })
  })
})

describe('the environment is built from the one the caller passes', () => {
  it('never from this process\'s own, and the caller\'s env is left as it was', () => {
    const source = { ...WIN_SOURCE }
    const before = { ...source }
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS }, source)
    expect(env.CCC_TEST_ONLY_IN_SOURCE).toBe('from-source')
    expect(env.CCC_TEST_ONLY_IN_PROCESS).toBeUndefined()
    expect(source).toEqual(before)
  })

  it('off Windows: the session shell comes from the env passed in, and nothing is added for program lookup', () => {
    host.platform = 'linux'
    const source = { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin', CCC_TEST_ONLY_IN_SOURCE: 'from-source' }
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS }, source)).toEqual({
      cmd: '/bin/zsh',
      args: ['-l'],
      env: { ...source, ...APP_OWNED },
    })
    const tabSource = { ...source, SHELL: '/opt/homebrew/bin/fish' }
    expect(buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true }, tabSource)).toEqual({
      cmd: '/opt/homebrew/bin/fish',
      args: ['-l'],
      env: { ...tabSource, ...APP_OWNED },
    })
  })
})
