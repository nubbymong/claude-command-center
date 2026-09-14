/**
 * Consumers of an account profile's credentials that are not interactive
 * sessions -- and the one writer that may be rotating those credentials.
 *
 * `isProfileInUseByLiveSession` (claude-account-identity) was built for one kind
 * of consumer: an open PTY session running under a profile home. The usage
 * page's auto token-refresh (usage/account-usage.ts) gates on it before rotating
 * a single-use refresh token -- the rule being "don't rotate under a live
 * consumer, or its copy of the token is stranded and the account logs out" --
 * and the account-delete handler gates on it before tearing a home down.
 *
 * #258 added a SECOND kind of consumer that has no session id: the
 * `claude auth status` probe (account-web/claude-cli-auth), which spawns the CLI
 * under a profile home to read its auth state and can itself make the CLI rotate
 * the token. This registry lets such consumers mark a profile in-use for their
 * duration so the same guard covers them.
 *
 * #48 (rc.14 review F4) found four more that ran under a profile home without
 * registering: the headless spawner (claude-headless), an Insights run, a cloud
 * agent, and a shell-only session pinned to a profile (a plain shell, or the
 * add-account /login shell), which by design never captures an identity. Each
 * now holds a ref for its whole life, released on its exit path. Those lives are
 * minutes to days, not the probe's 10s, so a ref carries its OWN leak bound:
 * see `AcquireProfileConsumerOptions.maxAgeMs`.
 *
 * #49 (F5) is the same race from the other side: a consumer STARTING while a
 * refresh POST is already in flight reads the old credential file and can later
 * redeem the same single-use refresh token. The refresh registers itself here
 * (`noteProfileRefreshInFlight`) and a consumer that can wait does
 * (`waitForProfileRefresh`) -- one registry, both orderings, no coordinator.
 *
 * Deliberately its own tiny module: it has no Electron/session dependencies, so
 * the identity module (which reads it), the auth probe, the headless spawner and
 * the usage refresh (which write it) can all import it without a cycle, and it
 * is unit-testable on its own.
 */

/**
 * The default leak bound. A ref older than this with no release is a LEAK and is
 * swept. It fits the `claude auth status` probe: a 10s subprocess timeout whose
 * `finally` releases the ref, so a ref that outlives 3x that could only be one
 * whose release never ran (a hung/orphaned CLI that never let the promise
 * settle). Left forever it would block the usage-page auto token-refresh AND
 * make the profile read as "in use by a live session" that does not exist -- an
 * account that cannot be deleted until the app restarts. Expiring it bounds
 * that consequence.
 */
export const PROFILE_CONSUMER_MAX_AGE_MS = 30_000

export interface AcquireProfileConsumerOptions {
  /**
   * How long an UNRELEASED ref counts before it is treated as leaked and swept.
   * Default `PROFILE_CONSUMER_MAX_AGE_MS`, sized for the probe. A longer-lived
   * consumer passes its own hard bound (a headless run's kill timeout plus a
   * grace), or `Infinity` when its release is tied to a process-exit event that
   * always fires (a cloud agent's child 'close'/'error', a PTY's onExit, an
   * Insights run's `finally`). An agent that runs for an hour is genuinely in
   * use for that hour; sweeping it at 30s would reopen the very stranding
   * window the ref exists to close, so for those the exit event is the bound.
   */
  maxAgeMs?: number
}

interface ConsumerRef {
  /** Epoch ms after which this unreleased ref is treated as leaked; Infinity = never. */
  expires: number
}

/** Live refs per profile. Each acquire is its own ref with its own expiry, so a
 *  short probe lapsing never sweeps a long agent it happened to overlap. */
const refsByProfile = new Map<string, Set<ConsumerRef>>()

/**
 * Mark `profileId` as having a live consumer. Returns a release function; call
 * it exactly once (in a `finally` / on the exit event) when the consumer is
 * done. The release is idempotent so a double-call cannot drop another holder's
 * ref. Overlapping consumers of one profile are independent refs: the profile
 * reads in-use until the LAST of them releases or expires.
 */
