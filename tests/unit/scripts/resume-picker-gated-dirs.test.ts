/**
 * A MANAGED launch hands the resume picker the directories its
 * project-settings gate checked (CCC_GATED_DIRS, set by pty-manager), and the
 * picker must not relaunch the CLI anywhere else: it retargets `claude` into
 * the chosen conversation's worktree in a grandchild process the in-process
 * directory asserts cannot see, so a worktree the gate never scanned was a
 * directory the CLI could run in, reading that worktree's own settings files
 * (adversarial final pass, MAJOR).
 *
 * The decision is a pure export, asserted here; so is the launch that acts on
 * it (exit on `refused`, before anything starts or is written), driven
 * through launchClaude with an injected spawn and exit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const picker = require('../../../scripts/resume-picker.js') as {
  gatedDirsFromEnv: (env: Record<string, string | undefined>) => string[] | null
  isGatedDir: (dir: string, gated: string[]) => boolean
  resolveRetargetCwd: (
    resumeId: string | null,
    sourceCwd: string | null,
    currentCwd: string,
    env: Record<string, string | undefined>,
    existsSync: (p: string) => boolean,
  ) => { cwd: string | null; refused?: string }
  encodeProjectPath: (p: string) => string
  displayPath: (raw: string, max?: number) => string
  launchClaude: (resumeId: string, sourceCwd: string, deps: {
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => { status: number | null }
    exit: (code: number) => void
    argv: string[]
    env: Record<string, string | undefined>
    platform: string
    isFile: (p: string) => boolean
  }) => void
}
const A = path.join(os.tmpdir(), 'gated-a')
const B = path.join(os.tmpdir(), 'gated-b')
const HERE = path.join(os.tmpdir(), 'gated-here')
const exists = () => true

describe('the picker honours the gated directory set of a managed launch', () => {
  it('reads the set from CCC_GATED_DIRS, and treats an absent or malformed value as "not managed"', () => {
    expect(picker.gatedDirsFromEnv({})).toBeNull()
    expect(picker.gatedDirsFromEnv({ CCC_GATED_DIRS: '' })).toBeNull()
    expect(picker.gatedDirsFromEnv({ CCC_GATED_DIRS: 'not json' })).toBeNull()
    expect(picker.gatedDirsFromEnv({ CCC_GATED_DIRS: '{"a":1}' })).toBeNull()
    expect(picker.gatedDirsFromEnv({ CCC_GATED_DIRS: JSON.stringify(['/a', 7, '', '/b']) })).toEqual(['/a', '/b'])
  })

  it('matches a directory by its resolved path, in either spelling on Windows', () => {
    expect(picker.isGatedDir(A, [A])).toBe(true)
    expect(picker.isGatedDir(path.join(A, '..', 'gated-a'), [A])).toBe(true)
    expect(picker.isGatedDir(B, [A])).toBe(false)
    if (process.platform === 'win32') {
      expect(picker.isGatedDir(A.toUpperCase(), [A])).toBe(true)
      expect(picker.isGatedDir(A.replace(/\\/g, '/'), [A])).toBe(true)
    }
  })

  it('retargets into a gated worktree, and REFUSES one the gate did not scan', () => {
    const env = { CCC_GATED_DIRS: JSON.stringify([HERE, A]) }
    expect(picker.resolveRetargetCwd('u1', A, HERE, env, exists)).toEqual({ cwd: A })
    expect(picker.resolveRetargetCwd('u1', B, HERE, env, exists)).toEqual({ cwd: null, refused: B })
    // The configured directory itself is never a retarget, gated or not.
    expect(picker.resolveRetargetCwd('u1', HERE, HERE, env, exists)).toEqual({ cwd: null })
    // No resume, or no source: inherit. A directory that is gone: inherit
    // (the fail-safe that predates the gate).
    expect(picker.resolveRetargetCwd(null, A, HERE, env, exists)).toEqual({ cwd: null })
    expect(picker.resolveRetargetCwd('u1', null, HERE, env, exists)).toEqual({ cwd: null })
    expect(picker.resolveRetargetCwd('u1', B, HERE, env, () => false)).toEqual({ cwd: null })
    expect(picker.resolveRetargetCwd('u1', B, HERE, env, () => { throw new Error('EACCES') })).toEqual({ cwd: null })
  })

  it('an UNMANAGED launch (no set) retargets as it always did', () => {
    expect(picker.resolveRetargetCwd('u1', B, HERE, {}, exists)).toEqual({ cwd: B })
  })

})

// The launch acts on that decision. launchClaude is driven with an injected
// spawn and exit (nothing starts, nothing exits); the transcript sits in the
// test's own isolated home.
describe('a launch acts on the gated directory set', () => {
  const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
  let root: string
  let wt: string
  let projectDir: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-gated-launch-'))
    wt = path.join(root, 'wt')
    fs.mkdirSync(wt)
    projectDir = path.join(os.homedir(), '.claude', 'projects', picker.encodeProjectPath(fs.realpathSync(wt)))
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${UUID}.jsonl`), '{}\n')
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
  })
  const launchFrom = (sourceCwd: string, gated: string[], over: { argv?: string[]; path?: string; isFile?: (p: string) => boolean } = {}) => {
    const calls: Array<{ file: string; opts: Record<string, unknown> }> = []
    const exits: number[] = []
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      picker.launchClaude(UUID, sourceCwd, {
        spawn: (file, _args, opts) => { calls.push({ file, opts }); return { status: 0 } },
        exit: (code) => { exits.push(code) },
        argv: over.argv ?? [],
        env: { CCC_GATED_DIRS: JSON.stringify(gated), SystemRoot: 'C:\\Windows', Path: over.path ?? 'C:\\native' },
        platform: 'win32',
        isFile: over.isFile ?? ((p) => p === 'C:\\native\\claude.exe'),
      })
      return { calls, exits, said: err.mock.calls.map((c) => String(c[0])).join('\n') }
    } finally {
      err.mockRestore()
    }
  }

  it('exits on a refusal BEFORE the spawn, and never falls back to the configured directory', () => {
    const refused = launchFrom(wt, [process.cwd()])
    expect(refused.calls).toEqual([])
    expect(refused.exits).toEqual([1])
    expect(refused.said).toContain('Not resuming in ')
    // The same worktree, gated: started there.
    const gated = launchFrom(wt, [process.cwd(), wt])
    expect(gated.calls).toHaveLength(1)
    expect(gated.calls[0].file).toBe('C:\\native\\claude.exe')
    expect(gated.calls[0].opts.cwd).toBe(wt)
    expect(gated.exits).toEqual([0])
  })

  it('decides the retarget BEFORE the companion directory is created, so a refusal leaves nothing on disk', () => {
    // A refused retarget used to be reached only after ensureCompanionDir had
    // run for the unscanned worktree's project key -- a durable directory
    // under ~/.claude/projects named for a folder the gate never checked
    // (adversarial confirmation pass, MINOR). The exit must come first.
    launchFrom(wt, [process.cwd()])
    expect(fs.existsSync(path.join(projectDir, UUID))).toBe(false)
    // Gated, the same launch does create it: the refusal is what kept it away.
    launchFrom(wt, [process.cwd(), wt])
    expect(fs.existsSync(path.join(projectDir, UUID, 'subagents'))).toBe(true)
  })

  it('a launch that starts nothing writes nothing for it: no companion directory', () => {
    // Claude Code in none of PATH's folders: refused, and nothing written.
    const missing = launchFrom(wt, [process.cwd(), wt], { isFile: () => false })
    expect(missing.calls).toEqual([])
    expect(missing.exits).toEqual([1])
    expect(missing.said).toContain('it was not found in a folder PATH names')
    expect(fs.existsSync(path.join(projectDir, UUID))).toBe(false)
    // An argument the npm launcher route cannot pass: refused, and nothing written.
    const refused = launchFrom(wt, [process.cwd(), wt], { path: 'C:\\npm', isFile: (p) => p === 'C:\\npm\\claude.cmd', argv: ['--model', '1%'] })
    expect(refused.calls).toEqual([])
    expect(refused.exits).toEqual([1])
    expect(refused.said).toContain('the value of --model holds')
    expect(fs.existsSync(path.join(projectDir, UUID))).toBe(false)
    // The same launch that does start writes it.
    launchFrom(wt, [process.cwd(), wt], { path: 'C:\\npm', isFile: (p) => p === 'C:\\npm\\claude.cmd', argv: ['--model', 'opus'] })
    expect(fs.existsSync(path.join(projectDir, UUID, 'subagents'))).toBe(true)
  })

  it('prints the refused directory through the spoof-safe strip, never raw', () => {
    // The message goes to the user's terminal at the moment they are told
    // something went wrong; a worktree name on Linux or macOS may carry ESC,
    // OSC or a bidi override (adversarial confirmation pass, MINOR).
    const esc = String.fromCharCode(27), osc = String.fromCharCode(0x9d), st = String.fromCharCode(0x9c)
    const evil = '/tmp/wt' + esc + '[2J' + esc + '[1;1H  Claude Code: sign in again at https://evil.example ' + esc + '[?25l'
    // Such a folder cannot be made on every system, so the existence check answers for it here.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs = require('fs') as typeof import('fs')
    const realExists = nodeFs.existsSync
    const exists = vi.spyOn(nodeFs, 'existsSync').mockImplementation((p) => p === evil || realExists(p))
    let said = ''
    try {
      const out = launchFrom(evil, [process.cwd()])
      expect(out.calls).toEqual([])
      expect(out.exits).toEqual([1])
      said = out.said
    } finally {
      exists.mockRestore()
    }
    expect(said).not.toContain(esc)
    expect(said).toContain('Not resuming in /tmp/wt')
    const shown = picker.displayPath(evil)
    expect(shown).not.toContain(esc)
    expect(shown).toContain('/tmp/wt')
    expect(picker.displayPath('a' + osc + 'b' + st + 'c')).toBe('a b c')
    expect(picker.displayPath('x' + String.fromCharCode(0x202e) + 'y' + String.fromCharCode(0x2028) + 'z' + String.fromCodePoint(0xe0041))).toBe('x y z ')
    // Cut on code points, not UTF-16 units: a surrogate pair at the boundary stays whole or goes whole.
    const long = 'a'.repeat(499) + String.fromCodePoint(0x1f600) + 'tail'
    const cut = picker.displayPath(long)
    expect(Array.from(cut).length).toBe(500)
    expect(cut.endsWith(String.fromCodePoint(0x1f600))).toBe(true)
    expect(picker.displayPath('/plain/path with spaces/ünïcödé')).toBe('/plain/path with spaces/ünïcödé')
  })
})
