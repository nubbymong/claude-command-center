import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { firstToken, resolveExecutable, resolveCommandExecutable, DEFAULT_PATHEXT } from '../../src/main/resolve-executable'

// #379. Before we can say whether a command button will paint over the terminal,
// we have to know which FILE its line would run. Nothing here spawns anything --
// `where` is exactly the wrong tool for "what would this spawn" -- so the whole
// surface is a parser plus a PATH walk, and `exists` is injected.

describe('firstToken', () => {
  it('takes the bare program name off the front', () => {
    expect(firstToken('bambu-studio.exe --debug 2')).toEqual({ token: 'bambu-studio.exe', rest: '--debug 2' })
  })

  it('takes a program with no arguments at all', () => {
    expect(firstToken('inkscape')).toEqual({ token: 'inkscape', rest: '' })
  })

  it('unwraps a double-quoted path containing spaces', () => {
    expect(firstToken('"C:\\Program Files\\Bambu Studio\\bambu-studio.exe" --debug 2')).toEqual({
      token: 'C:\\Program Files\\Bambu Studio\\bambu-studio.exe',
      rest: '--debug 2',
    })
  })

  it("unwraps PowerShell's & 'path' call-operator form", () => {
    // How anyone actually pastes a path with a space into the shell CCC starts.
    expect(firstToken("& 'C:\\Program Files\\Inkscape\\bin\\inkscape.exe' --version")).toEqual({
      token: 'C:\\Program Files\\Inkscape\\bin\\inkscape.exe',
      rest: '--version',
    })
    expect(firstToken("&'x.exe' -a")).toEqual({ token: 'x.exe', rest: '-a' })
  })

  it('tolerates leading and trailing whitespace', () => {
    expect(firstToken('   git   status  ')).toEqual({ token: 'git', rest: 'status' })
  })

  it('gives up rather than guessing on an empty or unterminated line', () => {
    expect(firstToken('')).toBeNull()
    expect(firstToken('   ')).toBeNull()
    expect(firstToken('&')).toBeNull()
    expect(firstToken('"C:\\unterminated\\path.exe --flag')).toBeNull()
    expect(firstToken('""')).toBeNull()
  })

  it('is not a shell parser, and does not pretend to be', () => {
    // A variable, a pipeline's right-hand side, a subexpression: the token is
    // returned verbatim and will simply fail to resolve, which is the safe
    // answer -- every consumer falls back to the pre-existing behaviour.
    expect(firstToken('$env:TOOL --version')?.token).toBe('$env:TOOL')
    expect(firstToken('a | b')?.token).toBe('a')
  })
})

