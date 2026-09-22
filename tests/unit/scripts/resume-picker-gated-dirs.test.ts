/**
 * A MANAGED launch hands the resume picker the directories its
 * project-settings gate checked (CCC_GATED_DIRS, set by pty-manager), and the
 * picker must not relaunch the CLI anywhere else: it retargets `claude` into
 * the chosen conversation's worktree in a grandchild process the in-process
 * directory asserts cannot see, so a worktree the gate never scanned was a
 * directory the CLI could run in, reading that worktree's own settings files
 * (adversarial final pass, MAJOR).
 *
 * The decision is a pure export, asserted here; its wiring at the spawn site
 * (exit on `refused`, before `spawnSync`) is pinned by the script's source,
 * because `main()` prompts on a TTY and cannot be driven in a unit test.
 */
import { describe, it, expect } from 'vitest'
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
}
const source = fs.readFileSync(path.join(__dirname, '../../../scripts/resume-picker.js'), 'utf8')
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

  it('exits on a refusal BEFORE the spawn, and never falls back to the configured directory', () => {
    const decision = source.indexOf('const retarget = resolveRetargetCwd(resumeId, sourceCwd, process.cwd(), process.env, fs.existsSync)')
    const spawn = source.indexOf('const result = spawnSync(target.file, target.argv, spawnOpts)')
    expect(decision, 'the spawn site does not consult resolveRetargetCwd').toBeGreaterThan(0)
    expect(decision).toBeLessThan(spawn)
    const between = source.slice(decision, spawn)
    expect(between).toContain('if (retarget.refused) {')
    expect(between).toContain('process.exit(1)')
    expect(between).toContain('if (retarget.cwd) spawnOpts.cwd = retarget.cwd')
  })

  it('decides the retarget BEFORE the companion directory is created, so a refusal leaves nothing on disk', () => {
    // A refused retarget used to be reached only after ensureCompanionDir had
    // run for the unscanned worktree's project key -- a durable directory
    // under ~/.claude/projects named for a folder the gate never checked
    // (adversarial confirmation pass, MINOR). The exit must come first.
    const launch = source.indexOf('function launchClaude(resumeId, sourceCwd) {')
    const decision = source.indexOf('const retarget = resolveRetargetCwd(', launch)
    const exit = source.indexOf('process.exit(1)', decision)
    const companion = source.indexOf('ensureCompanionDir(projectDir, resumeId)', launch)
    expect(launch).toBeGreaterThan(0)
    expect(decision).toBeGreaterThan(launch)
    expect(companion, 'the launch site no longer ensures the companion directory').toBeGreaterThan(launch)
    expect(exit, 'the refusal exit is missing').toBeGreaterThan(decision)
    expect(exit, 'the companion directory is created before the retarget is refused').toBeLessThan(companion)
  })

  it('prints the refused directory through the spoof-safe strip, never raw', () => {
    // The message goes to the user's terminal at the moment they are told
    // something went wrong; a worktree name on Linux or macOS may carry ESC,
    // OSC or a bidi override (adversarial confirmation pass, MINOR).
    const decision = source.indexOf('const retarget = resolveRetargetCwd(resumeId, sourceCwd, process.cwd(), process.env, fs.existsSync)')
    const exit = source.indexOf('process.exit(1)', decision)
    const between = source.slice(decision, exit)
    expect(between).toContain('displayPath(retarget.refused)')
    expect(between).not.toMatch(/\$\{retarget\.refused\}/)
    const esc = String.fromCharCode(27), osc = String.fromCharCode(0x9d), st = String.fromCharCode(0x9c)
    const evil = '/tmp/wt' + esc + '[2J' + esc + '[1;1H  Claude Code: sign in again at https://evil.example ' + esc + '[?25l'
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
