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
import { secretRefCore, substituteSecretToken } from '../shared/command-secret'

export interface TerminalLaunchOptions {
  command?: string
  args?: string
  hasSecretArg?: boolean
}

/** Shell-appropriate reference to the secret env var. Quoted on POSIX so a
 *  secret containing spaces or globs stays a single argument.
 *
 *  On Windows the reference is BRACED — `${env:NAME}`, not `$env:NAME`. The
 *  bare form is unbounded, so an adjacent character runs into the name:
 *  `{secret}.json` becomes `$env:CCC_ARG_SECRET.json` (a member access on a
 *  string, yielding nothing) and `{secret}_v2` reads as a longer variable name.
 *  Either way the argument vanishes and the next flag shifts into its slot.
 *  The braced form ends where the name ends, on PowerShell 5.1 and 7 alike.
 *
 *  This is the fix `shared/command-secret`'s `commandSecretRef` already took
 *  for command buttons (measured in the ADR-009 pass on #386); the terminal
 *  config path never had it back-ported, which is the adjacency case the
 *  beta.16 pass recorded as "handed to the child literally" (#371).
 *
 *  A reference alone still does NOT make the value one argument: PowerShell 5.1
 *  re-serialises native-command arguments into one line and never escapes an
 *  embedded `"`, so a value holding `"`, a trailing `\`, a `!name!` pair or
 *  `&|^<>%` (through a .cmd shim) breaks the child's argv. Those values are
 *  REFUSED at the dialog by shared/command-secret's `secretValueProblem` (the
 *  same rule the command-button secret uses); what passes arrives intact --
 *  measured on 5.1, ADR-009 pass, beta.16. */
