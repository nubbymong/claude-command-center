/**
 * The picker must never hand a command LINE to a shell.
 *
 * `shell: true` on Windows makes Node join [file, ...args] with spaces and pass
 * the result to `cmd.exe /d /s /c` UNESCAPED. Two consequences, both real:
 *
 *  - Metacharacters inside a forwarded value (`&`, `|`, `<`, `>`, `%`) become
 *    cmd.exe syntax. `--agents` carries user-authored template text, so that is
 *    a command-execution path.
 *  - Spaces inside a path split it. The default Windows data root is
 *    `%LOCALAPPDATA%\Claude Command Center` -- it ALWAYS has spaces -- so
 *    `--settings` was truncated on every restored Windows session.
 *
 * These assertions pin the shape (argv array, never a joined string) rather
 * than the symptom, because the symptom is platform-specific and the shape is
 * what actually prevents it.
 */
import { describe, it, expect } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const picker = require('../../../scripts/resume-picker.js')
const { buildSpawnTarget } = picker as {
  buildSpawnTarget: (cmd: string, args: string[], platform?: string, env?: Record<string, string | undefined>) => { file: string; argv: string[]; verbatim: boolean } | null
}
/** Round 3b: the system cmd.exe, by its full path. */
const SYSTEM_CMD_RE = /^[A-Za-z]:\\(?:[^\\]+\\)*System32\\cmd\.exe$/i

