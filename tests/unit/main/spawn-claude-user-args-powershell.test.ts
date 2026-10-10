// HOST QUARANTINE: starts real processes (Windows PowerShell 5.1 and node). [CI] [VM] only -- never run on the owner's machine.
// A Claude Code session's extra CLI arguments reach Claude Code exactly as
// written on Windows, where PowerShell reads the launch line. Every value of a
// generated corpus that the session's rule takes (claudeExtraArgsProblem) is
// placed on the launch line the app builds (buildClaudeLaunchCommand) after a
// stand-in program that prints the arguments it got, and the line is run by
// Windows PowerShell 5.1, the session's shell. The program must get the typed
// words, one argument each, nothing more and nothing changed. A fake program
// only (node printing its argv, in a temporary folder, a fresh environment);
// no Claude Code, no app. Windows only.
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { claudeExtraArgsProblem } from '../../../src/shared/extra-args'
import { buildClaudeLaunchCommand, quoteArgForShell } from '../../../src/main/spawn-claude-command'
import { isolatedProbeEnv } from '../../helpers/home-guard-core.mjs'

const BS = String.fromCharCode(92)
const SYSROOT = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
const POWERSHELL = path.join(SYSROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const onWindows = process.platform === 'win32' && fs.existsSync(POWERSHELL)

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
/** Pieces PowerShell gives a meaning outside quotes (a comma, a number with a
 *  size suffix, a hex number, a leading dash or plus) mixed with option and
 *  command names. */
const PIECES = ['-', '--', BS, BS + BS, '=', ',', '.', '/', ':', '@', '+', '_', 'resume', 'Resume', 'r', 'c', 'p', 'w', 'model', 'settings',
  'x', '1', 'a', 'add-dir', 'continue', 'print', 'dangerously-skip-permissions', 'permission-mode', 'debug', 'd', 'mcp', 'cc', 'C', '0x2d',
  '1kb', '..', 'name', 'rc', '2e3']
function corpus(seed: number, n: number): string[] {
  const r = seeded(seed)
  const out = new Set<string>()
  for (let tries = 0; out.size < n && tries < 400000; tries++) {
    const words: string[] = []
    const nw = 1 + Math.floor(r() * 3)
    for (let i = 0; i < nw; i++) {
      let w = ''
      const np = 1 + Math.floor(r() * 5)
      for (let j = 0; j < np; j++) w += PIECES[Math.floor(r() * PIECES.length)]
      words.push(w)
    }
    const v = words.join(' ')
    if (claudeExtraArgsProblem(v) === null) out.add(v)
  }
  return [...out]
}
/** Hand-made values on top: a comma inside a word, numbers PowerShell would
 *  read as numbers, a value after an = sign that looks like an option. */
const HAND = ['x,--resume', '.,--resume', '--add-dir=.,--resume', '--allowedTools=Bash,Edit', '--debug=api,hooks', '1,2', '1kb', '0x2d',
  '1kb,resume', '--debug=--resume', `.${BS}--resume`, '+--resume', '=resume', 'a@b', '--name=a:b', '--add-dir C:\\Users\\me\\x', '2e3', '-d']

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-user-args-ps-'))
afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }) })
const ECHO = path.join(ROOT, 'echo-argv.cjs')
fs.writeFileSync(ECHO, "process.stdout.write('ARGV=' + JSON.stringify(process.argv.slice(2)) + '\\n')\n")

/** The line the app builds for `userArgs`, with the stand-in program as Claude
 *  Code and its script as the app's own options; the closing `; exit` left
 *  off so one PowerShell runs every line. */
function launchLine(userArgs: string): string {
  const line = buildClaudeLaunchCommand({
    platform: 'win32', cwd: ROOT, claudeBin: process.execPath, extraFlags: ` ${quoteArgForShell(ECHO, true)}`,
    agentsFlag: '', useResumePicker: false, pickerScript: null, userArgs,
  })
  if (!line.endsWith('; exit')) throw new Error(`unexpected line: ${line}`)
  return line.slice(0, -'; exit'.length)
}

/** Each value's arguments as the program got them, in order; null when the
 *  line started nothing. */
function runInPowerShell(values: string[]): Array<string[] | null> {
  const script = values.map((v, i) => `Write-Output 'IDX=${i}'\r\n${launchLine(v)}`).join('\r\n') + '\r\n'
  const file = path.join(ROOT, `lines-${Date.now()}.ps1`)
  fs.writeFileSync(file, script)
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    { env: isolatedProbeEnv(ROOT), encoding: 'utf8', timeout: 600_000, windowsHide: true })
  const got: Array<string[] | null> = values.map(() => null)
  let at = -1
  for (const l of (r.stdout || '').split(/\r?\n/)) {
    if (l.startsWith('IDX=')) at = Number(l.slice(4))
    else if (l.startsWith('ARGV=') && at >= 0) got[at] = JSON.parse(l.slice(5)) as string[]
  }
  return got
}

describe.runIf(onWindows)('Windows PowerShell 5.1 hands Claude Code the extra arguments exactly as written', () => {
  it('every value the rule takes: the typed words, one argument each', () => {
    const values = [...HAND.filter((v) => claudeExtraArgsProblem(v) === null), ...corpus(20261008, 300)]
    expect(values.length).toBeGreaterThan(250)
    const got = runInPowerShell(values)
    const mismatches = values
      .map((v, i) => ({ typed: v, want: v.split(' ').filter((w) => w !== ''), got: got[i] }))
      .filter((x) => JSON.stringify(x.got) !== JSON.stringify(x.want))
    // The program got exactly the words the rule checked: none it would refuse.
    expect(mismatches).toEqual([])
  }, 600_000)

  it('a word the rule refuses for its comma would still reach the program as written, one argument', () => {
    const values = [',--resume', ',--permission-mode=bypassPermissions', 'x, .', ',,-p']
    for (const v of values) expect(claudeExtraArgsProblem(v), v).not.toBeNull()
    expect(runInPowerShell(values)).toEqual(values.map((v) => v.split(' ').filter((w) => w !== '')))
  }, 120_000)
})
