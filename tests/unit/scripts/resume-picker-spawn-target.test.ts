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
  buildSpawnTarget: (cmd: string, args: string[], platform?: string) => { file: string; argv: string[]; verbatim: boolean } | null
}

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
    const t = buildSpawnTarget('C:\\npm\\claude.cmd', ['--model', 'opus[1m]'], 'win32')!
    expect(t.file).toBe('cmd.exe')
    expect(t.argv).toEqual(['/d', '/v:off', '/s', '/c', '""C:\\npm\\claude.cmd" --model opus[1m]"'])
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
function whatCmdRuns(t: { file: string; argv: string[]; verbatim?: boolean }): { program: string; rest: string } {
  expect(t.file).toBe('cmd.exe')
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
    expect(ran.rest).toBe(args.map(quoteLikeNode).join(' '))
  })

  it('runs the shim itself when its folder carries parentheses', () => {
    const shim = 'C:\\Program Files (x86)\\npm\\claude.cmd'
    const ran = whatCmdRuns(buildSpawnTarget(shim, ['--model', 'opus'], 'win32')!)
    expect(ran.program).toBe(shim)
    expect(ran.rest).toBe('--model opus')
  })

  it('changes only how the shim path is written: the arguments reach cmd.exe as Node writes them', () => {
    const args = ['--agents', agents, '--settings', settings, '--model', 'opus[1m]']
    for (const shim of ['C:\\npm\\claude.cmd', 'C:\\Users\\Jo Smith\\npm\\claude.cmd', 'C:\\npm\\claude.bat']) {
      const ran = whatCmdRuns(buildSpawnTarget(shim, args, 'win32')!)
      expect(ran.program).toBe(shim)
      expect(ran.rest).toBe(args.map(quoteLikeNode).join(' '))
    }
  })

  it('refuses a shim path cmd.exe or the shim would re-read, as the version probe does', () => {
    for (const shim of ['C:\\a%PATH%\\claude.cmd', 'C:\\a&b\\claude.cmd', 'C:\\a^b\\claude.cmd', 'C:\\a"b\\claude.cmd', 'C:\\a' + String.fromCharCode(10) + 'b\\claude.cmd']) {
      expect(buildSpawnTarget(shim, ['--model', 'opus'], 'win32'), shim).toBeNull()
    }
    // A plain executable is never refused: no shell reads its path.
    expect(buildSpawnTarget('C:\\a&b\\claude.exe', ['--model', 'opus'], 'win32')).not.toBeNull()
  })

  it('both launches pass the verbatim flag and stop on a refused target', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path')
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'resume-picker.js'), 'utf-8')
    const body = src.slice(src.indexOf('function launchClaude('), src.indexOf('function resolveRetargetCwd('))
    expect(body.match(/windowsVerbatimArguments: target\.verbatim/g) ?? []).toHaveLength(1)
    expect(body.match(/windowsVerbatimArguments: freshTarget\.verbatim/g) ?? []).toHaveLength(1)
    expect(body).toMatch(/if \(!target\)/)
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
