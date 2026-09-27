// WP2 commit 3: the consumer lease registry (design 11; plan A11). One per
// main process. Everything that runs on an account -- a session, a reviewer
// invocation, a sign-in, a status or sign-out operation -- holds a lease on
// it for as long as it runs,
// and every lifecycle change that would pull the account out from under a
// consumer (inactivate, archive, sign out, disable the provider) reads the
// count under the registry lock that applies the change.
//
// Guarantees:
// - Account-scoped and reference-counted: one lease per (kind, owner), so
//   the same session or sign-in can never be counted twice, and N sessions
//   on one account count N.
// - Release is idempotent: releasing a lease twice, or releasing it after its
//   owner was already swept, never drops another consumer's count.
// - A lease a renderer holds (a sign-in it started) is released when that
//   renderer is destroyed; a session's or a reviewer's lease belongs to its
//   process, not to a window, and is released when the process ends.
// - Sessions and reviewer invocations are the two kinds of launch: both are
//   bound through the account's own launch binding and both block every
//   change that would pull the account out from under them.
// - An exclusive hold (a sign-out or archive in progress) refuses every new
//   lease on that account until it is let go, and is only granted while the
//   account has no consumers: the check and the change cannot interleave.
// - In memory only. Nothing survives the main process, and no consumer does
//   either (sessions die with it), so there is never a stale lease to reclaim
//   at start-up.
//
// Acquisition does not check the account itself: the accounts service does,
// under the registry lock, and only then adds the lease here.
import type { ProviderId } from '../../../shared/providers'

export type LeaseKind = 'session' | 'review' | 'sign-in' | 'operation'
/** The kinds a launch takes: an interactive session, or a one-shot,
 *  non-interactive reviewer process of the reviewing provider. */
export type LaunchLeaseKind = Extract<LeaseKind, 'session' | 'review'>
export const LAUNCH_LEASE_KINDS: readonly LaunchLeaseKind[] = ['session', 'review']

export interface LeaseOwner {
  kind: LeaseKind
  /** The session id, review id, setup id or operation id: unique per kind. */
  ownerId: string
  /** The renderer that started it, when its lifetime is that renderer's. */
  webContentsId?: number
}

export interface AccountLease {
  readonly id: number
  readonly accountId: string
  readonly providerId: ProviderId
  readonly kind: LeaseKind
  readonly ownerId: string
  /** Idempotent. */
  release(): void
  readonly released: boolean
}

export type LeaseAddResult =
  | { ok: true; lease: AccountLease; existing: boolean }
  | { ok: false; code: 'held' | 'owner-conflict' }

interface Entry {
  lease: AccountLease
  webContentsId?: number
}

export class ConsumerLeaseRegistry {
  private seq = 0
  private readonly byKey = new Map<string, Entry>()
  private readonly exclusive = new Map<string, { token: symbol; providerId: ProviderId }>()
  private readonly listeners = new Set<(accountId: string) => void>()

  /** Notified after every change to an account's consumers. */
  subscribe(listener: (accountId: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Every lease on the account. */
  count(accountId: string): number {
    let n = 0
    for (const e of this.byKey.values()) if (e.lease.accountId === accountId) n++
    return n
  }

  /** Sessions only: the "N running" the surface shows. */
  runningSessions(accountId: string): number {
    return this.countKind(accountId, 'session')
  }

  /** Leases of one kind on the account. */
  countKind(accountId: string, kind: LeaseKind): number {
    let n = 0
    for (const e of this.byKey.values()) if (e.lease.accountId === accountId && e.lease.kind === kind) n++
    return n
  }

  /** Every lease on any account of the provider, and every exclusive hold
   *  (a sign-out, archive or abandon running on one of its accounts): what a
   *  provider switch-off must wait for. */
  countForProvider(providerId: ProviderId): number {
    let n = 0
    for (const e of this.byKey.values()) if (e.lease.providerId === providerId) n++
    for (const h of this.exclusive.values()) if (h.providerId === providerId) n++
    return n
  }

  /** Who holds the account, for a "blocked by" message. Kinds and counts only. */
  describe(accountId: string): Readonly<Record<LeaseKind, number>> {
    const out: Record<LeaseKind, number> = { session: 0, review: 0, 'sign-in': 0, operation: 0 }
    for (const e of this.byKey.values()) if (e.lease.accountId === accountId) out[e.lease.kind]++
    return out
  }

  isHeld(accountId: string): boolean {
    return this.exclusive.has(accountId)
  }

  /** Add a lease. The caller has already checked the account under the
   *  registry lock. The same owner again on the same account returns its
   *  existing lease (counted once); on another account it is refused. */
  add(accountId: string, providerId: ProviderId, owner: LeaseOwner): LeaseAddResult {
    const key = `${owner.kind}|${owner.ownerId}`
    const had = this.byKey.get(key)
    if (had) return had.lease.accountId === accountId ? { ok: true, lease: had.lease, existing: true } : { ok: false, code: 'owner-conflict' }
    if (this.exclusive.has(accountId)) return { ok: false, code: 'held' }
    const id = ++this.seq
    let released = false
    const lease: AccountLease = {
      id, accountId, providerId, kind: owner.kind, ownerId: owner.ownerId,
      get released() { return released },
      release: () => {
        if (released) return
        released = true
        // Only this lease's own entry: a later lease under the same key (the
        // owner re-acquired after release) is another lease.
        if (this.byKey.get(key)?.lease === lease) this.byKey.delete(key)
        this.emit(accountId)
      },
    }
    this.byKey.set(key, { lease, ...(owner.webContentsId !== undefined ? { webContentsId: owner.webContentsId } : {}) })
    this.emit(accountId)
    return { ok: true, lease, existing: false }
  }

  /** Take the account exclusively: only while nothing holds it. Returns the
   *  release, or null when it is in use or already held. */
  hold(accountId: string, providerId: ProviderId): (() => void) | null {
    if (this.exclusive.has(accountId) || this.count(accountId) > 0) return null
    const token = Symbol('exclusive')
    this.exclusive.set(accountId, { token, providerId })
    let done = false
    return () => {
      if (done) return
      done = true
      if (this.exclusive.get(accountId)?.token === token) this.exclusive.delete(accountId)
    }
  }

  /** Release the lease of one owner (a session that ended). */
  releaseOwner(kind: LeaseKind, ownerId: string): boolean {
    const e = this.byKey.get(`${kind}|${ownerId}`)
    if (!e) return false
    e.lease.release()
    return true
  }

  /** Release every lease a destroyed renderer held, except those `keep`
   *  names: a run still stopping releases its own lease when it has stopped. */
  releaseForRenderer(webContentsId: number, keep?: (lease: AccountLease) => boolean): number {
    const mine = [...this.byKey.values()].filter((e) => e.webContentsId === webContentsId && !keep?.(e.lease))
    for (const e of mine) e.lease.release()
    return mine.length
  }

  private emit(accountId: string): void {
    for (const l of this.listeners) {
      try { l(accountId) } catch { /* a listener never breaks the registry */ }
    }
  }
}
