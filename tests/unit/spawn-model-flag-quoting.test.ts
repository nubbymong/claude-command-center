import { describe, it, expect } from 'vitest'
import { quoteArgForShell } from '../../src/main/spawn-claude-command'
import { spawnOptionsSchema } from '../../src/main/ipc/pty-handlers'

// #144: the --model value is interpolated into the launch COMMAND STRING. 1M
// model ids contain brackets (`opus[1m]`), which zsh (macOS default shell)
// parses as a glob character class -- unquoted it dies with
// `zsh: no matches found: opus[1m]` and aborts the whole launch line, so no
// session starts. These tests pin the quoting that makes bracketed ids safe.

describe('quoteArgForShell', () => {
  it('single-quotes a bracketed 1M model id so zsh cannot glob it', () => {
    // POSIX (macOS/Linux): the brackets must end up inside single quotes.
    expect(quoteArgForShell('opus[1m]', false)).toBe("'opus[1m]'")
    // Windows/PowerShell: same literal single-quoted form.
    expect(quoteArgForShell('opus[1m]', true)).toBe("'opus[1m]'")
  })

  it('quotes every shipped model alias, bracketed or not', () => {
    for (const m of ['opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'fable', 'claude-opus-5[1m]']) {
      const q = quoteArgForShell(m, false)
      expect(q.startsWith("'")).toBe(true)
      expect(q.endsWith("'")).toBe(true)
      // The value survives verbatim between the quotes (no mangling).
      expect(q.slice(1, -1)).toBe(m)
    }
  })

  it('escapes an embedded single quote per shell dialect', () => {
    expect(quoteArgForShell("a'b", false)).toBe("'a'\\''b'")  // POSIX: close, escape, reopen
    expect(quoteArgForShell("a'b", true)).toBe("'a''b'")      // PowerShell: doubled
  })

  it('leaves no unquoted glob metacharacter for the shell to expand', () => {
    // Regression sentinel: the emitted token must not contain a bare `[`/`]`
    // outside the quotes (which is exactly what broke on zsh).
    const emitted = `--model ${quoteArgForShell('opus[1m]', false)}`
    expect(emitted).toBe("--model 'opus[1m]'")
    expect(emitted).not.toMatch(/--model [^']*\[/)
  })
})

describe('spawnOptionsSchema — model (#144 companion guard)', () => {
  it('accepts bracketed 1M ids (they are legit values that must reach the CLI)', () => {
    for (const m of ['opus', 'opus[1m]', 'claude-opus-5[1m]', '']) {
      expect(spawnOptionsSchema.safeParse({ model: m }).success).toBe(true)
    }
  })

  it('still rejects shell metacharacters beyond the bracket charset', () => {
    for (const m of ['opus; rm -rf /', 'opus$(id)', 'opus`id`', 'opus|cat']) {
      expect(spawnOptionsSchema.safeParse({ model: m }).success).toBe(false)
    }
  })
})
