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

const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /failed to authenticate/i,
  /session (?:has )?expired/i,
  /oauth[^.]*expired/i,
  /(?:could not|couldn't|unable to) refresh(?: the)?(?: oauth)?(?: session| token)?/i,
  /not logged in/i,
  /please (?:run )?\/?login/i,
  /invalid api key/i,
  /authentication[_ ]error/i,
  /\bunauthorized\b/i,
  /credentials (?:are )?(?:invalid|missing|expired)/i
]

/**
 * True when `message` says the account's sign-in is the problem — i.e. the fix is
 * to authenticate again, not to retry or to change the prompt.
 */
export function isAuthFailureMessage(message: string | null | undefined): boolean {
  if (!message) return false
  return AUTH_FAILURE_PATTERNS.some((re) => re.test(message))
}
