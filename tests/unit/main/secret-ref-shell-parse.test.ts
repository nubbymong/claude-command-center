// HOST QUARANTINE: starts real processes. [CI] [VM] only -- never run on the owner's machine.
/**
 * What the SHELL does with the launch line — not what the string looks like.
 *
 * Four rounds of review landed here, each closing the reported adjacency and
 * leaving the next one open, because the logic was a DENYLIST of unsafe shapes.
 * This is the ALLOWLIST version: a `{secret}` is substituted only when its word
 * is genuinely simple and NOT in a command position; everything else — any
 * escape on the line, any separator adjacency, any command position in any
 * field, single quotes, a token just outside a closed quote, an unbalanced
 * quote — is left LITERAL and reported so Save is blocked. The token never
 * carries a value; only a reference the shell expands does.
 *
 * Every substituting case runs a REAL shell and reads the child's argv, on
 * Windows PowerShell 5.1 AND PowerShell 7 (different parsers) and on POSIX sh.
 * The assertion that matters most is the negative: the VALUE must never appear
 * as its own argument, and must never appear in the emitted line at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildTerminalLaunchLine } from '../../../src/main/terminal-launch-line'
import { secretPlacementProblem } from '../../../src/shared/command-secret'

/** Spaced and globbing, so word-splitting shows up as extra argv entries. */
const SECRET = 'pa ss*word'
const isWin = process.platform === 'win32'
let dir = ''
let printer = ''

type Shell = { name: string; exe: string; argsFor: (line: string) => string[] }

const CANDIDATES: Shell[] = isWin
  ? [
      { name: 'powershell 5.1', exe: 'powershell.exe', argsFor: (l) => ['-NoProfile', '-NonInteractive', '-Command', l] },
      { name: 'pwsh 7', exe: 'pwsh.exe', argsFor: (l) => ['-NoProfile', '-NonInteractive', '-Command', l] },
    ]
  : [{ name: 'sh', exe: '/bin/sh', argsFor: (l) => ['-c', l] }]

/** Shells that actually run here — probed ONCE, so a case can never pass by
 *  silently skipping. A shell that is absent is dropped from the matrix with a
 *  warning; if NONE run, the suite fails rather than proving nothing. */
const runnable: Shell[] = []

