/**
 * Regression tests for the launch-line shell quoting.
 *
 * The launch command is assembled as a STRING and written into a PTY, so every
 * value interpolated into it is code until it is quoted correctly. Two defects
 * were found here:
 *
 *  1. The win32 branch escaped only U+0027, but PowerShell accepts FOUR more
 *     characters as single-quote delimiters (U+2018/U+2019/U+201A/U+201B), all
 *     of them legal in NTFS directory names. A working directory containing one
 *     terminated the quoted string early and the rest of the path was executed.
 *
 *  2. The binary and picker PATHS were interpolated into DOUBLE quotes, where
 *     PowerShell expands `$(...)` and POSIX expands `$(...)` and backticks — at
 *     runtime, verified executing on both.
 *
 * These assert the PROPERTY (no token escapes its quotes), not the exact
 * command string; the golden-shape tests live in spawn-resume-command.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { buildClaudeLaunchCommand, quoteArgForShell } from '../../../src/main/spawn-claude-command'

/** The five characters PowerShell treats as single-quote delimiters. */
const PS_QUOTE_CHARS = ['\u0027', '\u2018', '\u2019', '\u201A', '\u201B']
const PS_QUOTE_NAMES = ['APOSTROPHE', 'LEFT SINGLE', 'RIGHT SINGLE', 'LOW-9', 'HIGH-REVERSED-9']

/**
 * Parse a single-quoted PowerShell string the way the shell does, and return
 * everything that is NOT inside quotes. If the payload leaked out of its
 * quoting, its text shows up here — which is the thing being asserted against.
 *
 * A doubled delimiter inside a quoted run is a literal character, and (unlike
 * POSIX) PowerShell lets ANY of the five open or close a run.
 */
/** The four characters PowerShell accepts as DOUBLE-quote delimiters. */
const PS_DQUOTE_CHARS = ['"', '“', '”', '„']

function outsideSingleQuotes(command: string): string {
  let out = ''
  let quote: string | null = null // the delimiter that opened the current run
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote === null) {
      // A double-quoted run must be tracked too, or an apostrophe INSIDE one
      // ("don't") desynchronises the scanner and every later region is misread
      // as quoted — which made this helper report "safe" for a command a real
      // shell executed (independent review, 2026-08-14). It is the oracle for
      // this whole file, so it has to model both quote families.
      if (PS_QUOTE_CHARS.includes(c) || PS_DQUOTE_CHARS.includes(c)) {
        quote = c
        continue
      }
      out += c
      continue
    }
    const sameFamily = PS_QUOTE_CHARS.includes(quote)
      ? PS_QUOTE_CHARS.includes(c)
      : PS_DQUOTE_CHARS.includes(c)
    if (!sameFamily) continue // a quote of the other family is literal in here
    // Inside a run: a doubled delimiter is an escaped literal, not a close.
    if (command[i + 1] === c) {
      i++
      continue
    }
    quote = null
  }
  // An unterminated run means the line would not parse at all; refuse to judge
  // rather than silently dropping the tail and calling it safe.
  if (quote !== null) throw new Error('unterminated quote: this command would not parse')
  return out
}

const PAYLOAD = 'Write-Output PWNED'

