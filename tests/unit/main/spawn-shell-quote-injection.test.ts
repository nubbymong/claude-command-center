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
function outsideSingleQuotes(command: string): string {
  let out = ''
  let inQuote = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const isDelim = PS_QUOTE_CHARS.includes(c)
    if (!isDelim) {
      if (!inQuote) out += c
      continue
    }
    if (!inQuote) {
      inQuote = true
      continue
    }
    // Inside a run: a doubled delimiter is an escaped literal, not a close.
    if (command[i + 1] === c) {
      i++
      continue
    }
    inQuote = false
  }
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

  it('win32: a smart quote in claudeBin cannot escape either (the picker path too)', () => {
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
