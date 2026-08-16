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

/**
 * A ref older than this is a LEAK, and is swept. The one consumer here is the
 * `claude auth status` probe, bounded by a 10s subprocess timeout whose `finally`
 * releases the ref; a ref that outlives 3x that could only be one whose release
 * never ran (a hung/orphaned CLI that never let the promise settle). Left forever
 * it would block the usage-page auto token-refresh AND make the profile read as
 * "in use by a live session" that does not exist — an account that cannot be
 * deleted until the app restarts. Expiring it bounds that consequence.
 */
export const PROFILE_CONSUMER_MAX_AGE_MS = 30_000

interface ConsumerEntry {
  count: number
  /** Epoch ms after which an unreleased ref is treated as leaked. */
  expires: number
}

const entries = new Map<string, ConsumerEntry>()

/**
 * Mark `profileId` as having a live transient consumer. Returns a release
 * function; call it exactly once (in a `finally`) when the consumer is done.
 * The release is idempotent so a double-call cannot drive the count negative.
 * Each acquire refreshes the leak-expiry window, so overlapping live probes keep
 * the profile marked; only a ref with no release and no fresh acquire expires.
 */
export function acquireProfileConsumer(profileId: string): () => void {
  if (!profileId) return () => { /* nothing to track */ }
  const cur = entries.get(profileId)
  entries.set(profileId, { count: (cur?.count ?? 0) + 1, expires: Date.now() + PROFILE_CONSUMER_MAX_AGE_MS })
  let released = false
  return () => {
    if (released) return
    released = true
    const e = entries.get(profileId)
    if (!e) return
    if (e.count <= 1) entries.delete(profileId)
    else entries.set(profileId, { count: e.count - 1, expires: e.expires })
  }
}

/** True while any transient consumer holds `profileId` (and has not leaked). */
export function hasTransientProfileConsumer(profileId: string): boolean {
  if (!profileId) return false
  const e = entries.get(profileId)
  if (!e) return false
  // Self-heal a leaked ref rather than block refresh / stranding the account
  // forever: a consumer past the max age can only be one whose release() never
  // ran. Sweep it on read so no timer or background sweep is needed.
  if (Date.now() >= e.expires) { entries.delete(profileId); return false }
  return e.count > 0
}
