// Single-quoting a value for the shell a Conductor terminal runs: PowerShell
// on Windows, a POSIX shell elsewhere. PURE, no imports, so both the Claude
// launch line (src/main/spawn-claude-command.ts, which re-exports
// quoteArgForShell) and provider core (the install-recipe run line) share
// one implementation without provider core reaching outside core and shared.

/**
 * Every character PowerShell accepts as a single-quote DELIMITER.
 *
 * PowerShell's tokenizer treats the ASCII apostrophe and four Unicode
 * quotation marks interchangeably: U+2018 LEFT, U+2019 RIGHT, U+201A LOW-9 and
 * U+201B HIGH-REVERSED-9. Escaping only U+0027 therefore leaves four ways to
 * terminate a quoted string early — and all four are legal in NTFS directory
 * names, so an ordinary folder name can carry one (a curly apostrophe is what
 * word processors produce, and those names get pasted into paths).
 *
 * POSIX shells have no equivalent: only U+0027 delimits there, which is why
 * the posix branch below is unchanged.
 */
const PS_SINGLE_QUOTE_CLASS = /[\u0027\u2018\u2019\u201A\u201B]/g

/**
 * Escape a path for single-quoting in the target shell.
 *   - win32 (PowerShell): double every single-quote delimiter (see above).
 *   - posix (sh): close-quote, backslash-escape, reopen-quote.
 *
 * Doubling is the correct escape for ALL of them: PowerShell reads a doubled
 * delimiter inside a single-quoted string as one literal character, whichever
 * of the five it is.
 */
export function escapeForCwdQuote(p: string, isWin32: boolean): string {
  return isWin32 ? p.replace(PS_SINGLE_QUOTE_CLASS, (c) => c + c) : p.replace(/'/g, "'\\''")
}

/**
 * Single-quote an argument VALUE for the launch shell — returns the value
 * wrapped in single quotes, escaped for the target shell.
 *
 * Required for `--model` (#144): 1M-context model ids contain brackets
 * (`opus[1m]`), which zsh — the macOS default shell — parses as a glob
 * character class. Unquoted it fails with `zsh: no matches found: opus[1m]` and
 * aborts the ENTIRE launch line before claude/node ever runs, so no session
 * starts. bash and PowerShell pass the unmatched glob through literally, which
 * is why this only reproduces on zsh. Single quotes are literal in PowerShell
 * and POSIX sh/zsh alike.
 *
 * Pass `isWin32: false` for a command that will run on a REMOTE POSIX shell
 * (SSH sessions) regardless of the local platform.
 */
export function quoteArgForShell(value: string, isWin32: boolean): string {
  return `'${escapeForCwdQuote(value, isWin32)}'`
}
