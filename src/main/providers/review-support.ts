// WP2 commit 5b: what every reviewer adapter shares (plan: provider review
// through MCP), moved here from the Codex reviewer (commit 5a) unchanged so
// the Claude reviewer applies exactly the same rules: the environment a
// reviewer inherits, and what of its output goes back to the requesting
// agent. Provider-neutral; imports no provider. It lives beside provider
// core, not in it: core imports only core, shared and Node built-ins, and
// these rules need the app's redactors.
import { redactSecrets } from '../hooks/hook-payload-redactor'
import { redactTokens } from '../github/security/token-redactor'
import { windowsPathFolderIsFullyQualified } from './windows-path-names'

/** A rule and what a match becomes: a replacement string, or a function
 *  that may keep the match as it is. */
type Rule = readonly [RegExp, string | ((match: string, ...groups: string[]) => string)]

/** A secret's name, written with `_`, `-`, a space or nothing between its
 *  words. */
const SECRET_NAME = String.raw`(?:(?:access|refresh|id)[ _-]?token|api[ _-]?key|client[ _-]?secret|session[ _-]?(?:id|token|key)|password|secret|token)`
/** A field whose value failure text hides by its name (SECRET_NAMED,
 *  SESSION_NAMED or the cookie rule), where a field starts: after a `?`,
 *  `#`, `&`, `;` or `,`, its name led by up to 64 letters, digits, `_`,
 *  `.` or `-` (`user_session_id=`). The name is matched first, so most
 *  characters cost one failed test. The same name written anywhere else, as
 *  inside a user name or a password, is not a field. */
const NAMED_FIELD = String.raw`(?=(?:${SECRET_NAME}|session|\b(?:set-)?cookie)[:=])(?<=[?#&;,][\w.-]{0,64})`

/** A part of a URL's userinfo: the characters it may hold, and at most how
 *  many. */
type Run = readonly [chars: string, max: number]
/** The userinfo the shared rule hides, up to its `@`. */
const USERINFO: Run = [String.raw`[^\s/?#"<>\x60]`, 1024]
/** FAILURE_USERINFO's user name, up to its first colon, and its password. */
const USER: Run = [String.raw`[^\s/?#"<>\x60:]`, 256]
const PASSWORD: Run = [String.raw`[^\s/"<>\x60]`, 1024]
/** A run as a regex; with `stop`, it never runs across the start of a
 *  NAMED_FIELD. */
const span = ([chars, max]: Run, stop: boolean) => `${stop ? `(?:(?!${NAMED_FIELD})${chars})` : chars}{1,${max}}`
/** Hides a URL's userinfo, up to its `@`; the scheme stays. */
const userinfoRule = (userinfo: string): Rule => [new RegExp(String.raw`\b([a-z][a-z0-9+.-]{0,31}:\/\/)${userinfo}@`, 'gi'), '$1[REDACTED]@']
/** The shared rule: a URL's userinfo (`user:password@`, or a token as the
 *  user name). The scheme and the host stay; an `@` after the host (a path,
 *  a query, a fragment) or with no `//` before it (mailto, an scp-style
 *  remote) is not one. A match never runs across whitespace, a `/`, `?` or
 *  `#`, a double quote, an angle bracket or a backtick, so a double-quoted
 *  list or markup around a URL keeps its text; any other character, written
 *  raw or encoded, is hidden with the userinfo. Failure text also hides a
 *  password that holds a raw `?` or `#` (FAILURE_USERINFO). */
const URL_USERINFO = userinfoRule(span(USERINFO, false))

/** A private key block, whole. */
const KEY_BLOCK: Rule = [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,16384}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g, '[REDACTED]']
/** Credential shapes that are case-sensitive and token-shaped (a digit, a
 *  length), so prose about "basic validation" or a call to
 *  `rt_sigprocmask` is left alone. Quantifiers are bounded, except a run of
 *  whitespace before a character that cannot be whitespace, which is read
 *  once (linear). */
