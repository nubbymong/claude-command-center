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
import * as os from 'os'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const picker = require('../../../scripts/resume-picker.js')
const { buildSpawnTarget } = picker as {
  buildSpawnTarget: (cmd: string, args: string[]) => { file: string; argv: string[] }
}

const isWin = os.platform() === 'win32'

describe('buildSpawnTarget keeps arguments as argv elements', () => {
  it('passes a plain executable straight through', () => {
    const t = buildSpawnTarget('/usr/bin/claude', ['--model', 'opus'])
    expect(t.file).toBe('/usr/bin/claude')
    expect(t.argv).toEqual(['--model', 'opus'])
  })

  it('keeps a path containing spaces as ONE argv element', () => {
    const settings = 'C:\\Users\\me\\AppData\\Local\\Claude Command Center\\CONFIG\\s.json'
    const t = buildSpawnTarget('claude.exe', ['--settings', settings])
    expect(t.argv).toContain(settings)
    // The whole point: it must not have been split on the spaces.
    expect(t.argv.filter((a) => a.includes('Claude Command Center'))).toHaveLength(1)
  })

  it('keeps cmd.exe metacharacters inside a single argv element', () => {
    const hostile = '[{"name":"a","prompt":"x & whoami > C:\\\\tmp\\\\marker.txt"}]'
    const t = buildSpawnTarget('claude.exe', ['--agents', hostile])
    expect(t.argv).toEqual(['--agents', hostile])
    // Never collapsed into a command line.
    expect(t.argv.join(' ')).not.toBe(t.argv[0] + t.argv[1])
  })

  it.runIf(isWin)('routes a .cmd shim through cmd.exe with an ARGS ARRAY', () => {
    const t = buildSpawnTarget('C:\\npm\\claude.cmd', ['--model', 'opus[1m]'])
    expect(t.file).toBe('cmd.exe')
    expect(t.argv[0]).toBe('/c')
    expect(t.argv[1]).toBe('C:\\npm\\claude.cmd')
    // Arguments stay separate elements -- not concatenated into argv[1].
    expect(t.argv.slice(2)).toEqual(['--model', 'opus[1m]'])
  })

  it.runIf(isWin)('does NOT route a .exe through cmd.exe', () => {
    const t = buildSpawnTarget('C:\\bin\\claude.exe', ['--model', 'opus'])
    expect(t.file).toBe('C:\\bin\\claude.exe')
    expect(t.argv).toEqual(['--model', 'opus'])
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