describe('win32: no PowerShell single-quote delimiter can escape the cwd quoting', () => {
  for (let i = 0; i < PS_QUOTE_CHARS.length; i++) {
    const q = PS_QUOTE_CHARS[i]
    it(`${PS_QUOTE_NAMES[i]} (U+${q.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}) stays inside its quotes`, () => {
      const cwd = `C:\\proj${q}; ${PAYLOAD}; ${q}\\end`
      const out = buildClaudeLaunchCommand({
        platform: 'win32',
        cwd,
        claudeBin: 'C:\\bin\\claude.exe',
        extraFlags: '',
        agentsFlag: '',
        useResumePicker: false,
        pickerScript: null,
      })
      // The payload must not appear as shell code...
      expect(outsideSingleQuotes(out)).not.toContain('PWNED')
      // ...and the cwd must not have introduced any NEW statement separator
      // outside the quotes. Compared against a benign cwd rather than a magic
      // number, so the assertion survives changes to the command's own shape.
      const benign = buildClaudeLaunchCommand({
        platform: 'win32',
        cwd: 'C:\\proj',
        claudeBin: 'C:\\bin\\claude.exe',
        extraFlags: '',
        agentsFlag: '',
        useResumePicker: false,
        pickerScript: null,
      })
      const count = (s: string) => (outsideSingleQuotes(s).match(/;/g) ?? []).length
      expect(count(out)).toBe(count(benign))
    })
  }

  it('a legitimate path with an apostrophe still round-trips', () => {
    const out = buildClaudeLaunchCommand({
      platform: 'win32',
      cwd: "F:\\o'brien\\proj",
      claudeBin: 'C:\\bin\\claude.exe',
      extraFlags: '',
      agentsFlag: '',
      useResumePicker: false,
      pickerScript: null,
    })
    expect(out).toContain("Set-Location 'F:\\o''brien\\proj'")
    expect(outsideSingleQuotes(out)).not.toContain('brien')
  })

  it('quoteArgForShell applies the same class (it feeds --settings / --mcp-config / --model)', () => {
    for (const q of PS_QUOTE_CHARS) {
      const quoted = quoteArgForShell(`C:\\x${q}; ${PAYLOAD}; ${q}\\y`, true)
      expect(outsideSingleQuotes(quoted)).not.toContain('PWNED')
    }
  })
})

