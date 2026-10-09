// A Windows Claude session's agent templates reach Claude Code as JSON that
// parses to exactly the templates.
//
// PowerShell writes a program's arguments into one command line that the
// program splits again (cmd.exe reads it first for a .cmd/.bat launcher). The
// templates ride the session's environment (AGENTS_ENV) and the line carries
// only `--agents ${env:CCC_AGENTS}`; agentsEnvValue writes the value for the
// program the line starts. The value is the one object keyed by agent name
// that Claude Code's --agents takes (claudeAgentsObject), and a set Claude Code
// would not take, or one too long for the command line, is refused with the
// reason. This file models every reader between the value and Claude Code --
// the 5.1 binder, PowerShell 7's Legacy binder, cmd.exe (for a .cmd/.bat
// launcher), the C runtime's argument rule and CommandLineToArgvW's -- and
// checks the templates come out exactly, and that a line without templates, or
// off Windows, is the plain line. Pure: nothing here starts a process. The
// same line through real shells: spawn-claude-agents-powershell.test.ts.
import { describe, it, expect } from 'vitest'
import { AGENTS_ENV, PS_LEGACY_ARGUMENT_PASSING, agentsEnvValue, agentsRef, windowsCommandLineLimit } from '../../../src/main/terminal-launch-line'
import { AGENTS_LAUNCHER_ROOM, buildClaudeLaunchCommand, claudeAgentsObject, claudeLaunchProgram, launchStartsPicker, quoteArgForShell, type ClaudeAgentTemplate } from '../../../src/main/spawn-claude-command'
import { buildClaudeLocalSpawn } from '../../../src/main/providers/claude/spawn'

type Target = { file: string; argv: string[]; verbatim: boolean }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const picker = require('../../../scripts/resume-picker.js') as {
  buildSpawnTarget: (cmd: string, args: string[], platform?: string, env?: Record<string, string | undefined>) => Target | null
}

const BS = String.fromCharCode(92)
const EXE = `C:${BS}Users${BS}Jo Smith${BS}.local${BS}bin${BS}claude.exe`
const CMD = `C:${BS}Users${BS}Jo Smith (x)${BS}AppData${BS}Roaming${BS}npm${BS}claude.cmd`
const BAT = `C:${BS}tools${BS}claude.bat`
const SETTINGS = `C:${BS}Users${BS}Jo Smith${BS}AppData${BS}Local${BS}AI Code Conductor${BS}s (1).json`
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const PICKER = `C:${BS}res${BS}scripts${BS}resume-picker.js`

type Template = { name: string; description: string; prompt: string; model?: string; tools?: string[] }
const TEMPLATES: Template[] = [
  { name: 'reviewer', description: 'checks (a) & (b) | c > d < e ^ f', prompt: 'review it, then say done' },
  { name: 'q"uote', description: 'say "hi" and "bye"', prompt: `path C:${BS}temp${BS} and ${BS}${BS}srv${BS}x and ${BS}"q${BS}` },
  { name: 'percent', description: '100% of %PATH% and !USERNAME! and ^^ and %%', prompt: 'caf\u00e9 \u4e2d\u6587 \u{1F600} \u00fcn\u00efc\u00f6d\u00e9', model: 'opus[1m]', tools: ['Bash', 'Read', "it's"] },
  { name: 'controls', description: 'tab\there\nnew line\r and DEL\u007f and C1\u0085 and NUL\u0000', prompt: "$env:Y `whoami` $(calc) 'single' \u2019curly\u2019 ;exit" },
  { name: '', description: '', prompt: '' },
]
/** A set in the shape the value carries: one object keyed by name. Any JSON
 *  value travels the same way; this is the one the app sends. */
const asObject = (set: Template[]): Record<string, Omit<Template, 'name'>> => Object.fromEntries(set.map(({ name, ...rest }) => [name, rest]))

// ---- the readers between the value and Claude Code -----------------------

/** A binder's choice for one value: wrapped in quotes when it holds whitespace
 *  at an even count of quotes, otherwise as it is. Windows PowerShell 5.1
 *  counts every `"`; PowerShell 7's Legacy binder skips one right after a `\`
 *  (both measured on this repo's lines). */
