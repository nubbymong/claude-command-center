import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as path from 'path'
import {
  firstToken,
  resolveExecutable,
  resolveCommandExecutable,
  clearExecutableResolutionCache,
  DEFAULT_PATHEXT,
} from '../../src/main/resolve-executable'

// #379. Before we can say whether a command button will paint over the terminal,
// we have to know which FILE its line would run. Nothing here spawns anything --
// `where` is exactly the wrong tool for "what would this spawn" -- so the whole
// surface is a parser plus a PATH walk, and `exists` is injected.

beforeEach(() => clearExecutableResolutionCache())

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
      exists: async (p: string) => set.has(p.toLowerCase()),
      noCache: true,
    }
  }

  it('appends PATHEXT extensions to a bare name found on PATH', async () => {
    const opts = {
      cwd: 'C:\\work',
      pathEnv: 'C:\\tools;C:\\other',
      pathExt: DEFAULT_PATHEXT,
      ...win(['C:\\tools\\bambu-studio.exe']),
    }
    await expect(resolveExecutable('bambu-studio', opts)).resolves.toBe('C:\\tools\\bambu-studio.exe')
  })

  it('prefers the literal name over an extension-appended one', async () => {
    const opts = {
      cwd: 'C:\\work',
      pathEnv: 'C:\\tools',
      pathExt: DEFAULT_PATHEXT,
      ...win(['C:\\tools\\tool.exe', 'C:\\tools\\tool.exe.exe']),
    }
    await expect(resolveExecutable('tool.exe', opts)).resolves.toBe('C:\\tools\\tool.exe')
  })

  it('honours PATH order', async () => {
    const opts = {
      cwd: 'C:\\work',
      pathEnv: 'C:\\first;C:\\second',
      pathExt: DEFAULT_PATHEXT,
      ...win(['C:\\first\\t.exe', 'C:\\second\\t.exe']),
    }
    await expect(resolveExecutable('t', opts)).resolves.toBe('C:\\first\\t.exe')
  })

  it('honours PATHEXT order within one directory', async () => {
    const opts = {
      cwd: 'C:\\work',
      pathEnv: 'C:\\tools',
      pathExt: '.COM;.EXE;.CMD',
      ...win(['C:\\tools\\t.cmd', 'C:\\tools\\t.exe']),
    }
    // .EXE comes before .CMD in PATHEXT, so the exe wins -- which matters,
    // because a .cmd shim is not a PE and would sniff as not-pe.
    await expect(resolveExecutable('t', opts)).resolves.toBe('C:\\tools\\t.exe')
  })

  it('lowercases the appended extension, so the path shown to the user is not SHOUTED', async () => {
    const opts = { cwd: 'C:\\work', pathEnv: 'C:\\tools', pathExt: '.EXE', ...win(['C:\\tools\\t.exe']) }
    await expect(resolveExecutable('t', opts)).resolves.toBe('C:\\tools\\t.exe')
  })

  // ---- MAJOR-4: never reach further than the shell it stands in for ---------

  it('does NOT search the current directory for a bare name', async () => {
    // PowerShell -- the shell CCC starts for shell buttons -- does not run
    // `.\foo.exe` for a bare `foo`. Searching the cwd here (cmd.exe's rule)
    // would give the capture path a reach the typed path does not have: a repo
    // that happens to contain its own bambu-studio.exe would be the file main
    // spawned, silently, under a remembered 'capture' policy.
    const opts = {
      cwd: 'C:\\repo',
      pathEnv: 'C:\\tools',
      pathExt: DEFAULT_PATHEXT,
      ...win(['C:\\repo\\bambu-studio.exe']),
    }
    await expect(resolveExecutable('bambu-studio', opts)).resolves.toBeNull()
  })

  it('picks the PATH copy, not the repo copy, when both exist', async () => {
    const opts = {
      cwd: 'C:\\repo',
      pathEnv: 'C:\\tools',
      pathExt: DEFAULT_PATHEXT,
      ...win(['C:\\repo\\t.exe', 'C:\\tools\\t.exe']),
    }
    await expect(resolveExecutable('t', opts)).resolves.toBe('C:\\tools\\t.exe')
  })

  it('still resolves an EXPLICIT .\\name against cwd -- the user wrote a path', async () => {
    const opts = { cwd: 'C:\\repo', pathEnv: 'C:\\tools', pathExt: DEFAULT_PATHEXT, ...win(['C:\\repo\\t.exe']) }
    await expect(resolveExecutable('.\\t', opts)).resolves.toBe('C:\\repo\\t.exe')
  })

  it('resolves a relative path against cwd and does NOT fall back to PATH', async () => {
    const opts = { cwd: 'C:\\work', pathEnv: 'C:\\tools', pathExt: DEFAULT_PATHEXT, ...win(['C:\\tools\\t.exe']) }
    await expect(resolveExecutable('.\\t', opts)).resolves.toBeNull()
  })

  it('resolves an absolute path directly', async () => {
    const opts = {
      cwd: 'C:\\work',
      pathEnv: '',
      pathExt: DEFAULT_PATHEXT,
      ...win(['C:\\Program Files\\Bambu Studio\\bambu-studio.exe']),
    }
    await expect(resolveExecutable('C:\\Program Files\\Bambu Studio\\bambu-studio.exe', opts))
      .resolves.toBe('C:\\Program Files\\Bambu Studio\\bambu-studio.exe')
  })

  it('strips quotes around a PATH entry', async () => {
    const opts = {
      cwd: 'C:\\work',
      pathEnv: '"C:\\tools";C:\\other',
      pathExt: DEFAULT_PATHEXT,
      ...win(['C:\\tools\\t.exe']),
    }
    await expect(resolveExecutable('t', opts)).resolves.toBe('C:\\tools\\t.exe')
  })

  it('ignores an empty PATH entry rather than treating it as the cwd', async () => {
    const opts = { cwd: 'C:\\work', pathEnv: ';;', pathExt: DEFAULT_PATHEXT, ...win(['C:\\work\\t.exe']) }
    await expect(resolveExecutable('t', opts)).resolves.toBeNull()
  })

  it('returns null for an unknown name instead of throwing', async () => {
    const opts = { cwd: 'C:\\work', pathEnv: 'C:\\tools', pathExt: DEFAULT_PATHEXT, ...win([]) }
    await expect(resolveExecutable('nope', opts)).resolves.toBeNull()
    await expect(resolveExecutable('', opts)).resolves.toBeNull()
  })
})

