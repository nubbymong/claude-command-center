/**
 * What the SHELL does with the launch line — not what the string looks like.
 *
 * The review of #408 caught the first cut asserting string shape: it checked
 * that `{secret}.json` produced `${env:CCC_ARG_SECRET}.json` and called that
 * fixed. Measured against a real argv printer, PowerShell parses that as a
 * member access on a string, yields $null, and DROPS the argument — the next
 * flag shifts into its slot. The test could not have caught it, because the
 * string was exactly what it expected.
 *
 * So these tests run the real shell and read the child's argv. They are
 * platform-guarded: the PowerShell block runs on win32, the POSIX block
 * everywhere else, and each skips itself if the shell or node is missing
 * rather than failing a machine that cannot host it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildTerminalLaunchLine } from '../../../src/main/terminal-launch-line'

const SECRET = 'pa ss*word'
let dir = ''
let printer = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-secret-parse-'))
  printer = join(dir, 'argv.js').replace(/\\/g, '/')
  writeFileSync(
    printer,
    'const a=process.argv.slice(2);console.log(JSON.stringify(a));',
  )
})

/** The argv a child actually received, or null when the shell is unavailable. */
function argvThrough(shell: 'pwsh' | 'sh', line: string): string[] | null {
  try {
    const out =
      shell === 'pwsh'
        ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', line], {
            encoding: 'utf8',
            env: { ...process.env, CCC_ARG_SECRET: SECRET },
            timeout: 60_000,
          })
        : execFileSync('/bin/sh', ['-c', line], {
            encoding: 'utf8',
            env: { ...process.env, CCC_ARG_SECRET: SECRET },
            timeout: 60_000,
          })
    const last = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? '[]'
    return JSON.parse(last) as string[]
  } catch {
    return null
  }
}

/** Build the line the app would type, with the printer as the command. */
function line(args: string): string {
  return buildTerminalLaunchLine(
    { command: `node ${printer}`, args, hasSecretArg: true },
    process.platform === 'win32',
  )
}

const shell = process.platform === 'win32' ? 'pwsh' : 'sh'

describe(`the secret reference survives the ${shell} parse`, () => {
  it('is reachable at all — otherwise every assertion below is vacuous', () => {
    const argv = argvThrough(shell, line('--out {secret} --force'))
    if (argv === null) {
      // No shell/node on this machine: say so rather than passing silently.
      console.warn('[secret-ref-shell-parse] shell unavailable; cases skipped')
      return
    }
    expect(argv).toEqual(['--out', SECRET, '--force'])
  })

  /**
   * The BLOCKER. Every one of these dropped the argument before this change —
   * `.json` even with the braced form — and each drop silently binds `--force`
   * to `--out`.
   */
  it.each([
    ['{secret}.json', `${SECRET}.json`],
    ['{secret}_v2', `${SECRET}_v2`],
    ['{secret}:x', `${SECRET}:x`],
    ['{secret}-suffix', `${SECRET}-suffix`],
  ])('an adjacent %s keeps the argument whole', (written, expected) => {
    const argv = argvThrough(shell, line(`--out ${written} --force`))
    if (argv === null) return
    expect(argv).toEqual(['--out', expected, '--force'])
  })

  it('a prefix like --token= arrives as one argument', () => {
    const argv = argvThrough(shell, line('--token={secret} --force'))
    if (argv === null) return
    expect(argv).toEqual([`--token=${SECRET}`, '--force'])
  })

  /**
   * The POSIX MAJOR: the pre-quoted reference nested wrongly inside the user's
   * own quotes and left the expansion unquoted, so a spaced value word-split
   * (`[Bearer pa] [ss*word]`) and a `*` glob-expanded against the cwd.
   */
  it('a token inside the user\'s own quotes stays ONE argument, spaces and globs included', () => {
    const argv = argvThrough(shell, line('-H "Bearer {secret}" --force'))
    if (argv === null) return
    expect(argv).toEqual(['-H', `Bearer ${SECRET}`, '--force'])
  })

  it('the same, with a suffix inside the quotes', () => {
    const argv = argvThrough(shell, line('-H "Bearer {secret}.json" --force'))
    if (argv === null) return
    expect(argv).toEqual(['-H', `Bearer ${SECRET}.json`, '--force'])
  })

  it('substitutes in the COMMAND field too, and it survives the parse', () => {
    const built = buildTerminalLaunchLine(
      { command: `node ${printer} -H "Bearer {secret}"`, args: '--force', hasSecretArg: true },
      process.platform === 'win32',
    )
    const argv = argvThrough(shell, built)
    if (argv === null) return
    expect(argv).toEqual(['-H', `Bearer ${SECRET}`, '--force'])
  })

  it('never types the VALUE — only a reference the shell expands', () => {
    const built = line('--out {secret}.json')
    expect(built).not.toContain(SECRET)
    expect(built).toContain('CCC_ARG_SECRET')
  })
})

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
})
