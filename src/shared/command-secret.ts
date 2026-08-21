/**
 * Secret arguments for command buttons — the contract both processes share.
 *
 * A command button TYPES text into a running shell. Every submitted line is
 * recorded by that shell's persistent history (PSReadLine writes
 * ConsoleHost_history.txt on Windows), so a token typed as an argument is on
 * disk forever. The fix is the one terminal configs already use: the VALUE goes
 * to the OS keychain, main puts it in the shell's ENVIRONMENT when the shell
 * starts, and the button types only a REFERENCE the shell expands. The value
 * never enters the command line, so it never enters the history.
 *
 * Because the value rides the spawn env, it is only present in shells started
 * AFTER the secret was saved — the dialog says so. And it is only ever placed in
 * SHELL spawns: a reference typed into Claude's TUI is just text to Claude.
 *
 * This file is pure and dependency-free so the renderer (which builds the line
 * the button types) and main (which builds the env) cannot drift on the name.
 */

/** The placeholder a user writes where the secret value goes: `-Token {secret}`. */
export const COMMAND_SECRET_TOKEN = '{secret}'

/** Command ids are the app's own 24-hex ids, but the env name is built from one,
 *  so the shape is checked here rather than trusted: an id that is not plain
 *  [A-Za-z0-9] could not be a valid variable name, and must never become part
 *  of one. */
const SAFE_ID = /^[A-Za-z0-9]{1,64}$/

/** The environment variable main sets for this command's secret, or null when
 *  the id cannot be made into a variable name. */
export function commandSecretEnvName(commandId: string): string | null {
  if (typeof commandId !== 'string' || !SAFE_ID.test(commandId)) return null
  return `CCC_CMD_SECRET_${commandId}`
}

/** The keychain key the value is stored under. Same namespace as the terminal
 *  config secrets (`<configId>_argsecret`), different suffix. */
export function commandSecretKey(commandId: string): string {
  return `${commandId}_cmdsecret`
}

/** Shell-appropriate reference to the variable. Quoted on POSIX so a value with
 *  spaces or globs stays one argument; PowerShell does not word-split `$env:X`. */
export function commandSecretRef(commandId: string, isWindows: boolean): string | null {
  const name = commandSecretEnvName(commandId)
  if (!name) return null
  return isWindows ? `$env:${name}` : `"$${name}"`
}

/**
 * THE rule for what a command button types: `prompt + ' ' + args.join(' ')`,
 * with `{secret}` in the arguments replaced by the reference when one is given.
 *
 * One function, used by the command bar (what is typed) AND by the dialog's
 * preview (what is shown), so the two cannot disagree. Nothing is quoted for
 * the user — an argument containing a space arrives as two, and the dialog says
 * so. Without a reference the token is left alone: a command with no stored
 * secret types `{secret}` literally, which is visible and harmless, rather than
 * silently typing nothing.
 */
export function buildCommandLine(prompt: string, args: readonly string[] | undefined, secretRef?: string | null): string {
  const p = (prompt ?? '').trim()
  if (!p) return ''
  if (!args || args.length === 0) return p
  const resolved = secretRef
    ? args.map((a) => a.split(COMMAND_SECRET_TOKEN).join(secretRef))
    : args
  return `${p} ${resolved.join(' ')}`
}
