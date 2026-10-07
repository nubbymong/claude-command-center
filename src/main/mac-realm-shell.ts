// macOS realm, shell-only session (the add-account and re-auth login shells,
// and a plain shell on a realm account): the user types `claude` by hand, and
// that bare name would be looked up on the INTERACTIVE shell's PATH (.zshrc
// included), which can find another binary than the one the #172 verdict was
// taken for (re-attack r3, MAJOR 1; ADR-023). So the shell's `claude` is
// pinned to the verified binary for this shell: any alias removed, then a
// function, typed ahead of the opening `cd ...; clear` (the clear wipes it
// from view). Only for POSIX shells that take `name() { ...; }` (zsh, bash,
// sh, ksh, dash); for any other shell nothing is added -- the caller logs it.
// A leaf (shared quoting only), so it is testable without the PTY graph.
import { quoteArgForShell } from '../shared/shell-quote'

export const REALM_SHELL_FUNCTION_SHELLS = ['zsh', 'bash', 'sh', 'ksh', 'dash'] as const

/** The shell a spawn runs: the command, or for an elevated `sudo <shell>`,
 *  its first argument. */
function shellOf(spawnCmd: string, spawnArgs: readonly string[]): string {
  const p = /(^|\/)(sudo|gsudo)$/.test(spawnCmd) ? (spawnArgs[0] ?? '') : spawnCmd
  const parts = p.split('/')
  return parts[parts.length - 1] ?? ''
}

/** The prefix to type before the opening `cd`, or '' (not a realm launch, or
 *  a shell this cannot pin `claude` in). */
export function realmShellClaudePrefix(realmBin: string | null, spawnCmd: string, spawnArgs: readonly string[]): string {
  if (!realmBin) return ''
  if (!(REALM_SHELL_FUNCTION_SHELLS as readonly string[]).includes(shellOf(spawnCmd, spawnArgs))) return ''
  return `unalias claude 2>/dev/null; claude() { ${quoteArgForShell(realmBin, false)} "$@"; }; `
}

/** True when a realm shell could not have its `claude` pinned (for the log). */
export function realmShellCannotPin(realmBin: string | null, spawnCmd: string, spawnArgs: readonly string[]): boolean {
  return !!realmBin && realmShellClaudePrefix(realmBin, spawnCmd, spawnArgs) === ''
}