const TOKEN_SHAPES: ReadonlyArray<Rule> = [
  [/\bsk-(?=[A-Za-z_-]{0,512}[0-9])[A-Za-z0-9_-]{20,512}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9])(?:gh[pousri]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g, '[REDACTED]'],
  [/\bxox[bpsar]-[A-Za-z0-9-]{10,256}/g, '[REDACTED]'],
  [/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED]'],
  KEY_BLOCK,
  [/\b(Bearer|Basic) (?=[A-Za-z._~+/=-]{0,4096}[0-9])[A-Za-z0-9._~+/=-]{16,4096}/g, '$1 [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{6,4096}\.eyJ[A-Za-z0-9_-]{6,4096}(?:\.[A-Za-z0-9_-]{0,4096})?/g, '[REDACTED]'],
  [/\brt_(?=[A-Za-z._-]{0,512}[0-9])[A-Za-z0-9._-]{20,512}/g, '[REDACTED]'],
  [/("(?:access_token|refresh_token|id_token|api_key|apikey|client_secret|OPENAI_API_KEY)"\s*:\s*)"[^"]{0,8192}"/gi, '$1"[REDACTED]"'],
]
/** Credential shapes removed from the review itself. */
const CREDENTIALS: ReadonlyArray<Rule> = [URL_USERINFO, ...TOKEN_SHAPES]
/** A bare `session` field's value: a quoted one, or a token-shaped one
 *  (a digit, or 24 characters or more); an ordinary word after the name is
 *  kept. */
const sessionValue = (match: string, key: string, value: string) =>
  (value.startsWith('"') || /[0-9]/.test(value) || value.length >= 24 ? `${key}[REDACTED]` : match)

/** A cookie header's value, hidden whole but for a Bearer or Basic word
 *  that ends its line as a word of its own: that word stays, so
 *  SCHEME_CREDENTIAL hides the credential written after it, as anywhere
 *  else. */
