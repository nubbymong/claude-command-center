// windows-programs.ts: helper tools start from the system folder, and programs
// are found only in PATH's absolute folders, by their full path. Pure: every
// file test is injected; no process is started and no real file is read.
import { describe, it, expect } from 'vitest'
import {
  systemTool,
  findOnWindowsPath,
  findOnWindowsPathAsync,
  windowsPathFolders,
  windowsEnvValue,
  windowsBatchFileCommand,
  windowsStartCommand,
  withoutCurrentFolderLookup,
  withFullyQualifiedProgramLookup,
} from '../../../src/main/windows-programs'
import { windowsPathFolderIsFullyQualified } from '../../../src/main/providers/windows-path-names'

/** A file test that answers from a set, recording every path it was asked. */
function files(present: string[], unreachable: string[] = []) {
  const asked: string[] = []
  const set = new Set(present.map((p) => p.toLowerCase()))
  const dead = unreachable.map((d) => d.toLowerCase())
  const stat = (p: string): boolean => {
    asked.push(p)
    if (dead.some((d) => p.toLowerCase().startsWith(d + '\\'))) throw Object.assign(new Error('unreachable'), { code: 'EACCES' })
    return set.has(p.toLowerCase())
  }
  const statAsync = async (p: string): Promise<boolean> => stat(p)
  return { asked, stat, statAsync }
}