describe('the binary and picker paths are single-quoted, so no shell expands them', () => {
  // `$(...)` inside DOUBLE quotes executes at runtime in PowerShell AND in
  // POSIX sh; inside single quotes it is literal in both.
  const EXPANDING = ['$(Write-Output PWNED)', '`Write-Output PWNED`', '$(touch /tmp/pwned)']

  for (const platform of ['win32', 'posix'] as const) {
    it(`${platform}: an expanding construct in claudeBin is inert`, () => {
      for (const evil of EXPANDING) {
        const out = buildClaudeLaunchCommand({
          platform,
          cwd: platform === 'win32' ? 'C:\\proj' : '/proj',
          claudeBin: `${platform === 'win32' ? 'C:\\bin' : '/usr/bin'}${evil}/claude`,
          extraFlags: '',
          agentsFlag: '',
          useResumePicker: false,
          pickerScript: null,
        })
        // Never interpolated into double quotes...
        expect(out).not.toContain(`"${platform === 'win32' ? 'C:\\bin' : '/usr/bin'}`)
        // ...and the construct sits inside a single-quoted run.
        expect(out).toContain(`'${platform === 'win32' ? 'C:\\bin' : '/usr/bin'}${evil}/claude'`)
      }
    })

    it(`${platform}: an expanding construct in the picker path is inert`, () => {
      const evil = '$(Write-Output PWNED)'
      const out = buildClaudeLaunchCommand({
        platform,
        cwd: platform === 'win32' ? 'C:\\proj' : '/proj',
        claudeBin: 'claude',
        extraFlags: '',
        agentsFlag: '',
        useResumePicker: true,
        pickerScript: `${platform === 'win32' ? 'C:\\res' : '/res'}${evil}/resume-picker.js`,
      })
      expect(out).toContain(`'${platform === 'win32' ? 'C:\\res' : '/res'}${evil}/resume-picker.js'`)
      expect(out).not.toMatch(/node "/)
    })
  }

  it('win32: a smart quote in claudeBin cannot escape', () => {
    for (const q of PS_QUOTE_CHARS) {
      const out = buildClaudeLaunchCommand({
        platform: 'win32',
        cwd: 'C:\\proj',
        claudeBin: `C:\\bin${q}; ${PAYLOAD}; ${q}\\claude.exe`,
        extraFlags: '',
        agentsFlag: '',
        useResumePicker: false,
        pickerScript: null,
      })
      expect(outsideSingleQuotes(out)).not.toContain('PWNED')
    }
  })

  it('win32: a smart quote in the PICKER path cannot escape', () => {
    // This was asserted in a title but never exercised: the case passed
    // `pickerScript: null`, so reverting the picker escaping left the whole
    // suite green (independent review, 2026-08-14). A guard that cannot fail
    // is worse than no guard.
    for (const q of PS_QUOTE_CHARS) {
      const out = buildClaudeLaunchCommand({
        platform: 'win32',
        cwd: 'C:\\proj',
        claudeBin: 'claude',
        extraFlags: '',
        agentsFlag: '',
        useResumePicker: true,
        pickerScript: `C:\\res${q}; ${PAYLOAD}; ${q}\\resume-picker.js`,
      })
      expect(outsideSingleQuotes(out)).not.toContain('PWNED')
    }
  })

  it('posix: a single quote in the picker path cannot escape', () => {
    const out = buildClaudeLaunchCommand({
      platform: 'posix',
      cwd: '/proj',
      claudeBin: 'claude',
      extraFlags: '',
      agentsFlag: '',
      useResumePicker: true,
      pickerScript: `/res'; ${PAYLOAD}; '/resume-picker.js`,
    })
    expect(out).toContain("'/res'\\''; Write-Output PWNED; '\\''/resume-picker.js'")
  })

  it('refuses a resumeUuid that is not a uuid — the one value interpolated UNQUOTED', () => {
    // Every current caller gates this with the same anchored regex, but the
    // function is exported and "the caller checks" is a comment, not a
    // boundary. Anchored, so a trailing `; …` is refused rather than launched.
    for (const bad of [
      `11111111-2222-3333-4444-555555555555; ${PAYLOAD}; `,
      "11111111-2222-3333-4444-555555555555' ; echo x",
      'not-a-uuid',
      '11111111-2222-3333-4444-555555555555\n--dangerously-skip-permissions',
    ]) {
      expect(() =>
        buildClaudeLaunchCommand({
          platform: 'win32', cwd: 'C:\\p', claudeBin: 'claude',
          extraFlags: '', agentsFlag: '', useResumePicker: false,
          pickerScript: null, resumeUuid: bad,
        }),
      ).toThrow(/resumeUuid/)
    }
    // ...a real uuid still launches...
    const ok = buildClaudeLaunchCommand({
      platform: 'win32', cwd: 'C:\\p', claudeBin: 'claude',
      extraFlags: '', agentsFlag: '', useResumePicker: false,
      pickerScript: null, resumeUuid: '11111111-2222-3333-4444-555555555555',
    })
    expect(ok).toContain('--resume 11111111-2222-3333-4444-555555555555')
    // ...and an absent/empty uuid is NOT an error, it is the no-resume path.
    expect(() =>
      buildClaudeLaunchCommand({
        platform: 'win32', cwd: 'C:\\p', claudeBin: 'claude',
        extraFlags: '', agentsFlag: '', useResumePicker: false,
        pickerScript: null, resumeUuid: '',
      }),
    ).not.toThrow()
  })

  it('the outsideSingleQuotes oracle models double-quoted runs (it is the whole suite’s judge)', () => {
    // An apostrophe inside a double-quoted value used to desynchronise the
    // scanner, making it report "safe" for a line PowerShell really executed.
    const real = `Set-Location 'C:\\p'; & 'C:\\claude.cmd' --agents "don't"; ${PAYLOAD}; exit`
    expect(outsideSingleQuotes(real)).toContain('PWNED')
    // ...and an unparseable line is refused rather than judged safe.
    expect(() => outsideSingleQuotes("Set-Location 'C:\\unterminated")).toThrow(/unterminated/)
  })

  it('posix: a single quote in the paths still uses close-escape-reopen', () => {
    const out = buildClaudeLaunchCommand({
      platform: 'posix',
      cwd: '/home/proj',
      claudeBin: "/usr/bin/o'brien/claude",
      extraFlags: '',
      agentsFlag: '',
      useResumePicker: false,
      pickerScript: null,
    })
    expect(out).toContain("'/usr/bin/o'\\''brien/claude'")
  })

  it('a bare command name and a spaced path are unchanged in shape', () => {
    const bare = buildClaudeLaunchCommand({
      platform: 'posix', cwd: '/p', claudeBin: 'claude',
      extraFlags: '', agentsFlag: '', useResumePicker: false, pickerScript: null,
    })
    expect(bare).toBe("cd '/p' && 'claude'; exit")

    const spaced = buildClaudeLaunchCommand({
      platform: 'win32', cwd: 'C:\\p', claudeBin: 'C:\\Program Files\\claude.exe',
      extraFlags: '', agentsFlag: '', useResumePicker: false, pickerScript: null,
    })
    expect(spaced).toBe("Set-Location 'C:\\p'; & 'C:\\Program Files\\claude.exe'; exit")
  })
})