describe('resolveExecutable (Windows rules)', () => {
  const win = (files: string[]) => {
    const set = new Set(files.map((f) => f.toLowerCase()))
    return {
      platform: 'win32' as NodeJS.Platform,
      exists: (p: string) => set.has(p.toLowerCase()),
    }
  }

  it('appends PATHEXT extensions to a bare name found on PATH', () => {
    const opts = {
      cwd: 'C:\\work',
      pathEnv: 'C:\\tools;C:\\other',
      pathExt: DEFAULT_PATHEXT,
      ...win(['C:\\tools\\bambu-studio.exe']),
    }
    expect(resolveExecutable('bambu-studio', opts)).toBe('C:\\tools\\bambu-studio.exe')
  })

  it('prefers the literal name over an extension-appended one', () => {
    const opts = {
      cwd: 'C:\\work',
      pathEnv: 'C:\\tools',
      pathExt: DEFAULT_PATHEXT,
      ...win(['C:\\tools\\tool.exe', 'C:\\tools\\tool.exe.exe']),
    }
    expect(resolveExecutable('tool.exe', opts)).toBe('C:\\tools\\tool.exe')
  })

  it('honours PATH order', () => {
    const opts = {
      cwd: 'C:\\work',
      pathEnv: 'C:\\first;C:\\second',
      pathExt: DEFAULT_PATHEXT,
      ...win(['C:\\first\\t.exe', 'C:\\second\\t.exe']),
    }
    expect(resolveExecutable('t', opts)).toBe('C:\\first\\t.exe')
  })

  it('honours PATHEXT order within one directory', () => {
    const opts = {
      cwd: 'C:\\work',
      pathEnv: 'C:\\tools',
      pathExt: '.COM;.EXE;.CMD',
      ...win(['C:\\tools\\t.cmd', 'C:\\tools\\t.exe']),
    }
    // .EXE comes before .CMD in PATHEXT, so the exe wins -- which matters,
    // because a .cmd shim is not a PE and would sniff as not-pe.
    expect(resolveExecutable('t', opts)).toBe('C:\\tools\\t.exe')
  })

  it('searches the current directory FIRST for a bare name, as Windows does', () => {
    const opts = {
      cwd: 'C:\\work',
      pathEnv: 'C:\\tools',
      pathExt: DEFAULT_PATHEXT,
      ...win(['C:\\work\\t.exe', 'C:\\tools\\t.exe']),
    }
    expect(resolveExecutable('t', opts)).toBe('C:\\work\\t.exe')
  })

  it('resolves a relative path against cwd and does NOT search PATH', () => {
    const opts = {
      cwd: 'C:\\work',
      pathEnv: 'C:\\tools',
      pathExt: DEFAULT_PATHEXT,
      ...win(['C:\\tools\\t.exe']),
    }
    // `.\t` names a location; the PATH copy must not be substituted for it.
    expect(resolveExecutable('.\\t', opts)).toBeNull()
  })

  it('resolves an absolute path directly', () => {
    const opts = {
      cwd: 'C:\\work',
      pathEnv: '',
      pathExt: DEFAULT_PATHEXT,
      ...win(['C:\\Program Files\\Bambu Studio\\bambu-studio.exe']),
    }
    expect(resolveExecutable('C:\\Program Files\\Bambu Studio\\bambu-studio.exe', opts))
      .toBe('C:\\Program Files\\Bambu Studio\\bambu-studio.exe')
  })

  it('strips quotes around a PATH entry', () => {
    const opts = {
      cwd: 'C:\\work',
      pathEnv: '"C:\\tools";C:\\other',
      pathExt: DEFAULT_PATHEXT,
      ...win(['C:\\tools\\t.exe']),
    }
    expect(resolveExecutable('t', opts)).toBe('C:\\tools\\t.exe')
  })

  it('returns null for an unknown name instead of throwing', () => {
    const opts = { cwd: 'C:\\work', pathEnv: 'C:\\tools', pathExt: DEFAULT_PATHEXT, ...win([]) }
    expect(resolveExecutable('nope', opts)).toBeNull()
    expect(resolveExecutable('', opts)).toBeNull()
  })

  it('ignores an empty PATH entry rather than treating it as the cwd', () => {
    const opts = {
      cwd: 'C:\\work',
      pathEnv: ';;',
      pathExt: DEFAULT_PATHEXT,
      ...win(['C:\\work\\t.exe']),
    }
    // The cwd hit comes from the Windows current-directory rule above, not from
    // the empty entries; with that rule removed there would be nothing.
    expect(resolveExecutable('t', opts)).toBe('C:\\work\\t.exe')
  })
})

describe('resolveExecutable (POSIX rules)', () => {
  const posix = (files: string[]) => ({
    platform: 'linux' as NodeJS.Platform,
    exists: (p: string) => files.includes(p),
  })

  it('does not append extensions and does not search the current directory', () => {
    const opts = {
      cwd: '/work',
      pathEnv: '/usr/bin:/bin',
      ...posix(['/usr/bin/inkscape', '/work/inkscape']),
    }
    expect(resolveExecutable('inkscape', opts)).toBe('/usr/bin/inkscape')
  })

  it('resolves an explicit ./name against cwd', () => {
    const opts = { cwd: '/work', pathEnv: '/usr/bin', ...posix(['/work/tool']) }
    expect(resolveExecutable('./tool', opts)).toBe(path.posix.resolve('/work', './tool'))
  })
})

describe('resolveCommandExecutable', () => {
  it('parses and resolves in one step', () => {
    const out = resolveCommandExecutable('bambu-studio --debug 2', {
      cwd: 'C:\\work',
      pathEnv: 'C:\\tools',
      pathExt: DEFAULT_PATHEXT,
      platform: 'win32',
      exists: (p: string) => p.toLowerCase() === 'c:\\tools\\bambu-studio.exe',
    })
    expect(out).toEqual({ token: 'bambu-studio', exePath: 'C:\\tools\\bambu-studio.exe' })
  })

  it('reports a null token for a line with no program', () => {
    expect(resolveCommandExecutable('  ', { cwd: 'C:\\work' })).toEqual({ token: null, exePath: null })
  })
})
