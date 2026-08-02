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
