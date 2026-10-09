// Every forwarded argument stays one argument on the npm launcher route.
//
// An npm-installed Claude Code on Windows is a .cmd shim. The picker starts it
// through the system cmd.exe as one verbatim `/d /v:off /s /c "<line>"`, and
// three readers parse that line before Claude Code sees an argument: cmd.exe
// reading the /c line; cmd.exe again reading the shim's own line, once `%*`
// has put the same arguments into it; and the program's argument parser (the
// C runtime rule, which node and the native binary both follow). This file
// models the three and checks that every argument arrives exactly as written,
// with every character cmd.exe reads as syntax inside its quotes. A claude.bat
// launcher takes the same route on the same line (cmd.exe reads a .bat's `%*`
// as it reads a .cmd's), so it is held to the same checks. Pure: nothing here
// starts a process; every value is built in this file.
import { describe, it, expect } from 'vitest'

type Target = { file: string; argv: string[]; verbatim: boolean; env?: Record<string, string | undefined> }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const picker = require('../../../scripts/resume-picker.js') as {
  buildSpawnTarget: (cmd: string, args: string[], platform?: string, env?: Record<string, string | undefined>) => Target | null
  notStartedMessage: (cmd: string | null, args: string[], env?: Record<string, string | undefined>) => string
}

const SHIM = 'C:\\Users\\Jo Smith\\AppData\\Roaming\\npm\\claude.cmd'
const BAT = 'C:\\Users\\Jo Smith\\AppData\\Roaming\\npm\\claude.bat'
const ENV = { SystemRoot: 'C:\\Windows' }
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const ch = (n: number): string => String.fromCharCode(n)

/** What cmd.exe reads as more than text in `line`: each of & | < > ^ ( )
 *  outside its quotes (the quote state turns at EVERY double quote; a
 *  backslash does not escape one), every %, and any control character. */
const SYNTAX = new Set(['&', '|', '<', '>', '^', '(', ')'])
function cmdSyntaxIn(line: string): string[] {
  const found: string[] = []
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { quoted = !quoted; continue }
    if (c === '%') found.push(`% at ${i}`)
    else if (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) found.push(`control at ${i}`)
    else if (!quoted && SYNTAX.has(c)) found.push(`${c} at ${i}`)
  }
  return found
}

/** The C runtime's rule for the arguments after the program name: 2n
 *  backslashes and a quote give n backslashes and turn the quote state,
 *  2n+1 give n and a literal quote, a doubled quote inside quotes is one
 *  literal quote, other backslashes are literal, spaces and tabs outside
 *  quotes separate arguments. */
function crtArgv(text: string): string[] {
  const out: string[] = []
  let i = 0
  const n = text.length
  for (;;) {
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++
    if (i >= n) break
    let arg = ''
    let quoted = false
    for (;;) {
      let slashes = 0
      while (i < n && text[i] === '\\') { slashes++; i++ }
      let copy = true
      if (i < n && text[i] === '"') {
        if (slashes % 2 === 0) {
          if (quoted && text[i + 1] === '"') i++
          else { copy = false; quoted = !quoted }
        }
        slashes = Math.floor(slashes / 2)
      }
      arg += '\\'.repeat(slashes)
      if (i >= n || (!quoted && (text[i] === ' ' || text[i] === '\t'))) break
      if (copy) arg += text[i]
      i++
    }
    out.push(arg)
  }
  return out
}

/** The /c line, the program cmd.exe starts from it, and the text after the
 *  program (what the shim's %* holds). */
