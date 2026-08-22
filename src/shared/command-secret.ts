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
 *  spaces or globs stays one argument.
 *
 *  On Windows the reference is `$env:X` and it is NOT a guarantee of one
 *  argument: PowerShell 5.1 (the shell the app starts) re-serialises native
 *  arguments into one command line and never escapes an embedded `"`, so a
 *  value containing a quote flips the child's quote parity, a value ending in
 *  `\` escapes the closing quote, and -- through an npm `.cmd` shim, where
 *  cmd.exe re-parses the line -- `&|^<>%` in an unquoted token are live. The
 *  app cannot rewrite a secret, so `secretValueProblem` REFUSES those values at
 *  the dialog instead; what it accepts arrives intact. (ADR-009 pass, beta.16:
 *  the earlier "stays one argument" claim here was measured false on 5.1.) */
export function commandSecretRef(commandId: string, isWindows: boolean): string | null {
  const name = commandSecretEnvName(commandId)
  if (!name) return null
  return secretRefCore(name, isWindows)
}

/**
 * The BARE reference to an environment variable — no surrounding quotes.
 *
 * Braced on both platforms (`${env:NAME}` / `${NAME}`) because the unbraced
 * form is unbounded: an adjacent `_v2` runs straight into the variable name.
 *
 * Quoting is NOT baked in here, and that is the whole point of the split. A
 * pre-quoted reference is only correct when the token stands alone as its own
 * argument; substituted into text the user already quoted it nests wrongly and
 * leaves the expansion unquoted. `substituteSecretToken` decides the quoting
 * from the surrounding word instead — see the measured table there.
 */
export function secretRefCore(envName: string, isWindows: boolean): string {
  return isWindows ? `\${env:${envName}}` : `\${${envName}}`
}

/**
 * Replace every `{secret}` in `text` with a shell reference, quoting per the
 * word it lands in.
 *
 * MEASURED, not reasoned about (#371, on Windows PowerShell 5.1.26100 and
 * PowerShell 7.6, and on bash), against a real argv printer. `--out X --force`
 * with the reference written as:
 *
 *   written form        bare $env:X   braced ${env:X}   whole word quoted
 *   {secret}            ok            ok                ok
 *   {secret}_v2         ARG DROPPED   ok                ok
 *   {secret}:x          ARG DROPPED   ok                ok
 *   {secret}.json       ARG DROPPED   ARG DROPPED       ok
 *
 * The `.` case is why the braced form alone is not the fix: PowerShell parses
 * `${env:X}.json` as a member access on the string, yields $null, and the
 * argument evaporates — silently shifting the next flag into its slot, which is
 * the exact failure this is supposed to end. Quoting the WHOLE word measured
 * correct for every row above, on both shells, and it keeps a value containing
 * spaces or globs as one argument.
 *
 * The one case that must NOT be quoted is a token the user has already put
 * inside their own quotes (`curl -H "Bearer {secret}"`): the reference is
 * already bounded there, and adding another pair produces
 * `"Bearer "$X""` — measured in bash as `[Bearer pa] [ss*word]`, i.e. the value
 * word-split and glob-expanded. So a word that already contains a `"` gets the
 * bare core and nothing else.
 *
 * Safe from quote-parity problems because `secretValueProblem` refuses a `"` in
 * a Windows secret value.
 */
export function substituteSecretToken(text: string, refCore: string): string {
  if (!text.includes(COMMAND_SECRET_TOKEN)) return text
  // Split on whitespace but KEEP it, so the line is reassembled byte-identical
  // apart from the tokens themselves.
  return text
    .split(/(\s+)/)
    .map((word) => {
      if (!word.includes(COMMAND_SECRET_TOKEN)) return word
      const replaced = word.split(COMMAND_SECRET_TOKEN).join(refCore)
      // The user's own quotes already bound the reference and stop splitting.
      if (word.includes('"')) return replaced
      return `"${replaced}"`
    })
    .join('')
}

/**
 * Why a secret VALUE cannot be carried intact, or null when it can. Shared by
 * both dialogs that take one (the terminal config's secret argument and the
 * command button's) so the rule cannot drift. Line breaks are refused on every
 * platform (a reference expands to one line); the rest is the PowerShell 5.1
 * re-serialisation described on `commandSecretRef`.
 */
export function secretValueProblem(value: string, isWindows: boolean): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  // NUL too: node-pty builds the env block as value + NUL, so a NUL inside a
  // value would end it early and inject a further variable.
  if (/[\r\n\0]/.test(value)) return 'A secret cannot contain a line break or NUL.'
  if (!isWindows) return null
  if (value.includes('"')) return 'On Windows a secret cannot contain a double quote ("): PowerShell cannot pass it to a command intact.'
  if (value.endsWith('\\')) return 'On Windows a secret cannot end with a backslash (\\): PowerShell would swallow the quote after it.'
  // A !NAME! pair expands under cmd's delayed expansion (/V:ON, or the
  // DelayedExpansion registry value) on the way through a .cmd shim; a lone
  // ! is inert. Same class as %NAME%, which is refused below.
  if (/!.+!/.test(value)) return 'On Windows a secret cannot contain a !name! pair: a .cmd-based tool may expand it as a variable.'
  const meta = value.match(/[&|^<>%]/)
  if (meta) return `On Windows a secret cannot contain ${meta[0]}: a .cmd-based tool would re-parse it as a command.`
  return null
}

/**
 * THE rule for what a command button types: `prompt + ' ' + args.join(' ')`,
 * with `{secret}` replaced by the reference when one is given.
 *
 * One function, used by the command bar (what is typed) AND by the dialog's
 * preview (what is shown), so the two cannot disagree. Nothing is quoted for
 * the user — an argument containing a space arrives as two, and the dialog says
 * so. Without a reference the token is left alone: a command with no stored
 * secret types `{secret}` literally, which is visible and harmless, rather than
 * silently typing nothing.
 *
 * THE FIRST FIELD IS SUBSTITUTED TOO (#371). It used to be arguments only, on
 * the reasoning that "the secret is an ARGUMENT" — but a secret can only exist
 * on a SHELL button (the toggle is not offered for a prompt or a page, and a
 * stored value is dropped if one is converted), and on a shell button that
 * field is not a prompt: it is labelled "Command to run" and is typed into the
 * terminal exactly as written. So a user writing `curl -H "Bearer {secret}"`
 * there — the natural place to write a whole invocation — got the literal token
 * typed into their shell. `secretRef` is non-null only for a shell button that
 * has a stored secret, so nothing a Claude prompt types can be touched by this.
 */
export function buildCommandLine(prompt: string, args: readonly string[] | undefined, secretRef?: string | null): string {
  const sub = (s: string) => (secretRef ? substituteSecretToken(s, secretRef) : s)
  // Emptiness is decided on what the user WROTE, before substitution: a command
  // is empty because nothing was typed, never because a token collapsed.
  if (!(prompt ?? '').trim()) return ''
  const p = sub((prompt ?? '').trim()).trim()
  if (!p) return ''
  if (!args || args.length === 0) return p
  return `${p} ${args.map(sub).join(' ')}`
}
