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

type QuoteState = 'none' | 'single' | 'double'

interface ScannedWord {
  start: number
  end: number
  /** Word 0 of the whole text — the command name when this text is a command line. */
  isWordZero: boolean
  /** The word immediately follows a separator (`;` `|` `&`) or a newline, so it
   *  begins a NEW command regardless of which field the text came from. */
  afterSeparator: boolean
  /** The word contains a quote character somewhere. */
  hasQuote: boolean
  /** A quote region was still open when the word ended (unbalanced quotes). */
  unbalanced: boolean
  /** Quote state at each `{secret}` inside this word. */
  tokens: QuoteState[]
}

/** `\` is bash's escape, `` ` `` is PowerShell's. ANY escape on the line poisons
 *  the whole line: escapes are what fooled the quote scanner in every earlier
 *  round (an escaped quote read as a real quote region), and they are rare in a
 *  command/arguments field, so the safe-and-simple rule is to refuse to place a
 *  secret on a line that carries one. Over-refusing costs a literal token the
 *  user rewrites; under-refusing costs a credential. */
const ESCAPE_CHARS = new Set(['\\', '`'])

/** These end a command, so the NEXT word is a command name — a secret there
 *  would be run, not passed. Newline is handled as whitespace but also flips the
 *  command position (a second line is a second command). */
const SEPARATORS = new Set([';', '|', '&'])

/**
 * Split a shell line into words. A word is substitutable only when it is
 * genuinely simple (see `placementFor`); everything the scanner is not certain
 * about is left literal, so the failure direction is a command that visibly does
 * not work rather than a secret in the wrong place.
 *
 * Deliberately NOT a full shell parser. Three properties are all it needs and
 * all it guarantees: (1) it breaks words on unquoted whitespace AND on the
 * separators `;` `|` `&` and newline, so a token after a separator is seen as a
 * command name in EVERY field; (2) quote state is LOCAL to a word — it is reset
 * at each word boundary — so an unbalanced quote in one word can never shift the
 * classification of a later one; (3) if the line carries any escape char, the
 * whole line is flagged (`lineHasEscape`) and every token on it is refused.
 */
