// WP2 commit 3: the one-shot secret channel behind API-key sign-in (design
// 9.2, 12; plan A6). The renderer never sends a key in an ordinary request or
// reply. It asks for a handle for ONE pending sign-in, deposits the key once
// on a dedicated one-way channel, and starts the sign-in naming only the
// handle. The provider package takes the key once, by handle, and writes it
// to the child's stdin pipe.
//
// Guarantees:
// - A handle is main-issued randomness, bound to one account and one
//   renderer, used once, and gone after a short time whatever happens: a
//   timer drops it at expiry even when nothing touches the store again, and
//   the clock the runtime supplies is monotonic (a wall-clock change neither
//   shortens nor extends it). Abandoning or completing the setup drops it too.
// - A deposit is accepted once, only from the renderer the handle was issued
//   to, only for a live handle, and only within a length bound. Nothing about
//   a refused deposit is echoed or logged.
// - `take` hands the key over once and forgets it. JavaScript strings cannot
//   be wiped; the store drops its only reference and claims nothing more.
// - This module never logs. Nothing here serialises a key.
import { randomBytes } from 'node:crypto'
import { SECRET_HANDLE_RE, SECRET_MAX } from '../../../shared/providers'

/** How long an issued handle lives, deposited or not. */
export const SECRET_HANDLE_TTL_MS = 120_000
/** Handles one renderer may hold at once. */
export const SECRET_HANDLES_PER_RENDERER = 4

interface Slot {
  accountId: string
  senderId: number
  expiresAt: number
  secret: string | null
  deposited: boolean
  cancelTimer: () => void
}

/** Run `fn` after `ms`, without keeping the process alive; returns a cancel. */
export type ExpiryScheduler = (ms: number, fn: () => void) => () => void

const unrefTimer: ExpiryScheduler = (ms, fn) => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return () => clearTimeout(t)
}

export class SecretHandleStore {
  private readonly slots = new Map<string, Slot>()

  constructor(private readonly opts: { now: () => number; random?: () => string; schedule?: ExpiryScheduler } = { now: () => performance.now() }) {}

  /** A fresh handle for one pending sign-in, or null when the renderer holds
   *  too many already. */
  issue(bind: { accountId: string; senderId: number }): string | null {
    this.sweep()
    let held = 0
    for (const s of this.slots.values()) if (s.senderId === bind.senderId) held++
    if (held >= SECRET_HANDLES_PER_RENDERER) return null
    const handle = `sec-${this.opts.random ? this.opts.random() : randomBytes(16).toString('hex')}`
    if (!SECRET_HANDLE_RE.test(handle) || this.slots.has(handle)) return null
    const slot: Slot = { accountId: bind.accountId, senderId: bind.senderId, expiresAt: this.opts.now() + SECRET_HANDLE_TTL_MS, secret: null, deposited: false, cancelTimer: () => {} }
    this.slots.set(handle, slot)
    // Only this slot: a later slot under the same handle is another one.
    slot.cancelTimer = (this.opts.schedule ?? unrefTimer)(SECRET_HANDLE_TTL_MS, () => { if (this.slots.get(handle) === slot) this.drop(handle) })
    return handle
  }

  /** Accept the key once, from the renderer the handle was issued to. */
  deposit(handle: unknown, senderId: number, secret: unknown): boolean {
    this.sweep()
    if (typeof handle !== 'string' || !SECRET_HANDLE_RE.test(handle)) return false
    const slot = this.slots.get(handle)
    if (!slot || slot.senderId !== senderId) return false
    if (slot.deposited) {
      // A second deposit is not a correction: the handle is burned.
      this.drop(handle)
      return false
    }
    if (typeof secret !== 'string' || secret.length === 0 || secret.length > SECRET_MAX) {
      this.drop(handle)
      return false
    }
    slot.secret = secret
    slot.deposited = true
    return true
  }

  /** Whether the handle is live and bound to this account and renderer. */
  isBoundTo(handle: unknown, accountId: string, senderId: number): boolean {
    this.sweep()
    if (typeof handle !== 'string') return false
    const slot = this.slots.get(handle)
    return !!slot && slot.accountId === accountId && slot.senderId === senderId
  }

  /** The key, once; null when the handle is unknown, expired, burned or
   *  never deposited. The handle is gone afterwards either way. */
  take(handle: unknown): string | null {
    this.sweep()
    if (typeof handle !== 'string') return null
    const slot = this.slots.get(handle)
    if (!slot) return null
    const secret = slot.secret
    this.drop(handle)
    return slot.deposited ? secret : null
  }

  /** Forget one handle without using it. */
  discard(handle: unknown): void {
    if (typeof handle !== 'string') return
    this.drop(handle)
  }

  /** Forget every handle a destroyed renderer held. */
  discardForRenderer(senderId: number): void {
    for (const [h, s] of [...this.slots]) if (s.senderId === senderId) this.drop(h)
  }

  /** Forget every handle for one account's setup (abandoned or completed). */
  discardForAccount(accountId: string): void {
    for (const [h, s] of [...this.slots]) if (s.accountId === accountId) this.drop(h)
  }

  /** Live handles (for tests and the leak check). */
  size(): number {
    this.sweep()
    return this.slots.size
  }

  private sweep(): void {
    const now = this.opts.now()
    for (const [h, s] of [...this.slots]) if (s.expiresAt <= now) this.drop(h)
  }

  private drop(handle: string): void {
    const slot = this.slots.get(handle)
    if (!slot) return
    slot.secret = null
    try { slot.cancelTimer() } catch { /* a timer that cannot be cancelled fires into an empty slot */ }
    this.slots.delete(handle)
  }
}