function runArgv(shell: Shell, line: string): string[] {
  const out = execFileSync(shell.exe, shell.argsFor(line), {
    encoding: 'utf8',
    env: { ...process.env, CCC_ARG_SECRET: SECRET },
    timeout: 60_000,
  })
  const last = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? '[]'
  return JSON.parse(last) as string[]
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-secret-parse-'))
  printer = join(dir, 'argv.js').replace(/\\/g, '/')
  writeFileSync(printer, 'console.log(JSON.stringify(process.argv.slice(2)));')
  for (const c of CANDIDATES) {
    try {
      const argv = runArgv(c, `node ${printer} ok`)
      if (Array.isArray(argv) && argv[0] === 'ok') runnable.push(c)
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[secret-ref-shell-parse] ${c.name} not available on this runner; dropped from the matrix`)
    }
  }
})

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
})

/** The line the app would type, with the printer as the program. */
const line = (command: string, args = '') =>
  buildTerminalLaunchLine({ command: `node ${printer} ${command}`.trim(), args, hasSecretArg: true }, isWin)

it('at least one real shell runs — otherwise every shell assertion is vacuous', () => {
  expect(runnable.length).toBeGreaterThan(0)
})

/**
 * SAFE placements: the reference expands to exactly the intended one argument on
 * every runnable shell, and the raw VALUE is never in the line.
 */
describe('a reference in a safe placement survives the parse as one argument', () => {
  const SAFE: Array<[string, string[]]> = [
    ['--out {secret} --force', ['--out', SECRET, '--force']],
    ['--out {secret}.json --force', ['--out', `${SECRET}.json`, '--force']],
    ['--out {secret}_v2 --force', ['--out', `${SECRET}_v2`, '--force']],
    ['--token={secret} --force', [`--token=${SECRET}`, '--force']],
    ['-H "Bearer {secret}" --force', ['-H', `Bearer ${SECRET}`, '--force']],
  ]
  it.each(SAFE)('%s', (args, expected) => {
    const l = line('', args)
    expect(l).not.toContain(SECRET)
    expect(l).toContain('CCC_ARG_SECRET')
    for (const shell of runnable) {
      expect(runArgv(shell, l), `${shell.name}: ${args}`).toEqual(expected)
    }
  })
})

/**
 * UNSAFE placements: the token is left LITERAL (no reference, no value in the
 * line) and, when the line is nonetheless run, the value reaches no argument on
 * any shell. These are the five leaks the earlier denylist rounds each left open.
 */
describe('an unsafe placement never puts the value on the line or in an argument', () => {
  const UNSAFE: Array<[string, string, string]> = [
    // label, command-field text, arguments-field text
    ['a token after "; " in the arguments field', 'curl --out x', '; {secret}'],
    ['a token glued after ";" in the command field', 'cd .;{secret}', ''],
    ['a token after "|" ', 'echo hi | {secret}', ''],
    ['a token after a newline (a second command)', 'cd C:/repo\n{secret}', ''],
    ['an escaped quote elsewhere on the line', '-d \\"a\\" -H "Bearer {secret}" b', ''],
    ['a Windows path with a backslash before the token', '--out C:\\logs\\{secret}.json', ''],
    ['a token just outside a closed quote', '-H "Bearer"{secret}', ''],
    ['a single-quoted token', "-H 'Authorization: Bearer {secret}'", ''],
    ['a token as the whole command', '{secret}', '--x'],
  ]
  it.each(UNSAFE)('%s', (_label, command, args) => {
    const l = buildTerminalLaunchLine({ command, args, hasSecretArg: true }, isWin)
    // The security property: no reference and no value ever reach the line.
    expect(l).not.toContain(SECRET)
    expect(l).not.toContain('pa ss')
    expect(l).not.toContain('CCC_ARG_SECRET')
    expect(l).toContain('{secret}')
    // Running it anyway (with the literal token replaced by the printer so the
    // line executes) must never surface the value in an argument.
    const runnableLine = l.replace('{secret}', `node ${printer}`)
    for (const shell of runnable) {
      let argv: string[]
      try { argv = runArgv(shell, `${runnableLine} --force`) } catch { continue }
      expect(argv.join(' '), `${shell.name}: ${command} | ${args}`).not.toContain(SECRET)
      expect(argv.join(' '), `${shell.name}: ${command} | ${args}`).not.toContain('pa ss')
    }
  })
})

/**
 * Save is BLOCKED (a message is returned) for every unsafe placement, in both
 * fields — silently leaving a token literal would look like the feature is
 * broken. Field-agnostic: a token after a separator is a command position in the
 * arguments field too.
 */
describe('every unsafe placement is explained so Save is blocked', () => {
  it.each([
    ['-H "Bearer"{secret}', /just outside a quoted section/i],
    ["-H 'Bearer {secret}'", /single quotes/i],
    ['-H \\"Bearer {secret}\\"', /backslash|backtick|escape/i],
    ['-H `"Bearer {secret}`"', /backslash|backtick|escape/i],
    ['--out C:\\logs\\{secret}.json', /backslash|backtick|escape/i],
    ['"Bearer {secret}', /unclosed quote|balance the quotes/i],
  ])('%s is reported', (text, pattern) => {
    expect(secretPlacementProblem(text)).toMatch(pattern)
  })

  it.each([
    'cd .; {secret}',
    'cd .;{secret}',
    'echo hi | {secret}',
    'cd . && {secret}',
  ])('a token after a separator is reported in a command LINE: %s', (text) => {
    expect(secretPlacementProblem(text, { isCommandLine: true })).toMatch(/command position/i)
  })

  it.each([
    '--out x ; {secret}',
    '--out x |{secret}',
  ])('a token after a separator is reported in the ARGUMENTS field too: %s', (text) => {
    // No isCommandLine: this is an arguments field, yet a post-separator token is
    // still a command position and must be blocked.
    expect(secretPlacementProblem(text)).toMatch(/command position/i)
  })

  it('word 0 is a command position only in a command LINE', () => {
    expect(secretPlacementProblem('{secret} --x', { isCommandLine: true })).toMatch(/command position/i)
    // An arguments field is appended after a command, so its first word is just
    // another argument — reporting it there would be a false alarm.
    expect(secretPlacementProblem('{secret} --x')).toBeNull()
  })

  it('a safe placement reports nothing', () => {
    for (const ok of ['--out {secret}', '--out {secret}.json', '-H "Bearer {secret}"', 'curl --token={secret}']) {
      expect(secretPlacementProblem(ok), ok).toBeNull()
    }
  })
})