function readByCmd(t: Target): { line: string; program: string; rest: string } {
  expect(t.verbatim).toBe(true)
  expect(t.argv.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c'])
  expect(t.argv).toHaveLength(5)
  const body = t.argv[4]
  expect(body.startsWith('"') && body.endsWith('"'), body).toBe(true)
  const line = body.slice(1, -1) // /s drops exactly the outer pair
  expect(line.startsWith('"'), line).toBe(true)
  const end = line.indexOf('"', 1)
  return { line, program: line.slice(1, end), rest: line.slice(end + 1).replace(/^[ \t]+/, '') }
}

function arrives(args: string[], shim: string = SHIM): { program: string; onCLine: string[]; onShimLine: string[]; argv: string[] } {
  const t = picker.buildSpawnTarget(shim, args, 'win32', ENV)
  expect(t, JSON.stringify(args)).not.toBeNull()
  const { line, program, rest } = readByCmd(t!)
  // The shim's own line puts the same text after its program and script,
  // whose quotes are balanced, so cmd.exe reads `rest` there from outside quotes.
  return { program, onCLine: cmdSyntaxIn(line), onShimLine: cmdSyntaxIn(rest), argv: crtArgv(rest) }
}

const BS = '\\'
const template = [
  { name: 'reviewer', description: '"Quoted" & (grouped) | piped < in > out ^ caret', prompt: '" & a value that starts with a quote', tools: ['Read', 'Grep'] },
  { name: 'paths', description: 'ends with a backslash ' + BS, prompt: 'C:' + BS + 'dir' + BS + '"name"' + BS + BS + ' and (^) <&> |' },
]
const agents = JSON.stringify(template)
const settings = 'C:\\Users\\Jo Smith\\AppData\\Local\\AI Code Conductor\\CONFIG\\s.json'

const ARG_LISTS: string[][] = [
  ['--agents', agents],
  ['--resume', UUID, '--settings', settings, '--mcp-config', settings, '--agents', agents],
  ['--model', 'opus[1m]', '--permission-mode', 'acceptEdits', '--plugin-dir', 'C:\\Users\\Jo Smith\\plugins\\', '--append-system-prompt', 'say "hi" & bye', ''],
  ['a"', '"b', '""', 'x\\"y', 'tail\\\\', 'wow!', '(a)', '^^', 'a b', '\\\\server\\share\\', '"&"'],
  [],
]

describe('every forwarded argument stays one argument on the npm launcher route', () => {
  const lists = ARG_LISTS

  it('reaches Claude Code as the same arguments, with every cmd.exe metacharacter inside its quotes', () => {
    for (const args of lists) {
      const got = arrives(args)
      expect(got.program).toBe(SHIM)
      expect(got.onCLine, JSON.stringify(args)).toEqual([])
      expect(got.onShimLine, JSON.stringify(args)).toEqual([])
      expect(got.argv).toEqual(args)
    }
  })

  it('an agent template reaches Claude Code exactly as written', () => {
    const got = arrives(['--agents', agents])
    expect(got.argv[0]).toBe('--agents')
    expect(JSON.parse(got.argv[1])).toEqual(template)
  })

  it('writes every argument in double quotes, each quote inside it doubled', () => {
    const t = picker.buildSpawnTarget('C:\\npm\\claude.cmd', ['--model', 'opus[1m]', 'say "hi"', 'dir\\'], 'win32', ENV)!
    expect(t.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(t.argv).toEqual(['/d', '/v:off', '/s', '/c', '""C:\\npm\\claude.cmd" "--model" "opus[1m]" "say ""hi""" "dir\\\\""'])
  })

  it('an exclamation mark stays text: the line runs with delayed expansion off', () => {
    const t = picker.buildSpawnTarget(SHIM, ['--append-system-prompt', 'ship it!'], 'win32', ENV)!
    expect(t).not.toBeNull()
    expect(t.argv[1]).toBe('/v:off')
    expect(arrives(['--append-system-prompt', 'ship it! now!']).argv).toEqual(['--append-system-prompt', 'ship it! now!'])
  })

  it('refuses % and control characters, which no quoting keeps as text on the line', () => {
    const bad = ['100%', '%PATH%', 'a%b', 'line' + ch(10) + 'break', 'tab' + ch(9), ch(13), ch(27) + '[2J', ch(7), ch(127), ch(0x85), ch(0)]
    for (const value of bad) {
      expect(picker.buildSpawnTarget(SHIM, ['--model', value], 'win32', ENV), JSON.stringify(value)).toBeNull()
    }
    expect(picker.buildSpawnTarget(SHIM, ['--agents', JSON.stringify([{ name: 'a', prompt: 'cover 100% of it' }])], 'win32', ENV)).toBeNull()
  })

  it('says which agent template or option it could not pass, and what to do', () => {
    const two = JSON.stringify([{ name: 'reviewer', prompt: 'read it all' }, { name: 'coverage', prompt: 'cover 100%' }])
    const tpl = picker.notStartedMessage(SHIM, ['--resume', UUID, '--agents', two], ENV)
    expect(tpl).toContain('the agent template "coverage" holds a % sign or a control character')
    expect(tpl).not.toContain('reviewer')
    expect(tpl).toContain('install the native Claude Code')
    // The same with the value written after an equals sign, and for templates keyed by name.
    expect(picker.notStartedMessage(SHIM, ['--agents=' + two], ENV)).toContain('the agent template "coverage" holds')
    expect(picker.notStartedMessage(SHIM, ['--agents', JSON.stringify({ tidy: { prompt: 'x' }, '50% off': { prompt: 'y' } })], ENV)).toContain('the agent template "50% off" holds')
    // A template's name is shown as plain text.
    const odd = picker.notStartedMessage(SHIM, ['--agents', JSON.stringify([{ name: 'odd' + ch(27) + '[2J', prompt: '1%' }])], ENV)
    expect(odd).toContain('the agent template "odd [2J" holds')
    expect(odd).not.toContain(ch(27))
    // No name to give: the template is still refused, in general words.
    const unseen = String.fromCodePoint(0x200b) + String.fromCodePoint(0x2060)
    for (const value of [JSON.stringify([{ prompt: '1%' }]), JSON.stringify([{ name: '  ', prompt: '1%' }]), JSON.stringify([{ name: unseen, prompt: '1%' }]), JSON.stringify({ [unseen]: { prompt: '1%' } }), '[1%]', '"1%"']) {
      expect(picker.notStartedMessage(SHIM, ['--agents', value], ENV), value).toContain('Not starting Claude Code: an agent template holds a % sign')
    }
    // A name with nothing to see gives way to the next template that is refused.
    expect(picker.notStartedMessage(SHIM, ['--agents', JSON.stringify([{ name: unseen, prompt: '1%' }, { name: 'coverage', prompt: '2%' }])], ENV))
      .toContain('the agent template "coverage" holds')
    expect(picker.notStartedMessage(SHIM, ['--model', 'x%'], ENV)).toContain('the value of --model holds')
    expect(picker.notStartedMessage(SHIM, ['--effort=50%'], ENV)).toContain('the value of --effort holds')
    expect(picker.notStartedMessage(SHIM, ['50%'], ENV)).toContain('an argument holds')
    // A flag name is shown as plain text.
    const shown = picker.notStartedMessage(SHIM, ['--x' + ch(27) + '[2J', 'v%'], ENV)
    expect(shown).not.toContain(ch(27))
    // The other refusals keep their own words.
    expect(picker.notStartedMessage(null, [], ENV)).toContain('it was not found in a folder PATH names')
    expect(picker.notStartedMessage('C:\\a&b\\claude.cmd', [], ENV)).toContain('cmd.exe would re-read a character in that path')
    expect(picker.notStartedMessage(SHIM, ['--model', 'x%'], { SystemRoot: 'relative' })).toContain('(SystemRoot) is not a plain absolute folder')
  })

  it('the native claude.exe starts with its arguments exactly as they are', () => {
    for (const args of [['--agents', agents], ['--model', '100%'], ['say "hi" & bye', '']]) {
      const t = picker.buildSpawnTarget('C:\\native\\claude.exe', args, 'win32', ENV)!
      expect(t).toEqual({ file: 'C:\\native\\claude.exe', argv: args, verbatim: false })
    }
  })

  it('the model counts every double quote, as cmd.exe does', () => {
    // Checks the checker: a quote written with a backslash still turns the state.
    expect(cmdSyntaxIn('"a\\"&b"')).toEqual(['& at 4'])
    expect(cmdSyntaxIn('"a""&b"')).toEqual([])
    expect(crtArgv('"a""b" "c\\\\" ""')).toEqual(['a"b', 'c\\', ''])
  })
})

describe('a claude.bat launcher starts exactly as a claude.cmd does', () => {
  /** The .cmd target with the launcher's path swapped for the .bat's. */
  const asBat = (t: Target): Target => ({ ...t, argv: t.argv.map((a) => a.split(SHIM).join(BAT)) })

  it('the same cmd.exe, the same verbatim line and the same environment rule, the path aside', () => {
    for (const args of ARG_LISTS) {
      const cmd = picker.buildSpawnTarget(SHIM, args, 'win32', ENV)!
      const bat = picker.buildSpawnTarget(BAT, args, 'win32', ENV)!
      expect(bat, JSON.stringify(args)).toEqual(asBat(cmd))
      expect(bat.file).toBe('C:\\Windows\\System32\\cmd.exe')
      expect(bat.verbatim).toBe(true)
      expect(bat.env!.NoDefaultCurrentDirectoryInExePath).toBe('1')
    }
    const t = picker.buildSpawnTarget('C:\\npm\\claude.bat', ['--model', 'opus[1m]', 'say "hi"', 'dir\\'], 'win32', ENV)!
    expect(t.argv).toEqual(['/d', '/v:off', '/s', '/c', '""C:\\npm\\claude.bat" "--model" "opus[1m]" "say ""hi""" "dir\\\\""'])
  })

  it('every forwarded argument and agent template reaches Claude Code as written, every metacharacter inside its quotes', () => {
    for (const args of ARG_LISTS) {
      const got = arrives(args, BAT)
      expect(got.program).toBe(BAT)
      expect(got.onCLine, JSON.stringify(args)).toEqual([])
      expect(got.onShimLine, JSON.stringify(args)).toEqual([])
      expect(got.argv).toEqual(args)
    }
    expect(JSON.parse(arrives(['--agents', agents], BAT).argv[1])).toEqual(template)
  })

  it('refuses what the .cmd route refuses, with the same words', () => {
    const two = JSON.stringify([{ name: 'reviewer', prompt: 'read it all' }, { name: 'coverage', prompt: 'cover 100%' }])
    const refused: string[][] = [
      ['--model', '100%'], ['--model', 'line' + ch(10) + 'break'], ['--agents', two], ['--agents=' + two], ['50%'], ['--effort=50%'],
    ]
    for (const args of refused) {
      expect(picker.buildSpawnTarget(BAT, args, 'win32', ENV), JSON.stringify(args)).toBeNull()
      expect(picker.notStartedMessage(BAT, args, ENV), JSON.stringify(args)).toBe(picker.notStartedMessage(SHIM, args, ENV))
    }
    expect(picker.notStartedMessage(BAT, ['--agents', two], ENV)).toContain('the agent template "coverage" holds a % sign or a control character')
    // The words fit a hand-written claude.bat as well as npm's claude.cmd.
    for (const args of [['--agents', two], ['--model', '100%']]) {
      const said = picker.notStartedMessage(BAT, args, ENV)
      expect(said, JSON.stringify(args)).toContain('which Claude Code started through its claude.cmd or claude.bat launcher cannot be given exactly as written')
      expect(said, JSON.stringify(args)).not.toMatch(/npm/i)
    }
    for (const unsafe of ['C:\\a%PATH%\\claude.bat', 'C:\\a&b\\claude.bat', 'C:\\a^b\\claude.bat', 'C:\\a"b\\claude.bat']) {
      expect(picker.buildSpawnTarget(unsafe, ['--model', 'opus'], 'win32', ENV), unsafe).toBeNull()
      expect(picker.notStartedMessage(unsafe, [], ENV), unsafe).toContain('cmd.exe would re-read a character in that path')
    }
    expect(picker.buildSpawnTarget(BAT, ['--model', 'opus'], 'win32', { SystemRoot: 'relative' })).toBeNull()
  })
})

describe('when no Claude Code is found, the launch says which names it looked for', () => {
  it('names claude.exe, claude.cmd and claude.bat, the app\'s own list', () => {
    expect(picker.notStartedMessage(null, [], ENV)).toBe(
      'Not starting Claude Code: it was not found in a folder PATH names (claude.exe, claude.cmd, claude.bat). Install it, or add its folder to PATH, then start the session again.',
    )
  })
})