function binder(skipAfterBackslash: boolean): (v: string) => string {
  return (v) => {
    let count = 0
    let afterBs = false
    let need = false
    for (const c of v) {
      if (c === '"' && !(skipAfterBackslash && afterBs)) count++
      else if (/\s/u.test(c) && count % 2 === 0) need = true
      afterBs = c === BS
    }
    return need ? `"${v}"` : v
  }
}
const BINDERS = { 'Windows PowerShell 5.1': binder(false), 'PowerShell 7, Legacy': binder(true) }

/** Arguments after the program name, split as a program splits them. 2n
 *  backslashes and a quote give n and turn the quote state, 2n+1 give n and a
 *  literal quote, other backslashes are literal, spaces and tabs outside
 *  quotes separate. A doubled quote inside quotes: the C runtime (node, the
 *  shim's program) reads one literal quote and stays inside; CommandLineToArgvW
 *  reads one literal quote and leaves the quotes (measured: the doubled form
 *  split into 11 arguments there). */
function splitter(doubledStaysQuoted: boolean): (text: string) => string[] {
  return (text) => {
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
        while (i < n && text[i] === BS) { slashes++; i++ }
        let copy = true
        if (i < n && text[i] === '"') {
          if (slashes % 2 === 0) {
            if (quoted && text[i + 1] === '"') { i++; if (!doubledStaysQuoted) quoted = false }
            else { copy = false; quoted = !quoted }
          }
          slashes = Math.floor(slashes / 2)
        }
        arg += BS.repeat(slashes)
        if (i >= n || (!quoted && (text[i] === ' ' || text[i] === '\t'))) break
        if (copy) arg += text[i]
        i++
      }
      out.push(arg)
    }
    return out
  }
}
const PARSERS = { 'the C runtime': splitter(true), CommandLineToArgvW: splitter(false) }
const crt = PARSERS['the C runtime']

/** What cmd.exe reads as more than text: & | < > ^ ( ) outside its quotes (the
 *  quote state turns at EVERY double quote; a backslash escapes none), and a %
 *  or ! anywhere (expanded inside quotes too), and any control character. */
function cmdSyntaxIn(line: string): string[] {
  const found: string[] = []
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { quoted = !quoted; continue }
    if (c === '%' || c === '!') found.push(`${c} at ${i}`)
    else if (/\p{Cc}/u.test(c)) found.push(`control at ${i}`)
    else if (!quoted && '&|<>^()'.includes(c)) found.push(`${c} at ${i}`)
  }
  return found
}

/** The JSON Claude Code gets when PowerShell starts `program` with
 *  `--agents <value> --settings <path>` written by `bind`: read by `parse` for
 *  an .exe; for a batch launcher, first checked as cmd.exe reads it, then by
 *  the shim's program (node, the C runtime rule). */
function arrives(program: string, value: string, bind: (v: string) => string, parse: (t: string) => string[]): string {
  const rest = `--agents ${bind(value)} --settings ${bind(SETTINGS)}`
  if (/\.(cmd|bat)$/i.test(program)) expect(cmdSyntaxIn(rest), rest).toEqual([])
  const argv = parse(rest)
  expect(argv, rest).toHaveLength(4)
  expect(argv[0]).toBe('--agents')
  expect(argv[2]).toBe('--settings')
  expect(argv[3]).toBe(SETTINGS)
  return argv[1]
}