export function secretRef(isWindows: boolean): string {
  return secretRefCore('CCC_ARG_SECRET', isWindows)
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
 * quotes too — so a question naming a variable substitutes the user's own
 * environment into their own prompt. Left alone rather than mangling every `%`
 * in ordinary English: the question can only NAME a variable, never set one.
 * (If a variable's VALUE contained a `"`, that expansion would reopen cmd's
 * quoting — but writing such a value into the session's environment is already
 * the same-user local-trust boundary this app accepts elsewhere, and it is not
 * reachable from the question text.)
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

/** The variable a Windows Claude session's agent templates ride in. The
 *  launch line carries only {@link agentsRef} after `--agents`, never the
 *  templates; the value is {@link agentsEnvValue}'s. App-owned: one inherited
 *  from the app's own environment is removed before every local session
 *  starts (buildClaudeLocalSpawn). */
export const AGENTS_ENV = 'CCC_AGENTS'

/** The reference to {@link AGENTS_ENV} a Windows launch line carries after
 *  `--agents`. Braced, so it ends where the name ends whatever follows it. */
export function agentsRef(): string {
  return '${env:CCC_AGENTS}'
}

/** The statement a Windows launch line that carries {@link agentsRef} starts
 *  with. Windows PowerShell 5.1, the session shell (localSessionShell),
 *  always passes a program's arguments this way and reads the line as an
 *  ordinary variable nothing uses. PowerShell 7.3 and later pass an `.exe`'s
 *  arguments their own way by default, which would hand Claude Code the
 *  escapes of {@link agentsEnvValue} as text; with this the same line hands
 *  the templates over unchanged there too. */
export const PS_LEGACY_ARGUMENT_PASSING = "$PSNativeCommandArgumentPassing = 'Legacy'"

/** Whether Windows starts `program` itself, as an `.exe` file (a trailing dot
 *  or space aside, which Windows drops), rather than through cmd.exe or by a
 *  name PowerShell looks up. */
function startsAsExe(program: string): boolean {
  return /\.exe[. ]*$/i.test(program)
}

/** The longest command line cmd.exe reads, in characters. */
export const CMD_EXE_LINE_LIMIT = 8_191

/** The longest command line Windows lets `program`, the program a launch line
 *  starts, be handed, in characters: 32766 for an `.exe` started directly
 *  (CreateProcess's 32767, its terminating null included), and cmd.exe's
 *  (CMD_EXE_LINE_LIMIT) for anything else: a `.cmd` or `.bat` launcher, which
 *  cmd.exe runs, and `node`, whose resume picker may start one through
 *  cmd.exe. */
export function windowsCommandLineLimit(program: string): number {
  return startsAsExe(program) ? 32_766 : CMD_EXE_LINE_LIMIT
}

/**
 * The value {@link agentsRef} must expand to on Windows, for `program`, the
 * program the launch line starts: Claude Code's path, or `node`, which runs
 * the resume picker (claudeLaunchProgram). `agents` is the JSON value Claude
 * Code's `--agents` takes (claudeAgentsObject); Claude Code must get it as ONE
 * argument that parses to exactly that value.
 *
 * WHY. PowerShell does not hand a program an argument array: it writes the
 * arguments into one command line that the program's own parser splits again,
 * and for a program it starts through cmd.exe (npm's claude.cmd) cmd.exe reads
 * that line first. The value is written so that every one of those readers
 * gives Claude Code the same JSON.
 *
 * THE RULE. First, inside the JSON's strings, every `"`, `%`, `!` and control
 * character, and a `\` that ends a string, is written as a `\u` escape,
 * which JSON.parse reads as the same character: then no `"` follows a `\`,
 * and cmd.exe finds nothing to expand. Then:
 *  - a program started as an `.exe` file: every `"` as `\"`, and a space at
 *    the end. The space makes PowerShell wrap the value in quotes whichever way
 *    its version counts a `\"`, and inside quotes `\"` is one literal quote to
 *    every parser in use (the C runtime's, CommandLineToArgvW). Claude Code gets
 *    the JSON and a trailing space, which JSON.parse ignores.
 *  - any other program (a `.cmd` or `.bat` file, which Windows hands to
 *    cmd.exe, or `node`, which PowerShell finds by name and may find as a batch
 *    file): the JSON in one pair of quotes, every `"` inside it doubled. Its
 *    whitespace is all at an odd quote count, so PowerShell never wraps it
 *    again; cmd.exe's quote state turns twice at every pair, so every other
 *    character stays inside quotes, where `& | < > ^ ( )` are text; and node
 *    (the C runtime rule) reads a doubled quote inside quotes as one quote.
 *    Never for an `.exe` started directly: CommandLineToArgvW reads a doubled
 *    quote another way (the measured line split into 11 arguments), and the
 *    native Claude Code's own parser is not this function's to assume.
 *
 * Measured with Windows PowerShell 5.1 and PowerShell 7.6 (the latter with
 * PS_LEGACY_ARGUMENT_PASSING, as the line sets it), to npm's claude.cmd, a
 * `.bat` launcher running node, the resume picker and a .NET program: the
 * argument parsed to the templates every time. The `\u` escapes keep the
 * doubled form whole under PowerShell 7, whose quote count skips a `"` after a
 * `\`; the doubled form keeps every character inside cmd.exe's quotes.
 *
 * A value whose strings hold no `"`, `%`, `!` or control character, and none
 * that ends in a `\`, reaches Claude Code exactly as JSON.stringify wrote it
 * (with the trailing space for an `.exe`).
 */
export function agentsEnvValue(agents: unknown, program: string): string {
  const plain = JSON.stringify(agents)
    // Every backslash in JSON text starts an escape of two characters (or six,
    // `\uXXXX`, whose last five are never a backslash); read left to right, a
    // `\"` or `\\` matched here is always one whole escape, and a `"` right
    // after a `\\` is the end of its string. Every other `\\` stays as it
    // is: no `"` follows it.
    .replace(/\\(["\\])/g, (escape: string, c: string, at: number, json: string) => {
      if (c === '"') return '\\u0022'
      return json[at + 2] === '"' ? '\\u005c' : escape
    })
    // Outside its strings JSON text holds none of these.
    .replace(/[%!\p{Cc}]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  if (startsAsExe(program)) return `${plain.replace(/"/g, '\\"')} `
  return `"${plain.replace(/"/g, '""')}"`
}

/**
 * Returns the command line to run, or '' when nothing should be run.
 * With no secret stored, `{secret}` collapses to an empty string rather than
 * leaving a dangling variable name the shell would expand to nothing anyway.
 */
export function buildTerminalLaunchLine(opts: TerminalLaunchOptions | undefined, isWindows: boolean): string {
  // `{secret}` is substituted in the COMMAND as well as the arguments (#371).
  // The two fields become one shell line the moment they are joined, and the
  // command field is where a user naturally writes a whole invocation
  // (`curl -H "Bearer {secret}" ...`). Writing it there used to type the
  // literal token -- the "handed over literally" case the beta.16 pass noted.
  const command0 = (opts?.command ?? '').trim()
  if (!command0) return ''
  // With NO secret stored the token is left LITERAL rather than replaced with
  // nothing (#371). The two builders disagreed here and this one silently
  // dropped it: `mytool --token {secret}` became `mytool --token`, which runs
  // without a credential instead of failing loudly, and a command field holding
  // only the token vanished entirely. `buildCommandLine`'s rule -- visible and
  // harmless beats silently typing nothing -- is the right one, so both follow
  // it now.
  const ref = opts?.hasSecretArg ? secretRef(isWindows) : null
  // Join the two fields FIRST, then substitute the whole line once. They become
  // one shell line the moment they are joined, so a separator ending the command
  // (`curl ;`) has to make the first argument a command position too — which
  // substituting the fields SEPARATELY could not see, leaking a secret typed as
  // the first argument after a trailing `;`. As one line: word 0 is the program
  // (a command position, blocked); every later word is an argument unless it
  // follows a `; | &` or newline, which is a command position in any field.
  const args0 = (opts?.args ?? '').trim()
  const joined0 = args0 ? `${command0} ${args0}` : command0
  return (ref ? substituteSecretToken(joined0, ref, { isCommandLine: true }) : joined0).trim()
}