describe('resolveExecutable (POSIX rules)', () => {
  const posix = (files: string[]) => ({
    platform: 'linux' as NodeJS.Platform,
    exists: async (p: string) => files.includes(p),
    noCache: true,
  })

  it('does not append extensions and does not search the current directory', async () => {
    const opts = {
      cwd: '/work',
      pathEnv: '/usr/bin:/bin',
      ...posix(['/usr/bin/inkscape', '/work/inkscape']),
    }
    await expect(resolveExecutable('inkscape', opts)).resolves.toBe('/usr/bin/inkscape')
  })

  it('resolves an explicit ./name against cwd', async () => {
    const opts = { cwd: '/work', pathEnv: '/usr/bin', ...posix(['/work/tool']) }
    await expect(resolveExecutable('./tool', opts)).resolves.toBe(path.posix.resolve('/work', './tool'))
  })
})

describe('resolution caching (#379 MAJOR-6)', () => {
  // ~40 PATH entries x ~11 PATHEXT extensions is ~440 stats per press. The walk
  // is async now, and it should also not happen twice for the same button.
  it('does not re-walk PATH for a repeated lookup', async () => {
    const exists = vi.fn(async (p: string) => p.toLowerCase() === 'c:\\tools\\t.exe')
    const opts = { cwd: 'C:\\work', pathEnv: 'C:\\a;C:\\b;C:\\tools', pathExt: DEFAULT_PATHEXT, platform: 'win32' as NodeJS.Platform, exists }

    await expect(resolveExecutable('t', opts)).resolves.toBe('C:\\tools\\t.exe')
    const firstCallCount = exists.mock.calls.length
    expect(firstCallCount).toBeGreaterThan(1)

    await expect(resolveExecutable('t', opts)).resolves.toBe('C:\\tools\\t.exe')
    expect(exists).toHaveBeenCalledTimes(firstCallCount) // no new stats at all
  })

  it('caches the NOT-FOUND answer too -- that is the walk that costs the most', async () => {
    const exists = vi.fn(async () => false)
    const opts = { cwd: 'C:\\work', pathEnv: 'C:\\a;C:\\b', pathExt: DEFAULT_PATHEXT, platform: 'win32' as NodeJS.Platform, exists }

    await expect(resolveExecutable('nope', opts)).resolves.toBeNull()
    const n = exists.mock.calls.length
    await expect(resolveExecutable('nope', opts)).resolves.toBeNull()
    expect(exists).toHaveBeenCalledTimes(n)
  })

  it('keys on the working directory, so the same name in two sessions is not confused', async () => {
    const exists = vi.fn(async (p: string) => p === 'C:\\a\\t.exe')
    const base = { pathEnv: 'C:\\a', pathExt: '.exe', platform: 'win32' as NodeJS.Platform, exists }
    await resolveExecutable('t', { ...base, cwd: 'C:\\one' })
    const n = exists.mock.calls.length
    await resolveExecutable('t', { ...base, cwd: 'C:\\two' })
    expect(exists.mock.calls.length).toBeGreaterThan(n)
  })

  it('noCache bypasses it entirely', async () => {
    const exists = vi.fn(async () => false)
    const opts = { cwd: 'C:\\w', pathEnv: 'C:\\a', pathExt: '.exe', platform: 'win32' as NodeJS.Platform, exists, noCache: true }
    await resolveExecutable('t', opts)
    const n = exists.mock.calls.length
    await resolveExecutable('t', opts)
    expect(exists.mock.calls.length).toBe(n * 2)
  })
})

describe('resolveCommandExecutable', () => {
  it('parses and resolves in one step', async () => {
    const out = await resolveCommandExecutable('bambu-studio --debug 2', {
      cwd: 'C:\\work',
      pathEnv: 'C:\\tools',
      pathExt: DEFAULT_PATHEXT,
      platform: 'win32',
      exists: async (p: string) => p.toLowerCase() === 'c:\\tools\\bambu-studio.exe',
      noCache: true,
    })
    expect(out).toEqual({ token: 'bambu-studio', exePath: 'C:\\tools\\bambu-studio.exe' })
  })

  it('reports a null token for a line with no program', async () => {
    await expect(resolveCommandExecutable('  ', { cwd: 'C:\\work', noCache: true })).resolves.toEqual({ token: null, exePath: null })
  })
})