describe('helper tools start from the system folder', () => {
  it('names the tool below <SystemRoot>\\System32 by its full path', () => {
    expect(systemTool('taskkill.exe', { SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(systemTool('WindowsPowerShell\\v1.0\\powershell.exe', { SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(systemTool('reg.exe', { SystemRoot: 'C:/Windows/' })).toBe('C:\\Windows\\System32\\reg.exe')
  })

  it('reads SystemRoot in any case, as Windows does', () => {
    expect(systemTool('cmd.exe', { SYSTEMROOT: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(systemTool('cmd.exe', { systemroot: 'E:\\W' })).toBe('E:\\W\\System32\\cmd.exe')
  })

  it('throws when SystemRoot is not a plain drive-absolute folder', () => {
    for (const root of [
      undefined, '', ' ', 'Windows', '.\\Windows', '\\Windows', 'C:Windows',
      '\\\\server\\share\\Windows', '//server/share/Windows', '\\\\?\\C:\\Windows', '\\\\.\\C:\\Windows',
      'C:\\Windows\\..\\Temp', 'C:\\.\\Windows', 'C:\\%WINDIR%', 'C:\\Win"dows', 'C:\\Windows.', 'C:\\Windows \\x',
      'C:\\Win\u0001dows', 'C:\\a\\\\b',
    ]) {
      const env = root === undefined ? {} : { SystemRoot: root }
      expect(() => systemTool('taskkill.exe', env), JSON.stringify(root)).toThrow(/SystemRoot/)
    }
  })

  it('throws for a tool path that is not a plain path below the system folder', () => {
    for (const rel of ['', 'C:\\x.exe', '\\x.exe', '..\\x.exe', 'a\\..\\x.exe', '.\\x.exe', 'x%y.exe', 'x.exe.', 'x:y.exe', 'a\\\\x.exe']) {
      expect(() => systemTool(rel, { SystemRoot: 'C:\\Windows' }), rel).toThrow(/plain path/)
    }
  })
})

describe('programs are found only in PATH\'s absolute folders', () => {
  const PATH = ['.', 'rel\\bin', '..\\up', '%LOCALAPPDATA%\\x', 'C:\\%PF%\\bin', '\\rooted', 'C:relative', '', '  ', '"C:\\Quoted Dir"', 'C:\\A', 'D:/B', '\\\\srv\\share\\tools'].join(';')

  it('reads only fully qualified folders, in PATH order, quotes dropped', () => {
    expect(windowsPathFolders({ PATH })).toEqual(['C:\\Quoted Dir', 'C:\\A', 'D:/B', '\\\\srv\\share\\tools'])
  })

  it('never asks a relative, rooted, drive-relative or %-entry for a file', () => {
    const f = files([])
    expect(findOnWindowsPath(['git.exe'], { PATH }, f.stat)).toBeNull()
    expect(f.asked).toEqual(['C:\\Quoted Dir\\git.exe', 'C:\\A\\git.exe', 'D:\\B\\git.exe', '\\\\srv\\share\\tools\\git.exe'])
  })

  it('answers the full path of the first folder in PATH order that holds the file', () => {
    const f = files(['C:\\A\\gh.exe', 'D:\\B\\gh.exe'])
    expect(findOnWindowsPath(['gh.exe'], { PATH: 'C:\\A;D:\\B' }, f.stat)).toBe('C:\\A\\gh.exe')
    expect(findOnWindowsPath(['gh.exe'], { PATH: 'D:\\B;C:\\A' }, f.stat)).toBe('D:\\B\\gh.exe')
  })

  it('a file in a relative entry is never found', () => {
    const f = files(['rel\\bin\\gh.exe', '.\\gh.exe', 'gh.exe'])
    expect(findOnWindowsPath(['gh.exe'], { PATH: '.;rel\\bin' }, f.stat)).toBeNull()
    expect(f.asked).toEqual([])
  })

  it('folder order: in each folder the names in the order given', () => {
    const f = files(['C:\\A\\npm.cmd', 'D:\\B\\npm.exe'])
    expect(findOnWindowsPath(['npm.exe', 'npm.cmd'], { PATH: 'C:\\A;D:\\B' }, f.stat)).toBe('C:\\A\\npm.cmd')
    const g = files(['C:\\A\\npm.cmd', 'C:\\A\\npm.exe'])
    expect(findOnWindowsPath(['npm.exe', 'npm.cmd'], { PATH: 'C:\\A' }, g.stat)).toBe('C:\\A\\npm.exe')
  })

  it('name order: the first name in every folder before the next name', () => {
    const f = files(['C:\\A\\claude.cmd', 'D:\\B\\claude.exe'])
    expect(findOnWindowsPath(['claude.exe', 'claude.cmd'], { PATH: 'C:\\A;D:\\B' }, f.stat, 'name')).toBe('D:\\B\\claude.exe')
    expect(f.asked).toEqual(['C:\\A\\claude.exe', 'D:\\B\\claude.exe'])
  })

  it('an unreachable folder is not asked again for the next name', () => {
    const f = files(['D:\\B\\claude.cmd'], ['\\\\dead\\share'])
    expect(findOnWindowsPath(['claude.exe', 'claude.cmd'], { PATH: '\\\\dead\\share;D:\\B' }, f.stat, 'name')).toBe('D:\\B\\claude.cmd')
    expect(f.asked.filter((p) => p.startsWith('\\\\dead'))).toEqual(['\\\\dead\\share\\claude.exe'])
    const g = files(['D:\\B\\x.cmd'], ['C:\\dead'])
    expect(findOnWindowsPath(['x.exe', 'x.cmd'], { PATH: 'C:\\dead;D:\\B' }, g.stat)).toBe('D:\\B\\x.cmd')
    expect(g.asked.filter((p) => p.startsWith('C:\\dead'))).toEqual(['C:\\dead\\x.exe'])
  })

  it('reads PATH in any case and names a folder as Windows runs from it', () => {
    const f = files(['C:\\tools\\gh.exe'])
    expect(findOnWindowsPath(['gh.exe'], { Path: 'C:\\tools.' }, f.stat)).toBe('C:\\tools\\gh.exe')
    expect(windowsEnvValue({ path: 'x' }, 'PATH')).toBe('x')
    expect(windowsEnvValue({ PATH: 'exact', Path: 'other' }, 'PATH')).toBe('exact')
  })

  it('no PATH, or nothing found: null, never a bare name', () => {
    expect(findOnWindowsPath(['gh.exe'], {}, files([]).stat)).toBeNull()
    expect(findOnWindowsPath(['gh.exe'], { PATH: 'C:\\A' }, files([]).stat)).toBeNull()
  })

  it('throws for a name that is not a plain file name', () => {
    for (const bad of [[], ['a\\gh.exe'], ['..'], ['C:gh.exe'], ['gh.exe.'], ['%x%.exe']]) {
      expect(() => findOnWindowsPath(bad as string[], { PATH: 'C:\\A' }, files([]).stat), JSON.stringify(bad)).toThrow()
    }
  })

  it('the async walk keeps every rule: absolute folders, both orders, the unreachable memo', async () => {
    const f = files(['C:\\A\\claude.cmd', 'D:\\B\\claude.exe'], ['\\\\dead\\share'])
    const env = { PATH: `.;rel;%X%;C:\\%Y%;\\\\dead\\share;C:\\A;D:\\B` }
    expect(await findOnWindowsPathAsync(['claude.exe', 'claude.cmd'], env, f.statAsync, 'name')).toBe('D:\\B\\claude.exe')
    expect(f.asked.every((p) => /^([A-Za-z]:\\|\\\\)/.test(p) && !p.includes('%'))).toBe(true)
    expect(await findOnWindowsPathAsync(['claude.exe', 'claude.cmd'], env, f.statAsync)).toBe('C:\\A\\claude.cmd')
    expect(await findOnWindowsPathAsync(['x.exe'], { PATH: '.;rel' }, f.statAsync)).toBeNull()
    const g = files(['D:\\B\\claude.cmd'], ['\\\\dead\\share'])
    expect(await findOnWindowsPathAsync(['claude.exe', 'claude.cmd'], env, g.statAsync, 'name')).toBe('D:\\B\\claude.cmd')
    expect(g.asked.filter((p) => p.startsWith('\\\\dead'))).toEqual(['\\\\dead\\share\\claude.exe'])
  })
})

describe('a batch file runs through the system cmd.exe, never through a shell option', () => {
  const env = { SystemRoot: 'C:\\Windows' }

  it('quotes the batch file and passes plain arguments, verbatim', () => {
    expect(windowsBatchFileCommand('C:\\Program Files\\nodejs\\npm.cmd', ['install', '--prefix', 'C:/v/2.1.3', '@scope/pkg@2.1.3'], env)).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" install --prefix C:/v/2.1.3 @scope/pkg@2.1.3"'],
      windowsVerbatimArguments: true,
    })
  })

  it('refuses a path cmd.exe or the batch file would re-read', () => {
    for (const p of ['C:\\a%b%\\x.cmd', 'C:\\a&b\\x.cmd', 'C:\\a^b\\x.cmd', 'C:\\a"b\\x.cmd', 'C:\\a\nb\\x.cmd']) {
      expect(windowsBatchFileCommand(p, [], env), p).toHaveProperty('refused')
    }
  })

  it('refuses a relative path, a non-batch file and an argument that is not plain', () => {
    expect(windowsBatchFileCommand('x.cmd', [], env)).toHaveProperty('refused')
    expect(windowsBatchFileCommand('.\\x.cmd', [], env)).toHaveProperty('refused')
    expect(windowsBatchFileCommand('C:\\x.exe', [], env)).toHaveProperty('refused')
    for (const a of ['a b', 'a&b', '%x%', 'a"b', 'a^b', 'a|b', 'a<b', 'a>b', '(a)', '!a!', '', 'a\tb']) {
      expect(windowsBatchFileCommand('C:\\x.cmd', [a], env), JSON.stringify(a)).toHaveProperty('refused')
    }
  })

  it('refuses when the system cmd.exe cannot be named', () => {
    expect(windowsBatchFileCommand('C:\\x.cmd', [], { SystemRoot: 'Windows' })).toHaveProperty('refused')
    expect(windowsBatchFileCommand('C:\\x.cmd', [], {})).toHaveProperty('refused')
  })

  it('a comma-joined list and an empty value after = are one plain argument each', () => {
    const r = windowsBatchFileCommand('C:\\npm\\claude.cmd', ['--tools=', '--disallowedTools', 'Bash,Read,Write'], env)
    expect(r).toHaveProperty('args')
    expect((r as { args: string[] }).args[4]).toBe('""C:\\npm\\claude.cmd" --tools= --disallowedTools Bash,Read,Write"')
  })
})

describe('a program found by its full path starts without a shell', () => {
  const env = { SystemRoot: 'C:\\Windows' }

  // What every start command's environment adds: the programs the child
  // starts by name are looked for only in PATH's folders.
  const startEnv = { ...env, NoDefaultCurrentDirectoryInExePath: '1' }

  it('an executable starts directly, its arguments as given', () => {
    expect(windowsStartCommand('C:\\Tools\\claude.exe', ['-p', 'a b'], env)).toEqual({ file: 'C:\\Tools\\claude.exe', args: ['-p', 'a b'], windowsVerbatimArguments: false, env: startEnv })
    expect(windowsStartCommand('\\\\srv\\share\\gh.exe', ['auth'], env)).toEqual({ file: '\\\\srv\\share\\gh.exe', args: ['auth'], windowsVerbatimArguments: false, env: startEnv })
  })

  it('a batch file starts through the system cmd.exe', () => {
    expect(windowsStartCommand('C:\\npm\\claude.cmd', ['-p'], env)).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/v:off', '/s', '/c', '""C:\\npm\\claude.cmd" -p"'], windowsVerbatimArguments: true, env: startEnv,
    })
  })

  it('the start command carries its environment, in which the child finds programs only in PATH\'s folders; the env passed in is left as it was', () => {
    for (const program of ['C:\\Tools\\claude.exe', 'C:\\npm\\claude.cmd']) {
      const given = { SystemRoot: 'C:\\Windows', Path: 'C:\\Tools', nodefaultcurrentdirectoryinexepath: '' }
      const before = { ...given }
      const how = windowsStartCommand(program, ['-p'], given)
      expect(how, program).toHaveProperty('env', { SystemRoot: 'C:\\Windows', Path: 'C:\\Tools', NoDefaultCurrentDirectoryInExePath: '1' })
      expect(given, program).toEqual(before)
    }
  })

  it('the child finds the programs it starts by name only in the folders PATH names in full, as a Claude session does: a relative, rooted or drive-relative entry is dropped', () => {
    for (const program of ['C:\\Tools\\claude.exe', 'C:\\npm\\claude.cmd']) {
      const given = { SystemRoot: 'C:\\Windows', Path: 'C:\\npm;.;tools;.\\bin;C:rel;\\rooted;"E:\\Node Dir"', PATH: 'node_modules\\.bin' }
      const before = { ...given }
      const how = windowsStartCommand(program, ['-p'], given)
      expect(how, program).toHaveProperty('env', { SystemRoot: 'C:\\Windows', Path: 'C:\\npm;E:\\Node Dir', NoDefaultCurrentDirectoryInExePath: '1' })
      expect(how, program).toHaveProperty('env', withFullyQualifiedProgramLookup(given))
      expect(given, program).toEqual(before)
    }
  })

  it('a bare or relative name, a script or a refused batch file is refused', () => {
    for (const p of ['claude', 'claude.exe', '.\\claude.exe', 'bin\\claude.exe', 'C:\\x\\claude.ps1', 'C:\\x\\claude', 'C:\\a%b\\claude.cmd']) {
      expect(windowsStartCommand(p, [], env), p).toHaveProperty('refused')
    }
  })

  it('the child looks for programs it starts by name only in PATH\'s folders', () => {
    expect(withoutCurrentFolderLookup({ A: '1' })).toEqual({ A: '1', NoDefaultCurrentDirectoryInExePath: '1' })
  })

  it('the setting is one spelling: an inherited one in another case is replaced, and the env passed in is left as it was', () => {
    for (const inherited of ['NODEFAULTCURRENTDIRECTORYINEXEPATH', 'nodefaultcurrentdirectoryinexepath', 'NoDefaultCurrentDirectoryInExePath']) {
      const given = { A: '1', [inherited]: '' }
      expect(withoutCurrentFolderLookup(given), inherited).toEqual({ A: '1', NoDefaultCurrentDirectoryInExePath: '1' })
      expect(given, inherited).toEqual({ A: '1', [inherited]: '' })
    }
  })
})

describe('a child that starts Claude Code finds programs only in fully qualified PATH folders', () => {
  const MIXED = ['.', 'tools', '.\\bin', 'C:rel', '\\rooted', '', '%LOCALAPPDATA%\\bin', '\\\\?\\C:\\dev', '\\\\server',
    'C:\\Tools', ' D:\\Padded ', '"E:\\Quoted Dir"', '\\\\server\\share\\bin', '//srv/share/git'].join(';')

  it('every spelling of PATH keeps only its fully qualified folders; one left with none is dropped; the setting is on in one spelling', () => {
    const given = { Path: MIXED, PATH: 'relative', A: '1', nodefaultcurrentdirectoryinexepath: '0' }
    expect(withFullyQualifiedProgramLookup(given)).toEqual({
      Path: 'C:\\Tools;D:\\Padded;E:\\Quoted Dir;\\\\server\\share\\bin;//srv/share/git', A: '1', NoDefaultCurrentDirectoryInExePath: '1',
    })
    expect(given.PATH).toBe('relative')
  })

  it('entry by entry: kept, trimmed and unquoted, exactly when the shared folder rule takes it', () => {
    for (const entry of MIXED.split(';')) {
      let dir = entry.trim()
      if (dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1).trim()
      expect(withFullyQualifiedProgramLookup({ Path: entry }).Path, JSON.stringify(entry)).toBe(windowsPathFolderIsFullyQualified(dir) ? dir : undefined)
    }
  })
})
