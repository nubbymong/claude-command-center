/**
 * Transient (non-session) consumers of an account profile's credentials.
 *
 * `isProfileInUseByLiveSession` (claude-account-identity) was built for one kind
 * of consumer: an open PTY session running under a profile home. The usage
 * page's auto token-refresh (usage/account-usage.ts) gates on it before rotating
 * a single-use refresh token — the rule being "don't rotate under a live
 * consumer, or its copy of the token is stranded and the account logs out".
 *
 * #258 added a SECOND kind of consumer that has no session id: the
 * `claude auth status` probe (account-web/claude-cli-auth), which spawns the CLI
 * under a profile home to read its auth state and can itself make the CLI rotate
 * the token. Nothing registered it, so the auto-refresh guard could fire
 * concurrently and strand the account. This registry lets such short-lived
 * consumers mark a profile in-use for the duration of the probe so the same
 * guard covers them. It is ref-counted because probes for one profile can
 * overlap (Sidebar right-click + AccountsPanel mount).
 *
 * Deliberately its own tiny module: it has no Electron/session dependencies, so
 * both the identity module (which reads it) and the auth probe (which writes it)
 * can import it without a cycle, and it is unit-testable on its own.
 */

const refCounts = new Map<string, number>()

/**
 * Mark `profileId` as having a live transient consumer. Returns a release
 * function; call it exactly once (in a `finally`) when the consumer is done.
 * The release is idempotent so a double-call cannot drive the count negative.
 */
export function acquireProfileConsumer(profileId: string): () => void {
  if (!profileId) return () => { /* nothing to track */ }
  refCounts.set(profileId, (refCounts.get(profileId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const next = (refCounts.get(profileId) ?? 1) - 1
    if (next <= 0) refCounts.delete(profileId)
    else refCounts.set(profileId, next)
  }
}

/** True while any transient consumer holds `profileId`. */
export function hasTransientProfileConsumer(profileId: string): boolean {
  return !!profileId && (refCounts.get(profileId) ?? 0) > 0
}
