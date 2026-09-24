// WP2 commit 5b: what every reviewer adapter shares (plan: provider review
// through MCP), moved here from the Codex reviewer (commit 5a) unchanged so
// the Claude reviewer applies exactly the same rules: the environment a
// reviewer inherits, and what of its output goes back to the requesting
// agent. Provider-neutral; imports no provider. It lives beside provider
// core, not in it: core imports only core, shared and Node built-ins, and
// these rules need the app's redactors.
import { redactSecrets } from '../hooks/hook-payload-redactor'
import { redactTokens } from '../github/security/token-redactor'

/** Credential shapes removed from the review itself. Case-sensitive and
 *  token-shaped (a digit, a length), so prose about "basic validation" or a
 *  call to `rt_sigprocmask` is left alone. Quantifiers are bounded. */
const CREDENTIALS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-(?=[A-Za-z_-]{0,512}[0-9])[A-Za-z0-9_-]{20,512}/g, '[REDACTED]'],
  [/(?<![A-Za-z0-9])(?:gh[pousri]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g, '[REDACTED]'],
  [/\bxox[bpsar]-[A-Za-z0-9-]{10,256}/g, '[REDACTED]'],
  [/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED]'],
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,16384}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g, '[REDACTED]'],
  [/\b(Bearer|Basic) (?=[A-Za-z._~+/=-]{0,4096}[0-9])[A-Za-z0-9._~+/=-]{16,4096}/g, '$1 [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{6,4096}\.eyJ[A-Za-z0-9_-]{6,4096}(?:\.[A-Za-z0-9_-]{0,4096})?/g, '[REDACTED]'],
  [/\brt_(?=[A-Za-z._-]{0,512}[0-9])[A-Za-z0-9._-]{20,512}/g, '[REDACTED]'],
  [/("(?:access_token|refresh_token|id_token|api_key|apikey|client_secret|OPENAI_API_KEY)"\s*:\s*)"[^"]{0,8192}"/gi, '$1"[REDACTED]"'],
]
/** Failure text only (a review discusses code, where these shapes are
 *  ordinary): looser key and header forms, any secret-named field's value,
 *  and long hex keys. */
const FAILURE_ONLY: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,512}/g, '[REDACTED]'],
  [/\brt_[A-Za-z0-9._-]{8,512}/g, '[REDACTED]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,4096}/gi, '$1 [REDACTED]'],
  [/("?(?:access_token|refresh_token|id_token|api_key|apikey|client_secret|password|secret|token)"?\s*[:=]\s*)("[^"]{0,8192}"|[^\s,;}]{1,8192})/gi, '$1[REDACTED]'],
  [/\b[0-9a-f]{32,512}\b/gi, '[REDACTED]'],
]
const scrub = (s: string, set: ReadonlyArray<[RegExp, string]>) => set.reduce((t, [re, to]) => t.replace(re, to), s)
/** The review goes to another agent: a credential it quotes does not. */
export const redactReply = (s: string) => scrub(s, CREDENTIALS)
/** Anything else the CLI printed goes back redacted whole, before it is
 *  shortened, so a cut never splits a secret. */
export const redactFailure = (s: string) => scrub(scrub(redactTokens(redactSecrets(s)), CREDENTIALS), FAILURE_ONLY)
export const MAX_MESSAGE = 500
export const clip = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)} [...]` : s)

/** Redaction reads a bounded window, never megabytes. Where the window cuts
 *  the text, MARGIN characters next to the cut are dropped after redacting:
 *  a secret the cut split is not matched, and none is that long (the longest
 *  shape, a private key block, is bounded at 16 KiB). */
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

/** The environment a reviewer runs with, from its prepared launch's: no
 *  Conductor variable (depth one), only absolute PATH entries, and on
 *  Windows a cmd.exe that does not search its current folder first. */
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
  // shim) does not search its current directory before PATH.
  for (const k of Object.keys(env)) {
    if ((win32 ? k.toUpperCase() : k) !== 'PATH') continue
    const sep = win32 ? ';' : ':'
    env[k] = env[k].split(sep).filter((p) => (win32 ? /^"?([A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(p) : p.startsWith('/'))).join(sep)
  }
  if (win32) {
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH') delete env[k]
    env.NoDefaultCurrentDirectoryInExePath = '1'
  }
  return env
}

/** The review as it goes back: token-shaped credentials redacted, and past
 *  REVIEW_MAX_TEXT its tail (the conclusion) with a note that it was cut. */
export function finishReview(text: string): string {
  if (text.length <= REVIEW_MAX_TEXT) return redactReply(text)
  const tail = redactTail(text, redactReply, REVIEW_MAX_TEXT).slice(-REVIEW_MAX_TEXT)
  return `[review truncated -- it exceeded ${REVIEW_MAX_TEXT / 1024} KB]\n\n${tail}`
}