describe('buildSpawnTarget keeps arguments as argv elements', () => {
  it('passes a plain executable straight through', () => {
    const t = buildSpawnTarget('/usr/bin/claude', ['--model', 'opus'])!
    expect(t.file).toBe('/usr/bin/claude')
    expect(t.argv).toEqual(['--model', 'opus'])
  })

  it('keeps a path containing spaces as ONE argv element', () => {
    const settings = 'C:\\Users\\me\\AppData\\Local\\Claude Command Center\\CONFIG\\s.json'
    const t = buildSpawnTarget('claude.exe', ['--settings', settings])!
    expect(t.argv).toContain(settings)
    // The whole point: it must not have been split on the spaces.
    expect(t.argv.filter((a) => a.includes('Claude Command Center'))).toHaveLength(1)
  })

  it('keeps cmd.exe metacharacters inside a single argv element', () => {
    const hostile = '[{"name":"a","prompt":"x & whoami > C:\\\\tmp\\\\marker.txt"}]'
    const t = buildSpawnTarget('claude.exe', ['--agents', hostile])!
    expect(t.argv).toEqual(['--agents', hostile])
    // Never collapsed into a command line.
    expect(t.argv.join(' ')).not.toBe(t.argv[0] + t.argv[1])
  })

  it('routes a .cmd shim through cmd.exe, the shim path quoted inside the /s /c line', () => {
    const t = buildSpawnTarget('C:\\npm\\claude.cmd', ['--model', 'opus[1m]'], 'win32', { SystemRoot: 'C:\\Windows' })!
    expect(t.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(t.argv).toEqual(['/d', '/v:off', '/s', '/c', '""C:\\npm\\claude.cmd" "--model" "opus[1m]""'])
    expect(t.verbatim).toBe(true)
  })

  it('does NOT route a .exe through cmd.exe', () => {
    const t = buildSpawnTarget('C:\\bin\\claude.exe', ['--model', 'opus'], 'win32')!
    expect(t.file).toBe('C:\\bin\\claude.exe')
    expect(t.argv).toEqual(['--model', 'opus'])
    expect(t.verbatim).toBe(false)
  })
})

// How a .cmd shim is started (P3.10 round 3, F5). cmd.exe reads what follows
// `/c` itself (`cmd /?`): without /s it keeps the quotes only when the line
// holds exactly two of them, around a program name, with no `& < > ( ) @ ^ |`
// between them; otherwise it drops the first quote and the last one. The model
// below applies that rule to the line the target would hand cmd.exe and reads
// the program name off what is left.
function quoteLikeNode(a: string): string {
  // libuv's quote_cmd_arg: how Node writes one argv element into a command line.
  if (a === '') return '""'
  if (!/[ \t"]/.test(a)) return a
  if (!/["\\]/.test(a)) return `"${a}"`
  let out = ''
  let slashes = 0
  for (const ch of a) {
    if (ch === '\\') { slashes++; continue }
    if (ch === '"') { out += '\\'.repeat(slashes * 2 + 1) + '"'; slashes = 0; continue }
    out += '\\'.repeat(slashes) + ch
    slashes = 0
  }
  return `"${out}${'\\'.repeat(slashes * 2)}"`
}
/** How the shim route writes each argument after the shim path: in double
 *  quotes, each quote inside doubled, the backslashes before a quote doubled
 *  (resume-picker-cmd-quoting.test.ts checks that this arrives as written). */
function quoteForShim(a: string): string {
  let out = '"'
  let slashes = 0
  for (const ch of a) {
    if (ch === '\\') { slashes++; continue }
    if (ch === '"') { out += '\\'.repeat(slashes * 2) + '""'; slashes = 0; continue }
    out += '\\'.repeat(slashes) + ch
    slashes = 0
  }
  return out + '\\'.repeat(slashes * 2) + '"'
}
function whatCmdRuns(t: { file: string; argv: string[]; verbatim?: boolean }): { program: string; rest: string } {
  expect(t.file).toMatch(SYSTEM_CMD_RE)
  const line = t.verbatim ? t.argv.join(' ') : t.argv.map(quoteLikeNode).join(' ')
  const m = /^((?:\/(?!c\s)\S+\s+)*)\/c\s+([\s\S]*)$/i.exec(line)
  expect(m, `no /c in ${line}`).not.toBeNull()
  const switches = m![1]
  let body = m![2]
  const quotes = [...body].filter((c) => c === '"').length
  const inner = body.startsWith('"') ? body.slice(1, body.indexOf('"', 1)) : ''
  const keepsQuotes = !/\/s\b/i.test(switches) && quotes === 2 && body.startsWith('"') && !/[&<>()@^|]/.test(inner) && /\s/.test(inner)
  if (!keepsQuotes && body.startsWith('"')) {
    body = body.slice(1)
    const last = body.lastIndexOf('"')
    if (last >= 0) body = body.slice(0, last) + body.slice(last + 1)
  }
  if (body.startsWith('"')) {
    const end = body.indexOf('"', 1)
    return { program: body.slice(1, end), rest: body.slice(end + 1).replace(/^\s+/, '') }
  }
  const w = /^(\S+)\s*([\s\S]*)$/.exec(body)!
  return { program: w[1], rest: w[2] }
}

describe('a .cmd shim under a folder with a space still starts (P3.10 round 3, F5)', () => {
  const settings = 'C:\\Users\\Jo Smith\\AppData\\Local\\AI Code Conductor\\CONFIG\\s.json'
  const agents = '[{"name":"a","prompt":"review this"}]'
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e'

  it('runs the shim itself when an argument needs quotes too', () => {
    const shim = 'C:\\Users\\Jo Smith\\AppData\\Roaming\\npm\\claude.cmd'
    const args = ['--resume', uuid, '--settings', settings]
    const ran = whatCmdRuns(buildSpawnTarget(shim, args, 'win32')!)
    expect(ran.program).toBe(shim)
    expect(ran.rest).toBe(args.map(quoteForShim).join(' '))
  })

  it('runs the shim itself when its folder carries parentheses', () => {
    const shim = 'C:\\Program Files (x86)\\npm\\claude.cmd'
    const ran = whatCmdRuns(buildSpawnTarget(shim, ['--model', 'opus'], 'win32')!)
    expect(ran.program).toBe(shim)
    expect(ran.rest).toBe('"--model" "opus"')
  })

  it('writes the shim path the same way in every folder, the arguments after it', () => {
    const args = ['--agents', agents, '--settings', settings, '--model', 'opus[1m]']
    for (const shim of ['C:\\npm\\claude.cmd', 'C:\\Users\\Jo Smith\\npm\\claude.cmd', 'C:\\npm\\claude.bat']) {
      const ran = whatCmdRuns(buildSpawnTarget(shim, args, 'win32')!)
      expect(ran.program).toBe(shim)
      expect(ran.rest).toBe(args.map(quoteForShim).join(' '))
    }
  })

  it('refuses a shim path cmd.exe or the shim would re-read, as the version probe does', () => {
    for (const shim of ['C:\\a%PATH%\\claude.cmd', 'C:\\a&b\\claude.cmd', 'C:\\a^b\\claude.cmd', 'C:\\a"b\\claude.cmd', 'C:\\a' + String.fromCharCode(10) + 'b\\claude.cmd']) {
      expect(buildSpawnTarget(shim, ['--model', 'opus'], 'win32'), shim).toBeNull()
    }
    // A plain executable is never refused: no shell reads its path.
    expect(buildSpawnTarget('C:\\a&b\\claude.exe', ['--model', 'opus'], 'win32')).not.toBeNull()
  })

  it('a launch passes the verbatim flag exactly when its line is written for cmd.exe, and a refused target starts nothing', () => {
    // resume-picker.test.ts drives both launches through this one step.
    const { launchSpec } = picker as {
      launchSpec: (cmd: string, args: string[], base: Record<string, unknown>, platform?: string, env?: Record<string, string | undefined>) =>
        { file?: string; argv?: string[]; opts?: Record<string, unknown>; message?: string }
    }
    const env = { SystemRoot: 'C:\\Windows' }
    expect(launchSpec('C:\\Program Files (x86)\\npm\\claude.cmd', ['--model', 'opus'], {}, 'win32', env).opts!.windowsVerbatimArguments).toBe(true)
    expect(launchSpec('C:\\bin\\claude.exe', ['--model', 'opus'], {}, 'win32', env).opts!.windowsVerbatimArguments).toBe(false)
    const refused = launchSpec('C:\\a&b\\claude.cmd', ['--model', 'opus'], {}, 'win32', env)
    expect(refused.file).toBeUndefined()
    expect(refused.message).toContain('cmd.exe would re-read a character in that path')
  })
})

// Round 3b: the hook wrapper and the picker resolve their helpers from fixed
// locations. A .cmd shim runs through the system's own cmd.exe,
// <SystemRoot>\System32\cmd.exe (ComSpec only when it names exactly that file,
// in any case); SystemRoot falls back to
// C:\Windows only when it is not set, and one that is not a plain absolute
// folder refuses the start. The line cmd.exe runs is unchanged.
describe('the shim runs through the system cmd.exe, by its full path (P3.10 round 3b)', () => {
  const shim = 'C:\\npm\\claude.cmd'
  const run = (env: Record<string, string | undefined>) => buildSpawnTarget(shim, ['--model', 'opus'], 'win32', env)

  it('is <SystemRoot>\\System32\\cmd.exe, SystemRoot in any spelling', () => {
    expect(run({ SystemRoot: 'C:\\Windows' })!.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(run({ SYSTEMROOT: 'D:\\WINNT\\' })!.file).toBe('D:\\WINNT\\System32\\cmd.exe')
  })

  it('uses ComSpec only when it names that same file', () => {
    expect(run({ SystemRoot: 'C:\\Windows', ComSpec: 'c:\\windows\\system32\\CMD.EXE' })!.file).toBe('c:\\windows\\system32\\CMD.EXE')
    expect(run({ SystemRoot: 'C:\\Windows', COMSPEC: 'C:\\Windows\\System32\\cmd.exe' })!.file).toBe('C:\\Windows\\System32\\cmd.exe')
    for (const comSpec of ['cmd.exe', '.\\cmd.exe', 'C:\\tools\\cmd.exe', 'C:\\Windows\\SysWOW64\\cmd.exe', 'C:\\Windows\\System32\\..\\..\\tools\\cmd.exe', 'C:\\Windows\\System32\\cmd.exe.bat']) {
      expect(run({ SystemRoot: 'C:\\Windows', ComSpec: comSpec })!.file, comSpec).toBe('C:\\Windows\\System32\\cmd.exe')
    }
  })

  it('falls back to C:\\Windows only when SystemRoot is not set', () => {
    expect(run({})!.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(run({ SystemRoot: '' })!.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(run({ ComSpec: 'D:\\x\\cmd.exe' })!.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(run({ ComSpec: 'c:\\windows\\System32\\cmd.exe' })!.file).toBe('c:\\windows\\System32\\cmd.exe')
  })

  it('refuses a SystemRoot that is not a plain absolute folder, and two spellings that disagree', () => {
    for (const root of ['Windows', '.\\Windows', '\\Windows', 'C:Windows', '\\\\server\\share\\Windows', 'C:\\Win%x%', 'C:\\Win"x', 'C:\\Win&x', 'C:\\Win' + String.fromCharCode(10), 'C:\\Windows\\..\\Users\\me', 'C:\\.\\Windows']) {
      expect(run({ SystemRoot: root }), JSON.stringify(root)).toBeNull()
    }
    expect(run({ SystemRoot: 'C:\\Windows', SYSTEMROOT: 'D:\\Other' })).toBeNull()
    // The same value in two spellings is one value.
    expect(run({ SystemRoot: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows' })!.file).toBe('C:\\Windows\\System32\\cmd.exe')
  })

  it('starts cmd.exe from the system folder, with the shim and its arguments on one verbatim line', () => {
    const t = run({ SystemRoot: 'C:\\Windows' })!
    expect(t.file).toMatch(SYSTEM_CMD_RE)
    expect(t.argv).toEqual(['/d', '/v:off', '/s', '/c', '""C:\\npm\\claude.cmd" "--model" "opus""'])
    expect(t.verbatim).toBe(true)
    // A plain executable starts as it is, whatever the environment says.
    expect(buildSpawnTarget('C:\\bin\\claude.exe', ['x'], 'win32', { SystemRoot: 'relative' })!.file).toBe('C:\\bin\\claude.exe')
  })

  it('the picker source starts cmd.exe only through systemCmdExe', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path')
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'resume-picker.js'), 'utf-8')
    expect(src).not.toMatch(/file:\s*['"`]cmd\.exe['"`]/i)
    expect(src).not.toMatch(/spawnSync\(\s*['"`]cmd(\.exe)?['"`]/i)
  })
})

describe('the picker source never re-enables a shell', () => {
  it('has no shell:true and no platform-conditional shell option', () => {
    // A source-level guard on purpose. The failure mode is a one-word edit
    // (`shell: false` -> `shell: os.platform() === 'win32'`) that no
    // behavioural test on this machine's platform would necessarily catch.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path')
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'scripts', 'resume-picker.js'),
      'utf-8',
    )
    // Strip comment lines first: the rationale block above buildSpawnTarget
    // legitimately contains the words "shell: true" while explaining why not to.
    const codeLines = src
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('*') && !l.startsWith('//') && !l.startsWith('/*'))
    const spawnOptions = codeLines.join('\n').match(/shell:\s*[^,\n]+/g) ?? []
    expect(spawnOptions.length, 'expected at least one spawn option').toBeGreaterThan(0)
    for (const opt of spawnOptions) {
      expect(
        opt,
        'resume-picker must spawn with shell:false — shell:true on Windows ' +
        'concatenates argv into an unescaped cmd.exe command line',
      ).toMatch(/shell:\s*false/)
    }
  })
})
