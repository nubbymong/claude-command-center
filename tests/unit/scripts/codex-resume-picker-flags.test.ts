// [host] WP2 PR 4 (section 10 question 5, answered C; reviews B-S1, INT-Q3):
// the Codex resume picker hands every Codex it starts the flags the app gave
// it, unchanged, wherever it starts it (its own folder, a conversation's own
// worktree, or the fresh conversation it falls back to). The app passes no
// launch-time guidance any more (its canvas skills are in the account's own
// skills folder), so the picker has nothing to take out for another folder.
// Read from the scripts' text: nothing is started.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../../../scripts/lib/codex-resume-picker-lib.js') as Record<string, unknown>
const script = readFileSync(join(__dirname, '../../../scripts/codex-resume-picker.js'), 'utf8')
const launch = script.slice(script.indexOf('function launchCodex('))

describe('the picker forwards the app\'s flags unchanged', () => {
  it('[host] every Codex it starts, the fallback included, gets the forwarded flags as they came', () => {
    expect(launch).toContain('const forwarded = getForwardedArgs()')
    expect(launch).toContain('run(lib.buildResumeArgs(resumeUuid, forwarded))')
    expect(launch).toContain('run(forwarded)')
  })

  it('[host] nothing in the picker or its library edits the flags for another folder', () => {
    expect(lib).not.toHaveProperty('flagsForFolder')
    expect(script).not.toMatch(/flagsForFolder|developer_instructions/)
    const libText = readFileSync(join(__dirname, '../../../scripts/lib/codex-resume-picker-lib.js'), 'utf8')
    expect(libText).not.toMatch(/flagsForFolder|developer_instructions/)
  })
})
