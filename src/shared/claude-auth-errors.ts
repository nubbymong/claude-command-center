// claude-auth-errors.ts — recognising "this account needs signing in again" in a
// message the Claude CLI wrote.
//
// Shared because main classifies (it has the CLI's reply) and the renderer reacts
// (it owns the re-auth affordance). Kept as a narrow allow-list of phrases rather
// than anything loose: a false positive tells the user to re-authenticate a
// perfectly good account and sends them into a login shell for nothing, which is
// worse than showing the raw message.
//
// Observed verbatim from a real run:
//   "Failed to authenticate: OAuth session expired and could not be refreshed"

// Every pattern must carry its own AUTH CONTEXT. The first cut did not, and an
// adversarial pass beat it with 11 of 11 real non-auth strings: proxy 401s, VPN
// session timeouts, npm/DNS/licence "refresh" failures. The cause was patterns
// whose distinguishing words were all optional —
// `/(?:could not|unable to) refresh(?: the)?(?: oauth)?(?: session| token)?/i`
// reduces to "unable to refresh", and a bare `/\bunauthorized\b/i` matches any
// HTTP 401 from anything on the network path.
//
// Those two, plus a bare `/session (?:has )?expired/i`, are deliberately GONE.
// Every survivor names Claude's own vocabulary (login, API key, OAuth, the CLI's
// `authentication_error` subtype) or requires "expired"/"refresh" to appear
// alongside a token/OAuth noun. Missing a novel phrasing costs a raw message in
// the UI; a false positive tells the user to re-authenticate a working account and
// walks them into a login shell, which is the worse failure.
const AUTH_FAILURE_PATTERNS: RegExp[] = [
  // The CLI's own phrasings. Strings marked (binary) were extracted from the
  // shipped claude executable by an adversarial pass that beat the previous set.
  /failed to authenticate/i,
  /not logged in/i,
  /\/login\b/i,                    // (binary) "…run /login to reconnect." — no "please"
  /log ?in again/i,                 // (binary) "Expired - log in again"
  /re-?authenticate/i,              // (binary) "you need to re-authenticate with your provider"
  /\bauthentication_error\b/i,
  /invalid api key/i,
  // "expired"/"refresh" only ever counts next to a credential noun.
  /oauth[^.\n]{0,40}(?:expired|refresh)/i,
  /(?:refresh|access|oauth|bearer)[- ]?token[^.\n]{0,40}(?:expired|invalid|revoked)/i,
  /(?:could not|couldn't|unable to) refresh[^.\n]{0,20}(?:oauth|token|credential)/i,
  /credentials (?:are )?(?:invalid|missing|expired|revoked)/i
]

/**
 * True when `message` says the ACCOUNT'S SIGN-IN is the problem — i.e. the fix is
 * to authenticate again, not to retry, wait, or change the prompt.
 *
 * Callers: pass the CLI's own structured reason (`describeClaudeError`), NOT raw
 * stderr. stderr carries proxy, DNS and TLS noise from the whole network path, and
 * this predicate drives a UI action that opens a login shell.
 */
export function isAuthFailureMessage(message: string | null | undefined): boolean {
  if (!message) return false
  return AUTH_FAILURE_PATTERNS.some((re) => re.test(message))
}

/** The non-prose facts from a `claude -p --output-format json` failure envelope. */
export interface ClaudeFailureFacts {
  /** `is_error === true`. */
  isError: boolean
  /**
   * The request actually reached the API — any token counted, or a non-zero
   * `duration_api_ms`. This is the load-bearing field; see isAuthFailure.
   */
  apiReached: boolean
  /** Human-readable reason from describeClaudeError. May contain MODEL prose. */
  reason: string | null
}

/**
 * Is this failure the account's sign-in?
 *
 * Phrase matching alone is not safe here and two rounds of adversarial review
 * proved it. `describeClaudeError` folds the envelope's `result` field into its
 * reason, and on a failure where the model RAN, `result` is the model's own free
 * text — generated from a prompt that embeds the user's report content. An
 * attacker (or an unlucky topic) can put "OAuth … refresh" or "credentials are
 * missing" in there, and the classifier drove a UI action that opens a login
 * shell. Tightening the regexes shrank that surface twice and never closed it.
 *
 * So the gate is STRUCTURAL, not lexical: an authentication failure happens
 * BEFORE the request is served, so it spends no tokens and reaches no API. The
 * real failures observed carry `duration_api_ms: 0` with every usage counter at
 * zero. If the API was reached, whatever `result` says is model output and is
 * never treated as an auth verdict — no phrase list can be talked into it.
 *
 * Cost of being wrong in the safe direction: an auth failure that somehow spends
 * tokens shows its raw reason instead of a Sign-in button. That is a worse
 * message, not a wrong action.
 */
export function isAuthFailure(facts: ClaudeFailureFacts): boolean {
  if (!facts.isError) return false
  if (facts.apiReached) return false
  return isAuthFailureMessage(facts.reason)
}
