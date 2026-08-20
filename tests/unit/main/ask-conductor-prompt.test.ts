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
 * the SHELL never parses it. This mirrors CCC_ARG_SECRET, and the builder takes
 * a BOOLEAN, not the text — the value cannot reach it even by mistake.
 *
 * That is only half of it on Windows, and the missing half was a live argv
 * injection (adversarial review of #308). PowerShell does not hand a native
 * command an argument array: it re-serialises every argument into ONE command
 * line, quoting an argument that contains whitespace but never escaping an
 * embedded `"`, and CommandLineToArgvW in the child re-splits the result. So a
 * question containing a quote became several arguments, one of which could be a
 * flag. askPromptEnvValue is the control for that, and these tests pin its rule:
 * on Windows the value carries no `"` and always ends in a space.
 */
import { describe, it, expect } from 'vitest'
import { buildClaudeLaunchCommand } from '../../../src/main/spawn-claude-command'
import { askPromptEnvValue, askPromptRef, secretRef } from '../../../src/main/terminal-launch-line'
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
    expect(cmd).toBe("Set-Location 'C:/work'; & 'claude' -- $env:CCC_ASK_PROMPT; exit")
  })

  it('appends the quoted env REFERENCE on POSIX', () => {
    const cmd = buildClaudeLaunchCommand({ ...BASE, platform: 'posix', askPrompt: true })
    expect(cmd).toBe("cd 'C:/work' && 'claude' -- \"$CCC_ASK_PROMPT\"; exit")
  })

  it('separates the question from the options with `--`, on both platforms', () => {
    // Without it a question that IS a flag is a flag. The trailing space
    // askPromptEnvValue adds does not save us: in an `--opt=value` form the
    // space lands in the VALUE, so `--settings=C:\evil.json` typed as a question
    // would still bind --settings.
    for (const platform of ['win32', 'posix'] as const) {
      const cmd = buildClaudeLaunchCommand({ ...BASE, platform, askPrompt: true })
      const ref = askPromptRef(platform === 'win32')
      const sep = cmd.indexOf(' -- ')
      expect(sep).toBeGreaterThan(-1)
      expect(sep).toBeLessThan(cmd.indexOf(ref))
    }
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
      expect(cmd).toBe("Set-Location 'C:/work'; & 'claude' -- $env:CCC_ASK_PROMPT; exit")
    }
  })
})

describe('askPromptEnvValue — the value the reference expands to', () => {
  /** The two rules the Windows argument round-trip depends on. Asserted as one
   *  helper so every case below checks BOTH, and a fix that satisfies one of
   *  them cannot pass by satisfying only that one. */
  const expectWindowsSafe = (value: string) => {
    expect(value).not.toContain('"')
    expect(value.endsWith(' ')).toBe(true)
    // A backslash BEFORE that trailing space is harmless: CommandLineToArgvW
    // only treats a backslash run specially when it is immediately followed by
    // a quote, and the space is what stands between them. Verified against the
    // real 5.1 binder — `path is C:\temp\` arrives intact once the space is
    // there, and arrived as `path is C:\temp"` before it was.
    expect(/\\$/.test(value)).toBe(false)
  }

  it('removes every straight quote on Windows, keeping the words', () => {
    // The app's OWN "Discuss this tip" wording puts quotes around the tip title,
    // so this case is the one that broke for ~95% of tips with no attacker at
    // all: the question arrived truncated at the first quoted word.
    const q = 'A tip says: "Session Presets" -- Save a config. Explain.'
    const value = askPromptEnvValue(q, true)
    expectWindowsSafe(value)
    expect(value).toBe('A tip says: \u201dSession Presets\u201d -- Save a config. Explain. ')
  })

  it('defuses the flag-injection shape', () => {
    const value = askPromptEnvValue('how do I fix this" --dangerously-skip-permissions "thanks', true)
    expectWindowsSafe(value)
    // The flag is still THERE as text — that is fine and deliberate. What must
    // not happen is it becoming an argument of its own, which needs the quote.
    expect(value).toContain('--dangerously-skip-permissions')
  })

  it('never ends in a backslash on Windows (it would escape the closing quote)', () => {
    // `path is C:\temp\` came back from the child as `path is C:\temp"`.
    expectWindowsSafe(askPromptEnvValue('path is C:\\temp\\', true))
    expect(askPromptEnvValue('C:\\temp\\', true)).toBe('C:\\temp\\ ')
  })

  it('always contains whitespace on Windows, so the binder always quotes', () => {
    // An UNQUOTED token is where cmd.exe's &, | and ^ come alive on the
    // claude.cmd (npm-installed) path — `foo&whoami` ran whoami.
    for (const q of ['help', 'foo&whoami', 'foo|whoami', 'foo^&whoami']) {
      const value = askPromptEnvValue(q, true)
      expectWindowsSafe(value)
      expect(/\s/.test(value)).toBe(true)
    }
  })

  it('leaves POSIX values alone — "$VAR" is genuinely one word after expansion', () => {
    for (const q of NASTY) {
      expect(askPromptEnvValue(q, false)).toBe(q)
    }
    expect(askPromptEnvValue('is this "right"', false)).toBe('is this "right"')
  })

  it('strips control, format and bidi characters on BOTH platforms', () => {
    // node-pty, unlike child_process, will put a NUL in an environment block,
    // where it ends the entry early and the rest is parsed as further variables.
    // U+2028/U+2029 are in the class too and are not what JS \s covers in
    // every engine; without a case for them that arm could be dropped green.
    const q = 'why\u0000 does\u001b[Z this\u0007 hang\u202e\u2028?\u2029'
    for (const isWindows of [true, false]) {
      const value = askPromptEnvValue(q, isWindows)
      expect(value).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
      // Each stripped character becomes a space, so the words stay separated
      // rather than being welded together into a different sentence.
      expect(value.trim()).toBe('why does [Z this hang ?')
    }
  })

  it('returns empty for a question that is nothing but control characters', () => {
    expect(askPromptEnvValue('\u0000\u001b\u0007', true)).toBe('')
    expect(askPromptEnvValue('\u0000\u001b\u0007', false)).toBe('')
  })
})

describe('buildClaudeLocalSpawn — the question lives in the env', () => {
  const BASE_SPAWN = { sessionId: 'ses-1', cwd: '/work', cols: 80, rows: 24 }
  const isWindows = process.platform === 'win32'

  it('applies the platform rule to the value it stores', () => {
    for (const q of NASTY) {
      const { env } = buildClaudeLocalSpawn({ ...BASE_SPAWN, askPrompt: q })
      // The transform lives in ONE place; the spawn must not have its own copy
      // of the rule, and must not skip it.
      expect(env.CCC_ASK_PROMPT).toBe(askPromptEnvValue(q, isWindows))
      if (isWindows) {
        expect(env.CCC_ASK_PROMPT).not.toContain('"')
        expect(env.CCC_ASK_PROMPT?.endsWith(' ')).toBe(true)
      } else {
        expect(env.CCC_ASK_PROMPT).toBe(q)
      }
    }
  })

  it('stores no control characters, whatever the caller passes', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_SPAWN, askPrompt: 'a\u0000b\u001bc' })
    expect(env.CCC_ASK_PROMPT).toBeDefined()
    expect(env.CCC_ASK_PROMPT).not.toMatch(/[\p{Cc}\p{Cf}]/u)
  })

  it('leaves the variable unset when the question cleans away to nothing', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_SPAWN, askPrompt: '\u0000\u001b' })
    expect(env.CCC_ASK_PROMPT).toBeUndefined()
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
