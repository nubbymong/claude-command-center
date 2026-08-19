/**
 * Ask Conductor's opening question must never become shell command TEXT.
 *
 * The feature exists to kill the copy/paste step: the user types a question in
 * the app and it arrives as Claude's first prompt. That makes free-form user
 * text an input to a launch line that PowerShell / POSIX sh parse, which is the
 * exact shape of every shell-injection bug this file's neighbours were written
 * for (see spawn-shell-quote-injection.test.ts).
 *
 * The chosen control is NOT escaping. The question travels in the spawn ENV as
 * CCC_ASK_PROMPT and the command carries only a REFERENCE to that variable, so
 * both shells expand it to exactly one argument AFTER tokenising and there is no
 * parse for its contents to break out of. This mirrors CCC_ARG_SECRET.
 *
 * The builder therefore takes a BOOLEAN, not the text — the value cannot reach
 * it even by mistake. These tests pin that, and pin that a caller who tries to
 * smuggle text through anyway still cannot get it into the command.
 */
import { describe, it, expect } from 'vitest'
import { buildClaudeLaunchCommand } from '../../../src/main/spawn-claude-command'
import { askPromptRef, secretRef } from '../../../src/main/terminal-launch-line'
import { buildClaudeLocalSpawn } from '../../../src/main/providers/claude/spawn'

const BASE = {
  cwd: 'C:/work',
  claudeBin: 'claude',
  extraFlags: '',
  agentsFlag: '',
  useResumePicker: false,
  pickerScript: null,
}

/** Questions a real user might type that are also shell metacharacter soup. */
const NASTY = [
  'what is $(whoami)?',
  'why does `git log` hang?',
  "what's the cost; rm -rf /",
  'how do I use $env:PATH & why',
  "it broke' ; calc.exe ; '",
  'explain the \u2019 curly quote thing',
]

describe('askPromptRef', () => {
  it('is a bare variable reference on Windows (PowerShell does not word-split)', () => {
    expect(askPromptRef(true)).toBe('$env:CCC_ASK_PROMPT')
  })

  it('is QUOTED on POSIX so a question with spaces or globs stays one argument', () => {
    expect(askPromptRef(false)).toBe('"$CCC_ASK_PROMPT"')
  })

  it('follows the same shape as the secret reference it is modelled on', () => {
    // If secretRef's quoting rule is ever revised, this pairing should be
    // revisited together rather than drifting apart silently.
    expect(askPromptRef(true).startsWith('$env:')).toBe(secretRef(true).startsWith('$env:'))
    expect(askPromptRef(false).startsWith('"$')).toBe(secretRef(false).startsWith('"$'))
  })
})

describe('buildClaudeLaunchCommand — opening prompt', () => {
  it('appends the env REFERENCE, not any text, on Windows', () => {
    const cmd = buildClaudeLaunchCommand({ ...BASE, platform: 'win32', askPrompt: true })
    expect(cmd).toContain('$env:CCC_ASK_PROMPT')
    expect(cmd).toBe("Set-Location 'C:/work'; & 'claude' $env:CCC_ASK_PROMPT; exit")
  })

  it('appends the quoted env REFERENCE on POSIX', () => {
    const cmd = buildClaudeLaunchCommand({ ...BASE, platform: 'posix', askPrompt: true })
    expect(cmd).toBe("cd 'C:/work' && 'claude' \"$CCC_ASK_PROMPT\"; exit")
  })

  it('puts the prompt LAST, after every flag (claude [options] [prompt])', () => {
    const cmd = buildClaudeLaunchCommand({
      ...BASE,
      platform: 'win32',
      agentsFlag: ' --agents x',
      extraFlags: " --model 'opus'",
      askPrompt: true,
    })
    expect(cmd.indexOf('$env:CCC_ASK_PROMPT')).toBeGreaterThan(cmd.indexOf('--model'))
    expect(cmd.indexOf('$env:CCC_ASK_PROMPT')).toBeGreaterThan(cmd.indexOf('--agents'))
  })

  it('adds NOTHING when no prompt is requested (byte-identical to before)', () => {
    const without = buildClaudeLaunchCommand({ ...BASE, platform: 'win32' })
    const explicitlyOff = buildClaudeLaunchCommand({ ...BASE, platform: 'win32', askPrompt: false })
    expect(without).toBe("Set-Location 'C:/work'; & 'claude'; exit")
    expect(explicitlyOff).toBe(without)
    expect(without).not.toContain('CCC_ASK_PROMPT')
  })

  it('is ignored on the resume path, which has a conversation to continue', () => {
    const cmd = buildClaudeLaunchCommand({
      ...BASE,
      platform: 'win32',
      resumeUuid: '123e4567-e89b-42d3-a456-426614174000',
      askPrompt: true,
    })
    expect(cmd).not.toContain('CCC_ASK_PROMPT')
  })

  it('cannot carry question text into the command even if a caller passes some', () => {
    // askPrompt is typed boolean; this is the runtime backstop for a JS caller
    // (or a future refactor) handing over the string by mistake. A truthy value
    // must still emit only the reference.
    for (const q of NASTY) {
      const cmd = buildClaudeLaunchCommand({
        ...BASE,
        platform: 'win32',
        askPrompt: q as unknown as boolean,
      })
      expect(cmd).toContain('$env:CCC_ASK_PROMPT')
      expect(cmd).not.toContain(q)
      // Nothing from the question survives into the parsed line.
      expect(cmd).toBe("Set-Location 'C:/work'; & 'claude' $env:CCC_ASK_PROMPT; exit")
    }
  })
})

describe('buildClaudeLocalSpawn — the question lives in the env, verbatim', () => {
  const BASE_SPAWN = { sessionId: 'ses-1', cwd: '/work', cols: 80, rows: 24 }

  it('passes the question through untouched, with no escaping applied', () => {
    for (const q of NASTY) {
      const { env } = buildClaudeLocalSpawn({ ...BASE_SPAWN, askPrompt: q })
      // Byte-identical: the shell never parses this, so mangling it would only
      // corrupt the user's question.
      expect(env.CCC_ASK_PROMPT).toBe(q)
    }
  })

  it('leaves the variable unset for an ordinary session', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_SPAWN })
    expect(env.CCC_ASK_PROMPT).toBeUndefined()
  })

  it('leaves the variable unset for an empty question rather than setting it blank', () => {
    // `claude ""` would start with a blank positional prompt argument, which is
    // not the same as starting with none.
    const { env } = buildClaudeLocalSpawn({ ...BASE_SPAWN, askPrompt: '' })
    expect(env.CCC_ASK_PROMPT).toBeUndefined()
  })
})
