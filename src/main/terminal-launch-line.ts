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
 *  variable reference removes the question from the SHELL'S parse.
 *
 *  It does NOT, on its own, make the value one argument. PowerShell does not
 *  word-split `$env:VAR`, but a native command does not receive an argument
 *  array from PowerShell at all: the binder re-serialises every argument into
 *  one command line, and CommandLineToArgvW in the child re-splits it. See
 *  {@link askPromptEnvValue}, which is what makes the value survive that round
 *  trip. The two must be read together — this reference is only half of it.
 *
 *  Quoted on POSIX, where `"$VAR"` genuinely is one word after expansion. */
export function askPromptRef(isWindows: boolean): string {
  return isWindows ? '$env:CCC_ASK_PROMPT' : '"$CCC_ASK_PROMPT"'
}

/** Control, format and separator characters, stripped from the question on
 *  every platform. `\s` (what the renderer collapses with) covers CR/LF/TAB and
 *  Unicode spaces and NOTHING ELSE — ESC, BEL, NUL and the bidi overrides all
 *  pass straight through it. Same class the canvas store strips for the same
 *  reason (canvas-store.ts FORMAT_CONTROLS_RE). */
const QUESTION_CONTROLS_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * The value {@link askPromptRef} must expand to. This is the injection
 * boundary for the Ask Conductor question — not the reference, and not the
 * IPC schema.
 *
 * WHY THIS EXISTS. Windows PowerShell 5.1 (the shell buildClaudeLocalSpawn
 * hardcodes) binds a native command's arguments by writing them into a single
 * command line. Its NeedQuotes scan wraps an argument in `"…"` when it contains
 * whitespace at even quote depth, then appends the argument VERBATIM — an
 * embedded `"` is never escaped. So quote parity flips and the child's
 * CommandLineToArgvW re-splits the value. Measured on 5.1.26100.9202 with the
 * exact line this file builds:
 *
 *   `A tip … says: "Session Presets" -- …`  →  TWO arguments (the app's own
 *      "Discuss this tip" wording does this, with no attacker involved)
 *   `how do I fix this" --dangerously-skip-permissions "thanks`
 *      →  `--dangerously-skip-permissions` as an argument of its own
 *
 * THE RULE, which the tests pin: on Windows the value carries no `"` and always
 * ends in a space.
 *
 *  - no `"` → quote parity can never flip, so the binder's decision is a pure
 *    function of "does it contain whitespace";
 *  - a trailing space → it always DOES, so the binder always quotes. That also
 *    guarantees the value never ends in `\`, which would otherwise escape the
 *    closing quote and truncate the argument (`path is C:\temp\` came back as
 *    `path is C:\temp"`).
 *
 * Always-quoted buys the `claude.cmd` case too: an npm-installed CLI is a batch
 * shim, so cmd.exe re-parses the line before forwarding `%*`, and `&`/`|`/`^`
 * are live in an UNQUOTED token (`foo&whoami` ran whoami). Inside quotes they
 * are inert. `%VAR%` is still expanded by cmd.exe there — cmd expands inside
 * quotes too — which substitutes the user's own environment into their own
 * question. That is a cosmetic leak into their own prompt, not execution, and
 * is left alone rather than mangling every `%` in ordinary English.
 *
 * The `"` → `”` substitution is deliberate and visible: a typographic quote
 * reads identically in the question, and keeping the user's words is worth more
 * than a straight quote. Escaping as `\"` also parses correctly on this host,
 * but it depends on the binder's backslash handling, which differs across
 * PowerShell versions — this rule depends on nothing.
 *
 * POSIX needs none of it: `"$CCC_ASK_PROMPT"` is expanded after tokenising, so
 * quotes, globs, `$(…)` and `;` are all literal (verified against real bash).
 */
export function askPromptEnvValue(question: string, isWindows: boolean): string {
  // Main does not trust the renderer's normalisation: NUL is the one that
  // matters, because node-pty (unlike child_process) will happily put it in an
  // environment block, where it terminates the entry early and everything after
  // it is parsed as FURTHER environment variables.
  const clean = question.replace(QUESTION_CONTROLS_RE, ' ').replace(/ {2,}/g, ' ').trim()
  if (!clean) return ''
  if (!isWindows) return clean
  return `${clean.replace(/"/g, '\u201d')} `
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