const cookieValue = (_match: string, key: string, value: string) => {
  const word = /(?<![^ \t"':=;,])(?:bearer|basic)$/i.exec(value.trimEnd())
  return word ? `${key}${word.index ? '[REDACTED] ' : ''}${value.slice(word.index)}` : `${key}[REDACTED]`
}

/** Failure text only: any secret-named field's value, any whitespace from
 *  its name. */
const SECRET_NAMED: Rule = [new RegExp(String.raw`("?${SECRET_NAME}"?\s*[:=]\s*)("[^"]{0,8192}"|[^\s,;}]{1,8192})`, 'gi'), '$1[REDACTED]']
/** Failure text only: a bare session field's quoted or token-shaped value on
 *  the same line as its name. */
const SESSION_NAMED: Rule = [/("?session"?[ \t]{0,64}[:=][ \t]{0,64})("[^"\r\n]{0,8192}"|[^\s,;}]{1,8192})/gi, sessionValue]

/** Failure text only: a URL's userinfo whose password holds a raw `?` or
 *  `#`. The user name runs to its first colon and may hold a raw `@`, as an
 *  e-mail login does; it never runs across whitespace, a `/`, `?` or `#`, so
 *  a query or fragment straight after the host is not read as one. The
 *  password runs to the last `@` before whitespace, a `/`, a double quote,
 *  an angle bracket or a backtick. A review's own text does not use it:
 *  there a URL such as `http://host:8080?to=a@b` is ordinary code, and this
 *  rule would hide its host. */
const FAILURE_USERINFO = (stop: boolean) => userinfoRule(`${span(USER, stop)}:${span(PASSWORD, stop)}`)

/** The start of a field's value: an opening quote or none, then a
 *  character that is not whitespace, another `=`, a quote, a comma, a
 *  semicolon, a closing bracket or any `[` (so never a value already
 *  hidden). */
const VALUE_START = String.raw`["']?[^\s"'=,;})\]>[]`
/** A bare session field's value that its own rule hides: quoted, or
 *  token-shaped. */
const SESSION_VALUE = String.raw`(?:"[^\s"'=,;})\]>[]|[^\s,;}]{0,8191}[0-9]|[^\s,;}]{24})`
/** A token-shaped value as the spaces rule reads one, or one already
 *  hidden. */
const TOKEN_VALUE = String.raw`(?:(?=[A-Za-z0-9._~+/=-]{0,8192}[0-9])[A-Za-z0-9._~+/=-]{8}|[A-Za-z0-9._~+/=-]{24}|\[REDACTED\])`
/** A secret's or a cookie's name. */
const FIELD_NAME = String.raw`(?:${SECRET_NAME}|\b(?:set-)?cookie)"?`
/** The spaces rule's names (in FAILURE_ONLY). */
const SPACES_NAME = String.raw`\b(?:(?:access|refresh|id|session)[ _-]token|api[ _-]key|client[ _-]secret)`
/** What follows a Bearer or Basic word that neither scheme rule takes as
 *  its credential: a field's name, so that field's own rule hides its
 *  value, or a URL's scheme before a user name, so the URL rules hide the
 *  user name and the password. A credential can end in the same letters as
 *  a name; what follows the run tells them apart. The run counts as a name
 *  only where that name's rule still has a value to hide, except that a
 *  secret's or a cookie's name that starts its line counts before any `:`,
 *  a column name (below) also before a value already hidden, and a
 *  cookie's name before an `=` also before a lone Bearer or Basic word.
 *  A name may be led by up to 64 letters, digits, `_`, `.` or `-`.
 *  Before a `:`, a secret's name counts when a character SECRET_NAMED's
 *  value may start with follows it after any whitespace, not hidden yet;
 *  a name the shared rule reads (password, secret, token or api key, its
 *  words joined by `_`, `-` or nothing, with no quote before the `:`)
 *  also counts when three characters that rule's value may hold follow
 *  instead. A cookie's name, with up to 64 spaces or tabs before the `:`,
 *  counts when a value follows on its line as the cookie rule reads one
 *  (any character but a line break, after spaces and tabs), not hidden yet
 *  and more than whitespace, or whitespace and a lone Bearer or Basic word,
 *  to the line's end, whatever whitespace leads that word (the cookie rule
 *  keeps the word; this reads the whole line, past the 8 KiB of a value
 *  the cookie rule reads). SCHEME_CREDENTIAL runs after those rules,
 *  so it takes as its credential a run whose `:` comes before a hidden
 *  value or none. A secret's or a cookie's name also counts before an `=`
 *  with spaces or tabs before it, or an `=` with the value straight after
 *  it; before an `=` with spaces or tabs only after it, when it stands as
 *  a word (first, or after `_`, `.` or `-`). A bare session name counts
 *  before a value its own rule hides, and the spaces rule's names before
 *  spaces and a token-shaped value, as in a column. Any other `=` that
 *  ends the run is a credential's padding, part of it. A URL's scheme
 *  counts before a userinfo as long as the longest one FAILURE_USERINFO
 *  hides. */
const NOT_A_FIELD = '(?!' + [
  String.raw`[\w.-]{0,64}(?:` + [
    String.raw`${SECRET_NAME}"?[ \t]*:(?=\s*(?!\[REDACTED\])[^\s,;}])`,
    String.raw`(?:password|secret|token|api[_-]?key)[ \t]*:(?=\s*(?!\[REDACTED\])[^\s"'&]{3})`,
    String.raw`\b(?:set-)?cookie"?[ \t]{0,64}:[ \t]*(?=[^\r\n \t])(?!\[REDACTED\]|[^\S\r\n]*(?:(?:bearer|basic)[^\S\r\n]*)?(?![^\r\n]))`,
    String.raw`${FIELD_NAME}(?:[ \t]+=[ \t]*|=)${VALUE_START}`,
    String.raw`session"?(?:[ \t]{0,64}:[ \t]{0,64}|[ \t]{1,64}=[ \t]{0,64}|=)${SESSION_VALUE}`,
    String.raw`${SPACES_NAME}[ \t]{1,64}${TOKEN_VALUE}`,
  ].join('|') + ')',
  // A name that starts its line. The lookahead fails on whitespace, so the
  // lookbehind is read once per scheme word.
  String.raw`(?=[\w.-]{0,64}${FIELD_NAME}[ \t]*:)(?<=[\r\n][ \t]*)`,
  String.raw`(?:[\w.-]{0,63}[_.-])?(?:${FIELD_NAME}=[ \t]+${VALUE_START}|session"?=[ \t]{1,64}${SESSION_VALUE})`,
  String.raw`[A-Za-z0-9._~+/=-]{1,4096}:\/\/[^\s/"<>\x60]{1,${USER[1] + 1 + PASSWORD[1]}}@`,
].join('|') + ')'
/** Failure text only: a credential after a Bearer or Basic scheme word and
 *  any whitespace; the spacing is kept. It runs after the URL rules' first
 *  pass and the cookie, secret and session rules, so a value those rules
 *  hide is hidden after a scheme word too. */
const SCHEME_CREDENTIAL: Rule = [new RegExp(String.raw`\b(Bearer|Basic)(\s+)${NOT_A_FIELD}[A-Za-z0-9._~+/=-]{8,4096}`, 'gi'), '$1$2[REDACTED]']
/** Failure text only: a credential after a Bearer or Basic word that is
 *  itself the value of a secret's or a session's name, quoted or not; the
 *  spacing is kept. */
const SCHEME_AFTER_KEY: Rule = [new RegExp(String.raw`("?(?:${SECRET_NAME}|session)"?\s*[:=]\s*["']?)(Bearer|Basic)(\s+)${NOT_A_FIELD}[A-Za-z0-9._~+/=-]{8,4096}`, 'gi'), '$1$2$3[REDACTED]']
/** Failure text runs these before the shared redactors, so a private key
 *  block, or a credential after a Bearer or Basic word, is hidden whole as
 *  the value of a password, secret, token, api key or session too. */
const BEFORE_SHARED: ReadonlyArray<Rule> = [KEY_BLOCK, SCHEME_AFTER_KEY]

/** Failure text only (a review discusses code, where these shapes are
 *  ordinary): looser key forms, a cookie header's value, SECRET_NAMED,
 *  SESSION_NAMED, SCHEME_CREDENTIAL, a token-shaped value after an access,
 *  refresh, id or session token's name, an api key's or a client secret's
 *  (its words joined by `_`, `-` or a space) and spaces, and long hex
 *  keys. In the cookie, bare session and spaces rules a name and its value
 *  may stand up to 64 spaces or tabs apart, as in an aligned column; a
 *  column keeps its spacing. */
const FAILURE_ONLY: ReadonlyArray<Rule> = [
  [/\bsk-[A-Za-z0-9_-]{8,512}/g, '[REDACTED]'],
  [/\brt_[A-Za-z0-9._-]{8,512}/g, '[REDACTED]'],
  [/\b((?:set-)?cookie"?[ \t]{0,64}[:=][ \t]{0,64})([^\r\n]{1,8192})/gi, cookieValue],
  SECRET_NAMED,
  SESSION_NAMED,
  SCHEME_CREDENTIAL,
  [/\b((?:access|refresh|id|session)[ _-]token|api[ _-]key|client[ _-]secret)([ \t]{1,64})(?:(?=[A-Za-z0-9._~+/=-]{0,8192}[0-9])[A-Za-z0-9._~+/=-]{8,8192}|[A-Za-z0-9._~+/=-]{24,8192})/gi, '$1$2[REDACTED]'],
  [/\b[0-9a-f]{32,512}\b/gi, '[REDACTED]'],
]
// Two calls, one per overload of String.replace: a string-or-function union matches neither.
const scrub = (s: string, set: ReadonlyArray<Rule>) => set.reduce((t, [re, to]) => (typeof to === 'string' ? t.replace(re, to) : t.replace(re, to)), s)
/** The review goes to another agent: a credential it quotes does not. */
export const redactReply = (s: string) => scrub(s, CREDENTIALS)
/** Failure text runs its URL rules (FAILURE_USERINFO, then the shared one)
 *  twice. First neither runs across a NAMED_FIELD, so the rule for that
 *  field hides its value whole, even one holding an `@`; then, once each
 *  named field's own rule has run, both run again across the whole URL, so
 *  a userinfo around such a field is hidden as well. */
const FAILURE_RULES: ReadonlyArray<Rule> = [
  FAILURE_USERINFO(true), userinfoRule(span(USERINFO, true)),
  ...TOKEN_SHAPES, ...FAILURE_ONLY,
  FAILURE_USERINFO(false), URL_USERINFO,
]
/** Anything else the CLI printed goes back redacted whole, before it is
 *  shortened, so a cut never splits a secret. */
export const redactFailure = (s: string) => scrub(redactTokens(redactSecrets(scrub(s, BEFORE_SHARED))), FAILURE_RULES)
export const MAX_MESSAGE = 500
export const clip = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)} [...]` : s)

/** Redaction reads a bounded window, never megabytes. Where the window cuts
 *  the text, MARGIN characters next to the cut are dropped after redacting:
 *  a secret the cut split is not matched, and every bounded part of a match,
 *  and of what a rule reads ahead of one, is shorter than MARGIN (the
 *  longest, a private key block, about 16 KiB). */
export const WINDOW = 64 * 1024
export const MARGIN = 20 * 1024
export function redactHead(s: string, redactor: (s: string) => string): string {
  return s.length <= WINDOW + MARGIN ? redactor(s) : redactor(s.slice(0, WINDOW + MARGIN)).slice(0, -MARGIN)
}
export function redactTail(s: string, redactor: (s: string) => string, keep = WINDOW): string {
  return s.length <= keep + MARGIN ? redactor(s) : redactor(s.slice(-(keep + MARGIN))).slice(MARGIN)
}

/** The reply is capped for the MCP result (the tail is the conclusion). */
export const REVIEW_MAX_TEXT = 50 * 1024

/** Variables a reviewer never inherits, in any spelling on Windows: every
 *  Conductor variable of the REQUESTING session or the app (its MCP bearer,
 *  session id, status URL, worktree...). Depth one -- a reviewer must not
 *  reach the Conductor tools, and no per-spawn MCP flags are passed to it. */
export const DEPTH_GUARD_PREFIXES = ['CCC_', 'CONDUCTOR_', 'CLAUDE_MULTI_']

/** A Windows PATH entry as a PATH walk reads it: trimmed, and without the
 *  quotes around a quoted one (then trimmed again). */
function judgedFolder(entry: string): string {
  let dir = entry.trim()
  if (dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1).trim()
  return dir
}

/** The environment a reviewer runs with, from its prepared launch's: no
 *  Conductor variable (depth one), only absolute PATH entries, and on
 *  Windows NoDefaultCurrentDirectoryInExePath=1 for cmd.exe. */
export function reviewerEnv(source: Readonly<Record<string, string>> | undefined, platform: NodeJS.Platform): Record<string, string> {
  const win32 = platform === 'win32'
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(source ?? {})) {
    if (typeof v !== 'string') continue
    const name = win32 ? k.toUpperCase() : k
    if (DEPTH_GUARD_PREFIXES.some((p) => name.startsWith(p))) continue
    env[k] = v
  }
  // Only absolute PATH entries reach the reviewer, and cmd.exe (a .cmd
  // shim) gets NoDefaultCurrentDirectoryInExePath=1. On Windows each entry
  // is read as a PATH walk reads it -- trimmed, and without the quotes
  // around a quoted one -- and kept in that form when it is a fully
  // qualified folder by the rule every PATH filter shares: a drive or a
  // share, never a device path. The reviewer gets exactly the folder that
  // was judged.
  for (const k of Object.keys(env)) {
    if ((win32 ? k.toUpperCase() : k) !== 'PATH') continue
    env[k] = win32 ? env[k].split(';').map(judgedFolder).filter(windowsPathFolderIsFullyQualified).join(';') : env[k].split(':').filter((p) => p.startsWith('/')).join(':')
  }
  if (win32) {
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH') delete env[k]
    env.NoDefaultCurrentDirectoryInExePath = '1'
  }
  return env
}

/** The environment Claude Code's `--version` run gets (its discovery,
 *  review-launch.ts): this process's own string variables through
 *  reviewerEnv. One builder, so the first-start warm-up of a Claude Code
 *  program (ADR-025: the boot version probe, the setup terminal, the
 *  /insights terminal) runs with exactly what discovery's run gets. */
export function claudeVersionRunEnv(source: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): Record<string, string> {
  return reviewerEnv(Object.fromEntries(Object.entries(source ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string')), platform)
}

/** The review as it goes back: token-shaped credentials redacted, and past
 *  REVIEW_MAX_TEXT its tail (the conclusion) with a note that it was cut. */
export function finishReview(text: string): string {
  if (text.length <= REVIEW_MAX_TEXT) return redactReply(text)
  const tail = redactTail(text, redactReply, REVIEW_MAX_TEXT).slice(-REVIEW_MAX_TEXT)
  return `[review truncated -- it exceeded ${REVIEW_MAX_TEXT / 1024} KB]\n\n${tail}`
}
