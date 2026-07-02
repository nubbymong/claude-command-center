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
