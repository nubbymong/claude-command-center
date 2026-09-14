/**
 * Which secret VALUES a shell can carry intact (ADR-009 pass, beta.16).
 *
 * On Windows the button/launch line references `$env:X`, and PowerShell 5.1
 * re-serialises native arguments into one command line without escaping an
 * embedded `"` -- so a value with a quote flips the child's quote parity, a
 * trailing `\` escapes the closing quote, and through an npm `.cmd` shim
 * cmd.exe re-parses `&|^<>%`. The app cannot rewrite a secret, so those values
 * are REFUSED at both dialogs by this one shared rule. On POSIX the reference
 * is `"$X"` and every value is one argument; only a line break is refused.
 */
import { describe, it, expect } from 'vitest'
import { secretValueProblem } from '../../../src/shared/command-secret'

describe('secretValueProblem', () => {
  it('accepts ordinary secrets everywhere', () => {
    for (const v of ['tok_abc123', 'p@ssword', 'sk-live-XYZ_789.abc', 'with space inside', 'unicode-ßüé', 'ends-with-slash-is-fine/', '$dollar', "single'quote", '(parens)', '{braces}', '[brackets]', '~tilde', '!bang', '#hash', '=equals', ',comma', ';semi', ':colon', '@at', '*star', '?q']) {
      expect(secretValueProblem(v, true), v).toBeNull()
      expect(secretValueProblem(v, false), v).toBeNull()
    }
    expect(secretValueProblem('', true)).toBeNull()
  })
  it('refuses a line break on every platform', () => {
    expect(secretValueProblem('a\nb', true)).toMatch(/line break/)
    expect(secretValueProblem('a\r\nb', false)).toMatch(/line break/)
  })
  it('on Windows refuses a double quote, a trailing backslash, and cmd metacharacters -- each named', () => {
    expect(secretValueProblem('p@ss"word', true)).toMatch(/double quote/)
    expect(secretValueProblem('C:\\secret dir\\', true)).toMatch(/backslash/)
    for (const m of ['&', '|', '^', '<', '>', '%']) {
      expect(secretValueProblem(`abc${m}def`, true), m).toContain(m)
    }
  })
  it('on POSIX allows all of those (the reference is quoted: "$X" is one argument)', () => {
    for (const v of ['p@ss"word', 'C:\\secret dir\\', 'abc&def', 'a|b', 'a^b', 'a<b>c', '100%']) {
      expect(secretValueProblem(v, false), v).toBeNull()
    }
  })
  it('a backslash that is not at the end is fine on Windows (a path is a common secret shape)', () => {
    expect(secretValueProblem('C:\\Users\\me\\key', true)).toBeNull()
  })
})

// ── Re-attack round (beta.16 ADR-009 pass). Measured on powershell.exe 5.1 +
// an npm .cmd shim: every gate-accepted value arrived as one intact argument;
// the two gaps it found in the refusal set are closed here.
describe('secretValueProblem -- re-attack additions', () => {
  it('refuses a NUL everywhere: node-pty builds the env block as value + \\0, so a NUL would inject a further variable', () => {
    expect(secretValueProblem('a\u0000B=1', true)).toMatch(/line break or NUL/)
    expect(secretValueProblem('a\u0000B=1', false)).toMatch(/line break or NUL/)
  })
  it('on Windows refuses a !NAME! pair (cmd delayed expansion through a .cmd shim expands it), but not a lone !', () => {
    expect(secretValueProblem('!USERNAME!', true)).toMatch(/!/)
    expect(secretValueProblem('pw!with!bangs', true)).toMatch(/!/)
    expect(secretValueProblem('pass!word', true)).toBeNull()
    expect(secretValueProblem('wow!', true)).toBeNull()
    expect(secretValueProblem('!USERNAME!', false)).toBeNull()
  })
})
