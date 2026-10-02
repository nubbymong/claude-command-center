import { describe, it, expect } from 'vitest'
import { mangleCwdToProjectDir } from '../../src/shared/project-key'

// Parity fixtures: byte-identical to Claude Code's on-disk rule, verified
// against real ~/.claude/projects in transcript-discovery's original tests.
describe('mangleCwdToProjectDir (canonical shared key)', () => {
  it.each([
    ['F:\\MY_PROJECT', 'F--MY-PROJECT'],
    ['C:\\Users\\jane', 'C--Users-jane'],
    ['/home/user/my.project', '-home-user-my-project'],
    // NOTE: input has sample-app (hyphen, already alphanum-bounded); `\` and `.`
    // each become one `-`; the hyphen in `sample-app` is itself already a `-`
    // in the output, so no extra hyphen is inserted — the result is 2 hyphens
    // before `.claude`, NOT 3. Task plan's expected value had a typo here.
    ['F:\\sample-app\\.claude-worktrees\\warm-toolchain', 'F--sample-app--claude-worktrees-warm-toolchain'],
  ])('%s -> %s', (cwd, dir) => expect(mangleCwdToProjectDir(cwd)).toBe(dir))
})

// P3.16a round 2 (Q1): Claude Code 2.1.285, 2.1.286 and 2.1.287 (the pinned
// binaries, read, never run) cut a name longer than 200 characters at 200 and
// add `-` and the base-36 absolute value of a 32-bit string hash of the WHOLE
// launch folder (`h = (h << 5) - h + charCode | 0` over its UTF-16 code
// units). The expected hashes below are what the binaries' own function
// returns for these inputs, not what this module says.
describe('mangleCwdToProjectDir: a name longer than 200 characters, as Claude Code names it (Q1)', () => {
  const BS = String.fromCharCode(92)
  it('exactly 200 characters: the name as it is, no hash', () => {
    const cwd = '/tmp/' + 'x'.repeat(195)
    expect(mangleCwdToProjectDir(cwd)).toBe('-tmp-' + 'x'.repeat(195))
  })
  it.each([
    // [label, launch folder, first 200 characters of the name, hash]
    ['201 characters (a negative hash)', '/tmp/' + 'x'.repeat(196), '-tmp-' + 'x'.repeat(195), 'diaimx'],
    ['a Windows folder (a positive hash)', 'C:' + BS + 'Users' + BS + 'jane' + BS + 'a'.repeat(190), 'C--Users-jane-' + 'a'.repeat(186), 'vwg8id'],
    ['a POSIX folder of nested names', '/home/user/' + 'deeply-nested-package-folder/'.repeat(8), ('-home-user-' + 'deeply-nested-package-folder-'.repeat(8)).slice(0, 200), 'ebqvi5'],
    ['non-ASCII letters and an emoji: one hyphen per UTF-16 code unit, the hash over code units', 'F:' + BS + 'proj' + BS + '\u00e9t\u00e9-\u4e2d\u6587-'.repeat(30) + '\ud83d\ude00', 'F--proj-' + '-t-----'.repeat(27) + '-t-', 'icd4iu'],
    ['a drive root folder of 250 letters', 'C:' + BS + 'Z'.repeat(250), 'C--' + 'Z'.repeat(197), 'vod5gl'],
    ['401 characters', '/' + 'q'.repeat(400), '-' + 'q'.repeat(199), 'n6k7gx'],
  ])('%s', (_label, cwd, first200, hash) => {
    expect(first200.length).toBe(200)
    expect(mangleCwdToProjectDir(cwd)).toBe(`${first200}-${hash}`)
  })
})
