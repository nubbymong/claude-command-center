/**
 * Terminal-only launcher: build the line written into the shell after the `cd`.
 *
 * Pure + exported so the substitution rule is TESTED AGAINST THE REAL
 * IMPLEMENTATION rather than a copy of it living in a test file.
 *
 * SECURITY CONTRACT: `{secret}` is replaced with a REFERENCE to the
 * CCC_ARG_SECRET environment variable (set from the OS keychain in
 * buildClaudeLocalSpawn) — never with the secret value. CCC writes this line
 * into the PTY exactly as if the user had typed it, and shells persist
 * submitted lines to disk (PSReadLine's ConsoleHost_history.txt on Windows),
 * so a substituted plaintext secret would be written to disk forever.
 */
export interface TerminalLaunchOptions {
  command?: string
  args?: string
  hasSecretArg?: boolean
}

/** Shell-appropriate reference to the secret env var. Quoted on POSIX so a
 *  secret containing spaces or globs stays a single argument; PowerShell does
 *  not word-split `$env:VAR`, so it needs no quoting. */
export function secretRef(isWindows: boolean): string {
  return isWindows ? '$env:CCC_ARG_SECRET' : '"$CCC_ARG_SECRET"'
}

/** Shell-appropriate reference to the Ask Conductor opening prompt.
 *
 *  Same contract as {@link secretRef}, and for the same reason: the value is
 *  free text typed by a user, so interpolating it into a shell-parsed command
 *  would put the safety of the whole launch line on an escaping routine. A
 *  variable reference removes the question from the parse entirely — the shell
 *  expands it to exactly one argument AFTER tokenising.
 *
 *  Quoted on POSIX so a question containing spaces or glob characters stays a
 *  single argument; PowerShell does not word-split `$env:VAR`, so it needs no
 *  quoting (matching secretRef exactly). */
export function askPromptRef(isWindows: boolean): string {
  return isWindows ? '$env:CCC_ASK_PROMPT' : '"$CCC_ASK_PROMPT"'
}

/**
 * Returns the command line to run, or '' when nothing should be run.
 * With no secret stored, `{secret}` collapses to an empty string rather than
 * leaving a dangling variable name the shell would expand to nothing anyway.
 */
export function buildTerminalLaunchLine(opts: TerminalLaunchOptions | undefined, isWindows: boolean): string {
  const command = (opts?.command ?? '').trim()
  if (!command) return ''
  const ref = opts?.hasSecretArg ? secretRef(isWindows) : ''
  const args = (opts?.args ?? '').replace(/\{secret\}/g, ref).trim()
  return args ? `${command} ${args}` : command
}