function scanShellWords(text: string): { words: ScannedWord[]; lineHasEscape: boolean } {
  const words: ScannedWord[] = []
  const lineHasEscape = /[\\`]/.test(text)
  let state: QuoteState = 'none'
  let cur: ScannedWord | null = null
  // Whether the NEXT word to begin follows a separator/newline (a new command).
  // It must SURVIVE the whitespace between the separator and the word — `cd .;
  // {secret}` has a space after the `;`, and clearing the flag on that space is
  // exactly how a token after a spaced separator slipped back into an argument.
  let pendingCommand = false
  let isFirstWord = true
  const finish = (end: number) => {
    if (!cur) return
    cur.end = end
    cur.unbalanced = state !== 'none'
    words.push(cur)
    cur = null
    state = 'none' // quote state does NOT carry across a word boundary
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    // An escape consumes the next character so it cannot be read as a quote
    // boundary. The line is already poisoned by `lineHasEscape`; this only keeps
    // the scan from mis-parsing on the way through.
    if (ESCAPE_CHARS.has(ch)) { i += 1; continue }
    if (state === 'none' && /\s/.test(ch)) {
      finish(i)
      // A newline is itself a command separator; ordinary whitespace only ends a
      // word and leaves any pending separator flag alone.
      if (ch === '\n') pendingCommand = true
      continue
    }
    if (state === 'none' && SEPARATORS.has(ch)) {
      finish(i)
      pendingCommand = true
      continue
    }
    if (!cur) {
      cur = { start: i, end: text.length, isWordZero: isFirstWord, afterSeparator: pendingCommand, hasQuote: false, unbalanced: false, tokens: [] }
      isFirstWord = false
      pendingCommand = false // consumed by the word that just began
    }
    if (state === 'none' && (ch === '"' || ch === "'")) {
      state = ch === '"' ? 'double' : 'single'
      cur.hasQuote = true
      continue
    }
    if ((state === 'double' && ch === '"') || (state === 'single' && ch === "'")) {
      state = 'none'
      continue
    }
    if (text.startsWith(COMMAND_SECRET_TOKEN, i)) {
      cur.tokens.push(state)
      i += COMMAND_SECRET_TOKEN.length - 1
    }
  }
  finish(text.length)
  return { words, lineHasEscape }
}

/** What can safely be done with the tokens in one word. */
type Placement =
  | 'none'
  | 'bare'
  | 'wrap'
  | 'unsafe-command-word'
  | 'unsafe-single-quoted'
  | 'unsafe-mixed-quotes'
  | 'unsafe-escaped-quote'
  | 'unsafe-unbalanced'

function placementFor(w: ScannedWord, isCommandLine: boolean, lineHasEscape: boolean): Placement {
  if (w.tokens.length === 0) return 'none'
  // Any escape ANYWHERE on the line makes the quote reading untrustworthy —
  // refuse the whole line, not just the escaped word (an escaped quote in a
  // neighbour shifts nothing here because state is per-word, but the reading is
  // still not one to bet a credential on). Checked before command position so
  // the message names the actual problem.
  if (lineHasEscape) return 'unsafe-escaped-quote'
  // Unbalanced quotes: we cannot tell where the value would land. Refuse.
  if (w.unbalanced) return 'unsafe-unbalanced'
  // A secret is never a command NAME. Wrapping here produces a bare quoted
  // string, which PowerShell evaluates as an expression and PRINTS — the value
  // straight into the terminal and its scrollback. Command position = word 0 of
  // a command LINE (an arguments field is appended AFTER a command, so its word
  // 0 is just another argument), OR the first word after ANY separator, which is
  // a command name in every field.
  if (w.afterSeparator || (w.isWordZero && isCommandLine)) return 'unsafe-command-word'
  const states = new Set(w.tokens)
  // Single quotes suppress expansion in bash AND PowerShell, so there is no
  // reference form at all here — substituting would emit the literal reference
  // text, and wrapping breaks the user's quoting.
  if (states.has('single')) return 'unsafe-single-quoted'
  if (states.has('none')) {
    // An unquoted token in a word that ALSO carries quotes — `-H "Bearer"{secret}`.
    // Measured on PowerShell 5.1 and 7: the value becomes its OWN bare argv
    // entry, which for `curl` is consumed as the URL, so the secret leaves the
    // machine as a DNS lookup. There is no safe form; do not substitute.
    if (w.hasQuote) return 'unsafe-mixed-quotes'
    return 'wrap'
  }
  return 'bare'
}

/**
 * Replace every `{secret}` in `text` with a shell reference — or leave it
 * LITERAL where no reference form is safe.
 *
 * MEASURED, not reasoned about, against a real argv printer on Windows
 * PowerShell 5.1.26100, PowerShell 7 and bash (#371, ADR-009 pass). The rules,
 * and what each one is protecting against:
 *
 * | written                          | emitted            | why |
 * |----------------------------------|--------------------|-----|
 * | `--out {secret}`                 | `"${env:X}"`       | quoting the whole word keeps a spaced/globbing value one argument |
 * | `--out {secret}.json`            | `"${env:X}.json"`  | bare AND braced both DROP the argument — `${env:X}.json` is a member access yielding $null |
 * | `{secret}_v2`, `{secret}:x`, `--token={secret}` | whole word quoted | same |
 * | `-H "Bearer {secret}"`           | bare core inside   | already bounded; adding quotes nests wrongly and word-splits |
 * | `-H "Bearer"{secret}`            | **LEFT LITERAL**   | the quote CLOSES before the token: the value became its own argv entry, which curl consumes as the URL |
 * | `-H 'Bearer {secret}'`           | **LEFT LITERAL**   | single quotes suppress expansion in both shells |
 * | `{secret}` as the FIRST word     | **LEFT LITERAL**   | PowerShell evaluates a bare quoted string and PRINTS the value |
 *
 * Leaving it literal is the safe direction: the command visibly fails with
 * `{secret}` in it, and no value reaches the line, a log, or a broken-quoted
 * argv. `secretPlacementProblem` turns the same analysis into a sentence the
 * dialogs show, so the user is told rather than left guessing.
 */
export function substituteSecretToken(
  text: string,
  refCore: string,
  opts: { isCommandLine?: boolean } = {},
): string {
  if (!text.includes(COMMAND_SECRET_TOKEN)) return text
  const { words, lineHasEscape } = scanShellWords(text)
  let out = ''
  let cursor = 0
  for (const w of words) {
    const placement = placementFor(w, opts.isCommandLine === true, lineHasEscape)
    if (placement === 'none') continue
    const raw = text.slice(w.start, w.end)
    out += text.slice(cursor, w.start)
    if (placement === 'bare') {
      out += raw.split(COMMAND_SECRET_TOKEN).join(refCore)
    } else if (placement === 'wrap') {
      out += `"${raw.split(COMMAND_SECRET_TOKEN).join(refCore)}"`
    } else {
      out += raw // unsafe placement: the token stays exactly as written
    }
    cursor = w.end
  }
  return out + text.slice(cursor)
}

/**
 * Why a `{secret}` in this text cannot be substituted, or null when every
 * occurrence is in a position with a safe reference form.
 *
 * The dialogs surface this: silently leaving a token literal would look like
 * the feature is broken, and the fix is always a small rewrite of the line.
 */
export function secretPlacementProblem(text: string, opts: { isCommandLine?: boolean } = {}): string | null {
  if (typeof text !== 'string' || !text.includes(COMMAND_SECRET_TOKEN)) return null
  const { words, lineHasEscape } = scanShellWords(text)
  // A line with any escape carrying a token is refused as a whole — report it
  // directly, even when the escape SWALLOWED the token's brace (`\{secret}`) so
  // no word was left to classify. Without this the token is left literal with no
  // warning, which looks like the feature silently doing nothing.
  if (lineHasEscape) {
    return `${COMMAND_SECRET_TOKEN} is on a line with a backslash (\\) or backtick (\`). A secret cannot be placed safely there — remove the escape (use forward slashes in paths) or move the secret to a line without one.`
  }
  for (const w of words) {
    switch (placementFor(w, opts.isCommandLine === true, lineHasEscape)) {
      case 'unsafe-command-word':
        return `${COMMAND_SECRET_TOKEN} is in the command position (the start of the line, or just after a ; | or &), where it would be run instead of passed. Put it in an argument.`
      case 'unsafe-single-quoted':
        return `${COMMAND_SECRET_TOKEN} inside single quotes cannot be filled in (a shell does not expand anything in '…'). Use double quotes: "… ${COMMAND_SECRET_TOKEN}".`
      case 'unsafe-mixed-quotes':
        return `${COMMAND_SECRET_TOKEN} sits just outside a quoted section, where the value would become a separate argument. Put it inside the quotes: "… ${COMMAND_SECRET_TOKEN}".`
      case 'unsafe-escaped-quote':
        return `${COMMAND_SECRET_TOKEN} is on a line with a backslash (\\) or backtick (\`). A secret cannot be placed safely there — remove the escape (use forward slashes in paths) or move the secret to a line without one.`
      case 'unsafe-unbalanced':
        return `${COMMAND_SECRET_TOKEN} is in a word with an unclosed quote. Balance the quotes: "… ${COMMAND_SECRET_TOKEN}".`
      default:
        break
    }
  }
  return null
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
  // Emptiness is decided on what the user WROTE, before substitution: a command
  // is empty because nothing was typed, never because a token collapsed.
  const p0 = (prompt ?? '').trim()
  if (!p0) return ''
  // The prompt and the arg chips ARE one shell line once joined — its first word
  // is the program (a command position, where a secret is blocked), every chip
  // after it is an argument unless it follows a `; | &` or newline. So join
  // first and substitute the whole line ONCE: substituting the fields separately
  // could not see a separator at the field boundary (a trailing `;` in the
  // prompt with the secret as the first chip), which would have leaked.
  const joined0 = args && args.length > 0 ? `${p0} ${args.join(' ')}` : p0
  return (secretRef ? substituteSecretToken(joined0, secretRef, { isCommandLine: true }) : joined0).trim()
}
