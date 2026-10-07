// macOS realm, shell-only session (the add-account and re-auth login shells,
// and a plain shell on a realm account): the user types `claude` by hand, and
// that bare name would be looked up on the INTERACTIVE shell's PATH (.zshrc
// included), which can find another binary than the one the #172 verdict was
// taken for (re-attack r3, MAJOR 1; ADR-023). So the shell's `claude` is
// pinned to the verified binary for this shell with a function.
//
// THE PIN IS SEPARATE LINES, sent AFTER the session's own opening
// `cd ...; clear` line, which stays exactly as on base (re-attack r4):
//
//  1. `unalias claude 2>/dev/null` -- ON ITS OWN LINE. An alias is expanded
//     when a line is READ, before anything on it runs: with `alias claude=...`
//     in the user's rc, a one-line `unalias claude; claude() { ...; }` reads
//     as `<alias text>() { ...` -- a syntax error in bash ("syntax error near
//     unexpected token `('") and dash ('Syntax error: "(" unexpected'), which
//     dropped the pin AND the `cd` that shared its line.
//  2. `claude() { '<bin>' "$@"; }` -- read after the alias is gone.
//  3. `clear` -- so the two lines do not stay on screen.
//
// A pin line that fails (an rc that `exec`s another shell, say) can no longer
// take the `cd` with it. `\claude()` and `function claude {` are not portable
// and are not used. Only for POSIX shells that take `name() { ...; }` (zsh,
// bash, sh, ksh, dash); for any other shell nothing is sent and the caller
// logs it. A path with a control character is never typed into a terminal
// (re-attack r4, MINOR 2: ^U, ^C, a newline would act on the line
// discipline) -- the launch is refused before this (mac-realm-verdict).
// A leaf (shared quoting only), so it is testable without the PTY graph.
import { quoteArgForShell } from '../shared/shell-quote'

export const REALM_SHELL_FUNCTION_SHELLS = ['zsh', 'bash', 'sh', 'ksh', 'dash'] as const

/** Any C0 control character or DEL. */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/

/** The shell a spawn runs: the command, or for an elevated `sudo <shell>`,
 *  its first argument. */
function shellOf(spawnCmd: string, spawnArgs: readonly string[]): string {
  const p = /(^|\/)(sudo|gsudo)$/.test(spawnCmd) ? (spawnArgs[0] ?? '') : spawnCmd
  const parts = p.split('/')
  return parts[parts.length - 1] ?? ''
}

/** The lines to type, each on its own, AFTER the opening `cd ...; clear`
 *  line; [] when not a realm launch, for a shell this cannot pin `claude` in,
 *  or for a path with a control character. */
export function realmShellPinLines(realmBin: string | null, spawnCmd: string, spawnArgs: readonly string[]): string[] {
  if (!realmBin || CONTROL_CHAR_RE.test(realmBin)) return []
  if (!(REALM_SHELL_FUNCTION_SHELLS as readonly string[]).includes(shellOf(spawnCmd, spawnArgs))) return []
  return ['unalias claude 2>/dev/null', `claude() { ${quoteArgForShell(realmBin, false)} "$@"; }`, 'clear']
}

/** True when a realm shell could not have its `claude` pinned (for the log). */
export function realmShellCannotPin(realmBin: string | null, spawnCmd: string, spawnArgs: readonly string[]): boolean {
  return !!realmBin && realmShellPinLines(realmBin, spawnCmd, spawnArgs).length === 0
}

/** Every line a shell-only session types when it opens, in order: the
 *  opening `cd` line (unchanged), the realm pin lines, the first-run command.
 *  Pure; exported for its test. */
export function shellOnlyOpeningLines(cdLine: string, pinLines: readonly string[], launchLine: string | null | undefined): string[] {
  return [cdLine, ...pinLines, ...(launchLine ? [launchLine] : [])]
}