export function acquireProfileConsumer(profileId: string, opts?: AcquireProfileConsumerOptions): () => void {
  if (!profileId) return () => { /* nothing to track */ }
  const maxAge = opts?.maxAgeMs ?? PROFILE_CONSUMER_MAX_AGE_MS
  const ref: ConsumerRef = { expires: Number.isFinite(maxAge) ? Date.now() + maxAge : Infinity }
  let refs = refsByProfile.get(profileId)
  if (!refs) {
    refs = new Set()
    refsByProfile.set(profileId, refs)
  }
  refs.add(ref)
  let released = false
  return () => {
    if (released) return
    released = true
    const cur = refsByProfile.get(profileId)
    if (!cur) return
    cur.delete(ref)
    if (cur.size === 0) refsByProfile.delete(profileId)
  }
}

/** Sweep leaked refs for one profile (on read -- no timer, no background sweep). */
function liveRefs(profileId: string): Set<ConsumerRef> | undefined {
  const refs = refsByProfile.get(profileId)
  if (!refs) return undefined
  const now = Date.now()
  // Self-heal a leaked ref rather than block refresh / strand the account
  // forever: a ref past its own max age can only be one whose release() never
  // ran. Each ref is judged on its own clock.
  for (const ref of refs) if (now >= ref.expires) refs.delete(ref)
  if (refs.size === 0) {
    refsByProfile.delete(profileId)
    return undefined
  }
  return refs
}

/** True while any consumer holds `profileId` (and has not leaked). */
export function hasTransientProfileConsumer(profileId: string): boolean {
  if (!profileId) return false
  return liveRefs(profileId) !== undefined
}

/** How many live consumers hold `profileId` right now (diagnostics / tests). */
export function profileConsumerCount(profileId: string): number {
  if (!profileId) return 0
  return liveRefs(profileId)?.size ?? 0
}

// ── The other ordering (#49): a refresh already in flight ─────────────────────

/** The refresh currently rotating each profile's token, while it runs. */
const refreshByProfile = new Map<string, Promise<unknown>>()

/**
 * Record that `refresh` is rotating `profileId`'s token. Cleared when it settles
 * either way -- a failed refresh leaves the credentials untouched, so there is
 * nothing to wait for after it. Only the promise that registered is cleared, so
 * a newer refresh that replaced it is never dropped by the older one settling.
 */
export function noteProfileRefreshInFlight(profileId: string, refresh: Promise<unknown>): void {
  if (!profileId) return
  refreshByProfile.set(profileId, refresh)
  const clear = (): void => {
    if (refreshByProfile.get(profileId) === refresh) refreshByProfile.delete(profileId)
  }
  refresh.then(clear, clear)
}

/**
 * The in-flight refresh for `profileId` as a settle-only promise (never rejects),
 * or null when nothing is rotating. Callers that must not turn a synchronous
 * spawn into an asynchronous one when there is nothing to wait for use this
 * (claude-headless keeps its spawn synchronous unless a refresh is pending).
 */
export function pendingProfileRefresh(profileId: string): Promise<void> | null {
  const p = profileId ? refreshByProfile.get(profileId) : undefined
  return p ? p.then(() => undefined, () => undefined) : null
}

/**
 * Wait for any in-flight refresh of `profileId` to settle, so a consumer that
 * starts now reads the NEW credential lineage rather than a refresh token that
 * is about to be spent. Resolves at once when nothing is in flight; never
 * rejects (a failed refresh is not the consumer's failure).
 */
export async function waitForProfileRefresh(profileId: string): Promise<void> {
  const p = pendingProfileRefresh(profileId)
  if (p) await p
}

/** Test seam: forget every ref and every in-flight refresh. */
export function _resetProfileConsumersForTest(): void {
  refsByProfile.clear()
  refreshByProfile.clear()
}
