import { describe, it, expect } from 'vitest'
import { mangleCwdToProjectDir } from '../../src/shared/project-key'

// Parity fixtures: byte-identical to Claude Code's on-disk rule, verified
// against real ~/.claude/projects in transcript-discovery's original tests.
describe('mangleCwdToProjectDir (canonical shared key)', () => {
  it.each([
    ['F:\\CLAUDE_MULTI_APP', 'F--CLAUDE-MULTI-APP'],
    ['C:\\Users\\nicho', 'C--Users-nicho'],
    ['/home/user/my.project', '-home-user-my-project'],
    // NOTE: input has platform-v9 (hyphen, already alphanum-bounded); `\` and `.`
    // each become one `-`; the hyphen in `platform-v9` is itself already a `-`
    // in the output, so no extra hyphen is inserted — the result is 2 hyphens
    // before `.claude`, NOT 3. Task plan's expected value had a typo here.
    ['F:\\platform-v9\\.claude-worktrees\\warm-toolchain', 'F--platform-v9--claude-worktrees-warm-toolchain'],
  ])('%s -> %s', (cwd, dir) => expect(mangleCwdToProjectDir(cwd)).toBe(dir))
})