/** A small seeded generator, so the corpus is the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const POOL = ['"', BS, BS + BS, BS + '"', '%', '%PATH%', '!', '!x!', '&', '|', '<', '>', '^', '(', ')', ' ', '  ', '\t', '\n', 'a', 'Z', '0',
  '\u00e9', '\u4e2d', '\u{1F600}', '\u007f', '\u0085', "'", '`', '$', ',', ':', '{', '}', '[', ']', '=', '-', '/', '""', '\u2019', '\u00a0']
function corpus(seed: number, n: number): Template[][] {
  const r = seeded(seed)
  const text = (): string => { let s = ''; const k = Math.floor(r() * 9); for (let i = 0; i < k; i++) s += POOL[Math.floor(r() * POOL.length)]; return s }
  const out: Template[][] = []
  for (let i = 0; i < n; i++) {
    const set: Template[] = []
    const k = 1 + Math.floor(r() * 3)
    for (let j = 0; j < k; j++) set.push({ name: text(), description: text(), prompt: text(), ...(r() < 0.3 ? { tools: [text(), text()] } : {}) })
    out.push(set)
  }
  return out
}

// ---- the value ------------------------------------------------------------

describe('agentsEnvValue: the templates come out exactly, whatever reads the line', () => {
  const sets = [TEMPLATES, ...TEMPLATES.map((t) => [t]), ...corpus(20261009, 400)].map(asObject)

  for (const program of [EXE, `${EXE}. `, 'C:/x/CLAUDE.EXE']) {
    it(`an .exe started directly (${program}): every binder, every parser`, () => {
      for (const set of sets) {
        const value = agentsEnvValue(set, program)
        for (const [b, bind] of Object.entries(BINDERS)) {
          for (const [p, parse] of Object.entries(PARSERS)) {
            const got = arrives(program, value, bind, parse)
            expect(JSON.parse(got), `${b} / ${p}: ${value}`).toEqual(set)
          }
        }
      }
    })
  }

  for (const program of [CMD, BAT, 'node', 'claude', 'C:/x/claude.com']) {
    it(`${program}: cmd.exe finds nothing to run or expand, and the C runtime reads the templates`, () => {
      for (const set of sets) {
        const value = agentsEnvValue(set, program)
        for (const [b, bind] of Object.entries(BINDERS)) {
          // Never wrapped again: its whitespace is all inside its own quotes.
          expect(bind(value), b).toBe(value)
          // cmdSyntaxIn is checked for a batch file inside arrives; a program
          // found by name (node, claude) may be one, so it is checked here too.
          expect(cmdSyntaxIn(`--agents ${value}`), value).toEqual([])
          const got = arrives(program, value, bind, crt)
          expect(JSON.parse(got), `${b}: ${value}`).toEqual(set)
        }
      }
    })
  }

  it('is never the doubled form for an .exe, and never the backslash form for anything else', () => {
    const exe = agentsEnvValue(asObject(TEMPLATES), EXE)
    const other = agentsEnvValue(asObject(TEMPLATES), CMD)
    expect(exe.endsWith(' ')).toBe(true)
    expect(exe).not.toContain('""')
    expect(other.startsWith('"') && other.endsWith('"')).toBe(true)
    expect(other).not.toContain(`${BS}"`)
    // Each form is for its own readers only: cmd.exe finds syntax outside its
    // quotes in the backslash form, and CommandLineToArgvW splits the doubled form.
    expect(cmdSyntaxIn(`--agents ${BINDERS['Windows PowerShell 5.1'](exe)}`)).not.toEqual([])
    // The doubled form read by CommandLineToArgvW splits.
    expect(PARSERS.CommandLineToArgvW(`--agents ${other}`).length).toBeGreaterThan(2)
  })

  it('holds no character cmd.exe expands and no control character, and no quote after a backslash', () => {
    for (const set of sets) {
      for (const program of [EXE, CMD]) {
        const value = agentsEnvValue(set, program)
        expect(value, value).not.toMatch(/[%!\p{Cc}]/u)
        if (program === CMD) expect(value).not.toContain(`${BS}"`)
        // The .exe form's own `\"` is the only backslash before a quote.
        else expect(value).not.toContain(`${BS}${BS}"`)
      }
    }
  })

  it('a value without " % ! a control character or a string ending in \\ reaches Claude Code as JSON.stringify wrote it', () => {
    const plain = { reviewer: { description: 'checks (a) & (b) | c > d < e ^ f', prompt: `caf\u00e9 \u4e2d\u6587 \u{1F600} in C:${BS}temp${BS}x and ${BS}${BS}srv${BS}y`, tools: ['Bash'] } }
    const json = JSON.stringify(plain)
    const bind = BINDERS['Windows PowerShell 5.1']
    expect(arrives(EXE, agentsEnvValue(plain, EXE), bind, crt)).toBe(`${json} `)
    expect(arrives(CMD, agentsEnvValue(plain, CMD), bind, crt)).toBe(json)
    expect(arrives('node', agentsEnvValue(plain, 'node'), bind, crt)).toBe(json)
  })

  it('a quote, % and !, and a backslash that ends a string, are written as \\u escapes inside the strings, nothing else changes', () => {
    const got = arrives(CMD, agentsEnvValue({ [`k"${BS}`]: `a"b${BS}c%d!e${BS}` }, CMD), BINDERS['Windows PowerShell 5.1'], crt)
    expect(got).toBe(`{"k${BS}u0022${BS}u005c":"a${BS}u0022b${BS}${BS}c${BS}u0025d${BS}u0021e${BS}u005c"}`)
    expect(JSON.parse(got)).toEqual({ [`k"${BS}`]: `a"b${BS}c%d!e${BS}` })
  })

  it('the 5.1 binder model hands a program JSON written on the line itself without its double quotes', () => {
    // The binder model given JSON as text on the line. The templates ride the
    // environment so that Claude Code gets them whole.
    const json = JSON.stringify([TEMPLATES[0]])
    const got = crt(`--agents ${BINDERS['Windows PowerShell 5.1'](json)}`)
    expect(got[1]).toBe('[{name:reviewer,description:checks (a) & (b) | c > d < e ^ f,prompt:review it, then say done}]')
  })
})

// ---- the line ---------------------------------------------------------------

const BASE = { cwd: 'C:/work', claudeBin: EXE, extraFlags: ` --settings ${quoteArgForShell(SETTINGS, true)}`, agentsFlag: '', useResumePicker: false, pickerScript: null as string | null }
const LEAD = "$PSNativeCommandArgumentPassing = 'Legacy'; "

describe('the Windows launch line names the variable, never the templates', () => {
  it('names the fixed variable, braced', () => {
    expect(AGENTS_ENV).toBe('CCC_AGENTS')
    expect(agentsRef()).toBe('${env:CCC_AGENTS}')
    expect(PS_LEGACY_ARGUMENT_PASSING).toBe("$PSNativeCommandArgumentPassing = 'Legacy'")
  })

  it('on every route: direct, resume picker, picker fallback, exact resume, Ask', () => {
    const s = ` --settings '${SETTINGS}'`
    expect(buildClaudeLaunchCommand({ ...BASE, platform: 'win32', agentsFromEnv: true }))
      .toBe(`${LEAD}Set-Location 'C:/work'; & '${EXE}' --agents \${env:CCC_AGENTS}${s}; exit`)
    expect(buildClaudeLaunchCommand({ ...BASE, platform: 'win32', agentsFromEnv: true, useResumePicker: true, pickerScript: PICKER, userArgs: '--verbose' }))
      .toBe(`${LEAD}Set-Location 'C:/work'; node '${PICKER}' --agents \${env:CCC_AGENTS}${s} '--verbose'; exit`)
    expect(buildClaudeLaunchCommand({ ...BASE, platform: 'win32', agentsFromEnv: true, useResumePicker: true, pickerScript: null }))
      .toBe(`${LEAD}Set-Location 'C:/work'; & '${EXE}' --agents \${env:CCC_AGENTS}${s}; exit`)
    expect(buildClaudeLaunchCommand({ ...BASE, platform: 'win32', agentsFromEnv: true, useResumePicker: true, pickerScript: PICKER, resumeUuid: UUID }))
      .toBe(`${LEAD}Set-Location 'C:/work'; & '${EXE}' --resume ${UUID} --agents \${env:CCC_AGENTS}${s}; exit`)
    expect(buildClaudeLaunchCommand({ ...BASE, platform: 'win32', agentsFromEnv: true, askPrompt: true }))
      .toBe(`${LEAD}Set-Location 'C:/work'; & '${EXE}' --agents \${env:CCC_AGENTS}${s} -- $env:CCC_ASK_PROMPT; exit`)
  })

  it('carries no template text even when a caller hands the flag text over', () => {
    expect(() => buildClaudeLaunchCommand({ ...BASE, platform: 'win32', agentsFromEnv: true, agentsFlag: ` --agents '${JSON.stringify(TEMPLATES)}'` }))
      .toThrow(/exclusive/)
  })

  it('a Windows line without templates is byte-identical to before', () => {
    expect(buildClaudeLaunchCommand({ ...BASE, platform: 'win32' })).toBe(`Set-Location 'C:/work'; & '${EXE}' --settings '${SETTINGS}'; exit`)
    expect(buildClaudeLaunchCommand({ ...BASE, platform: 'win32', agentsFromEnv: false })).toBe(`Set-Location 'C:/work'; & '${EXE}' --settings '${SETTINGS}'; exit`)
  })

  it('off Windows the templates stay on the line, single-quoted, byte-identical to before', () => {
    const json = JSON.stringify(TEMPLATES)
    const flag = ` --agents ${quoteArgForShell(json, false)}`
    const posix = { ...BASE, platform: 'posix', claudeBin: 'claude', extraFlags: " --settings '/s.json'", agentsFlag: flag }
    expect(buildClaudeLaunchCommand(posix)).toBe(`cd 'C:/work' && 'claude'${flag} --settings '/s.json'; exit`)
    // The Windows-only switch changes nothing there.
    expect(buildClaudeLaunchCommand({ ...posix, agentsFromEnv: true })).toBe(buildClaudeLaunchCommand(posix))
    expect(buildClaudeLaunchCommand({ ...posix, useResumePicker: true, pickerScript: '/r/resume-picker.js' }))
      .toBe(`cd 'C:/work' && node '/r/resume-picker.js'${flag} --settings '/s.json'; exit`)
  })
})

describe('the value is written for the program the line starts', () => {
  const routes = [
    { useResumePicker: true, pickerScript: PICKER, resumeUuid: undefined, program: 'node' },
    { useResumePicker: true, pickerScript: null, resumeUuid: undefined, program: CMD },
    { useResumePicker: true, pickerScript: PICKER, resumeUuid: UUID, program: CMD },
    { useResumePicker: false, pickerScript: PICKER, resumeUuid: undefined, program: CMD },
  ]
  it('node for the resume picker, Claude Code itself otherwise, as the line starts it', () => {
    for (const r of routes) {
      const opts = { ...BASE, claudeBin: CMD, platform: 'win32', agentsFromEnv: true, ...r }
      expect(claudeLaunchProgram(opts)).toBe(r.program)
      const line = buildClaudeLaunchCommand(opts)
      expect(launchStartsPicker(opts)).toBe(line.includes(`; node '${PICKER}'`))
      expect(line.includes(`& '${CMD}'`)).toBe(r.program === CMD)
    }
  })
})

// ---- the session environment ------------------------------------------------

describe('buildClaudeLocalSpawn: an inherited value reaches no session', () => {
  const source = { SystemRoot: `C:${BS}Windows`, PATH: `C:${BS}Windows${BS}System32`, SHELL: '/bin/bash', CCC_AGENTS: '"[]"', ccc_agents: 'x', Ccc_Agents: 'y', KEEP: '1' }
  it('a terminal tab', () => {
    const { env } = buildClaudeLocalSpawn({ sessionId: 's1', shellOnly: true, cols: 80, rows: 24 }, source)
    expect(Object.keys(env).filter((k) => k.toUpperCase() === AGENTS_ENV)).toEqual([])
    expect(env.KEEP).toBe('1')
  })
  it.runIf(process.platform === 'win32')('a Claude session (Windows), templates or not: pty-manager sets the value', () => {
    const { env } = buildClaudeLocalSpawn({ sessionId: 's2', cols: 80, rows: 24, agentsConfig: [{ name: 'a', description: 'b', prompt: 'c' }] }, source)
    expect(Object.keys(env).filter((k) => k.toUpperCase() === AGENTS_ENV)).toEqual([])
  })
})

// ---- the resume picker --------------------------------------------------------

describe('the resume picker passes the value it got on to Claude Code unchanged', () => {
  const ENV = { SystemRoot: `C:${BS}Windows` }
  // The argument the picker got: the C runtime's reading of the doubled form.
  const got = arrives('node', agentsEnvValue(asObject(TEMPLATES), 'node'), BINDERS['Windows PowerShell 5.1'], crt)
  const args = ['--agents', got, '--settings', SETTINGS]

  it('to a native Claude Code: the same argument array, no shell', () => {
    const t = picker.buildSpawnTarget(EXE, args, 'win32', ENV)!
    expect(t).toEqual({ file: EXE, argv: args, verbatim: false })
  })

  it('to an npm Claude Code: started, every cmd.exe character inside quotes, the same arguments', () => {
    // A template holding % starts on this route: the value holds its % as a
    // \u escape.
    const t = picker.buildSpawnTarget(CMD, args, 'win32', ENV)
    expect(t).not.toBeNull()
    const body = t!.argv[4].slice(1, -1)
    const rest = body.slice(body.indexOf('"', 1) + 1)
    expect(cmdSyntaxIn(rest)).toEqual([])
    const argv = crt(rest)
    expect(argv).toEqual(args)
    expect(JSON.parse(argv[1])).toEqual(asObject(TEMPLATES))
  })
})

// ---- the shape Claude Code takes -----------------------------------------------

describe('claudeAgentsObject: the one object keyed by agent name that Claude Code takes', () => {
  const ok = { description: 'd', prompt: 'p' }

  it('each name holds its description, prompt, model and tools as written, names in the order given', () => {
    const odd = `q"uote %PATH% !x! ${BS} \u4e2d`
    const o = claudeAgentsObject([
      { name: 'reviewer', description: 'checks', prompt: 'review it', model: 'opus[1m]', tools: ['Read', 'Bash'] },
      { name: odd, description: ' ', prompt: '' },
      { name: 'Reviewer', ...ok },
    ])
    expect(Object.keys(o)).toEqual(['reviewer', odd, 'Reviewer'])
    expect(o).toEqual({ reviewer: { description: 'checks', prompt: 'review it', model: 'opus[1m]', tools: ['Read', 'Bash'] }, [odd]: { description: ' ', prompt: '' }, Reviewer: ok })
    // Claude Code's own example of its --agents value (claude --help).
    expect(JSON.stringify(claudeAgentsObject([{ name: 'reviewer', description: 'Reviews code', prompt: 'You are a code reviewer' }])))
      .toBe('{"reviewer":{"description":"Reviews code","prompt":"You are a code reviewer"}}')
  })

  it('each name holds its description and prompt, and its model and tools when given; nothing else', () => {
    const o = claudeAgentsObject([{ name: 'a', description: 'd', prompt: 'p', model: 'sonnet', tools: ['Read'], permissionMode: 'bypassPermissions', hooks: {}, mcpServers: [], isolation: 'worktree' } as unknown as ClaudeAgentTemplate])
    expect(o).toEqual({ a: { description: 'd', prompt: 'p', model: 'sonnet', tools: ['Read'] } })
    expect(Object.keys(o.a)).toEqual(['description', 'prompt', 'model', 'tools'])
  })

  it('a name such as __proto__ is a key of the object like any other', () => {
    expect(JSON.stringify(claudeAgentsObject([{ name: '__proto__', ...ok }, { name: 'b', ...ok }])))
      .toBe('{"__proto__":{"description":"d","prompt":"p"},"b":{"description":"d","prompt":"p"}}')
  })

  it('refuses a set Claude Code would not take, naming the template by its place in the list', () => {
    const cases: Array<[ClaudeAgentTemplate[], string]> = [
      [[{ name: 'a', ...ok }, { name: '', ...ok }], 'template 2 has no name.'],
      [[{ name: '-x', ...ok }], 'the name of template 1 starts with a hyphen.'],
      [[{ name: 'a', ...ok }, { name: 'b', ...ok }, { name: 'a', ...ok }], 'templates 1 and 3 have the same name.'],
      [[{ name: 'a', ...ok }, { name: 'b', description: '', prompt: 'p' }], 'template 2 has no description.'],
      [[{ name: 'a', ...ok, model: ' \t ' }], 'template 1 names a blank model.'],
    ]
    for (const [set, why] of cases) expect(() => claudeAgentsObject(set)).toThrow(`Cannot start Claude Code with these agent templates: ${why}`)
    expect(() => claudeAgentsObject([{ name: 'a-b', ...ok, model: 'sonnet' }])).not.toThrow()
  })
})

// ---- the command line's length ---------------------------------------------------

describe('a Windows line whose program would be handed too long a command line is refused', () => {
  const opts = (claudeBin: string, picker: boolean, agentsValueLength?: number) => ({
    ...BASE, platform: 'win32' as const, claudeBin, agentsFromEnv: true, agentsValueLength, useResumePicker: picker, pickerScript: picker ? PICKER : null,
  })
  /** The program and its arguments on the line, as the builder measures them. */
  const runOf = (line: string): string => line.slice(`${LEAD}Set-Location 'C:/work'; `.length, -'; exit'.length)

  it('the limit is that of the program the line starts: 32766 for an .exe, 8191 (cmd.exe) for the rest', () => {
    expect(windowsCommandLineLimit(EXE)).toBe(32_766)
    expect(windowsCommandLineLimit(`${EXE}. `)).toBe(32_766)
    for (const p of [CMD, BAT, 'node', 'claude', 'C:/x/claude.com']) expect(windowsCommandLineLimit(p)).toBe(8_191)
  })

  for (const [what, bin, picker, limit, npm] of [
    ['npm\'s launcher', CMD, false, 8_191, true],
    ['a .bat launcher', BAT, false, 8_191, true],
    ['the resume picker', EXE, true, 8_191, false],
    ['claude.exe', EXE, false, 32_766, false],
  ] as const) {
    it(`${what}: up to its limit the line is the plain one; one character over, it is refused with the reason`, () => {
      const plain = buildClaudeLaunchCommand(opts(bin, picker))
      const most = limit - (runOf(plain).length - agentsRef().length + AGENTS_LAUNCHER_ROOM + (limit === 8_191 ? bin.length : 0))
      expect(buildClaudeLaunchCommand(opts(bin, picker, most))).toBe(plain)
      const refusal = (): string => buildClaudeLaunchCommand(opts(bin, picker, most + 1))
      expect(refusal).toThrow(`Cannot start Claude Code with these agent templates: they make Claude Code's command line about ${limit + 1} characters long, and Windows allows ${limit} there. Shorten the templates${npm ? ', or install the native Claude Code' : ''}.`)
    })
  }

  it('an exact resume is measured for Claude Code, which the line starts', () => {
    const plain = buildClaudeLaunchCommand({ ...opts(EXE, true), resumeUuid: UUID })
    expect(plain).toContain(`& '${EXE}' --resume ${UUID}`)
    expect(buildClaudeLaunchCommand({ ...opts(EXE, true, 20_000), resumeUuid: UUID })).toBe(plain)
    // The same value for the resume picker, which may start npm's launcher.
    expect(() => buildClaudeLaunchCommand(opts(EXE, true, 20_000))).toThrow('and Windows allows 8191 there. Shorten the templates.')
  })

  it('without the length of the value, or off Windows, nothing is measured', () => {
    expect(buildClaudeLaunchCommand(opts(CMD, false, undefined))).toBe(buildClaudeLaunchCommand(opts(CMD, false)))
    const posix = { ...opts(CMD, false, 1_000_000), platform: 'posix' as const, claudeBin: 'claude' }
    expect(buildClaudeLaunchCommand(posix)).toBe("cd 'C:/work' && 'claude' --settings '" + SETTINGS + "'; exit")
  })
})
