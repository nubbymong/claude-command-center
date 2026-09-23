// WP2 provider core (main): the account registry store (design 6.4, 14; plan
// A1, A2, A11). The rules live in the pure registry (src/shared/providers);
// this module only loads, serialises, persists and publishes -- through an
// INJECTED file port, so it names no path, no resources directory and no
// provider store, and every branch is testable without a filesystem.
//
// Guarantees:
// - Recovery mode. An unreadable, corrupt, inconsistent or newer-schema file
//   is never used and never overwritten; every change is refused until the
//   user resolves it. Providers with their own legacy store (Claude) keep
//   working from it meanwhile.
// - Fail closed on write. A document is written only after its serialised
//   form parses back, through the same validator the next start will use, to
//   exactly the same document. Memory moves only after the write succeeds.
// - One backup per start, before the first write, of the file as it was
//   loaded; a failed backup refuses the write. The newest few are kept.
// - One lock. Every change and every legacy reconcile runs under it, and it
//   is exposed so the consumer-lease registry can take the same one (A11).
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  emptyRegistry, parseRegistryDoc, reconcileLegacyAccounts, ID_PREFIX,
} from '../../../shared/providers'
import type {
  ProviderRegistryDoc, RegistryResult, LegacyAccountSnapshot, LegacyWrite, OpaqueIdKind, ProviderId,
} from '../../../shared/providers'

/** The registry file, as the store sees it. The real port stages, writes
 *  owner-only and renames atomically; an in-memory port backs the tests. */
export interface RegistryFsPort {
  /** Never throws: the file's text, its absence, or why it could not be read. */
  read(): { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'error'; message: string }
  /** Replace the file atomically. Throws on any failure. */
  write(text: string): void
  /** Copy the current file to a sibling backup named `name`. Throws on failure. */
  backup(name: string): void
  listBackups(): string[]
  removeBackup(name: string): void
}

/** A provider's legacy account store (Claude's profiles.json in 2.1.1), as
 *  its own package reads and writes it. */
export interface LegacyAccountsPort {
  readonly providerId: ProviderId
  /** The store's records, or null when it could not be read completely. A
   *  null is never treated as "no accounts". */
  read(): readonly LegacyAccountSnapshot[] | null
  /** Apply registry changes the store has not caught up with. Whatever does
   *  not land is re-emitted by the next reconcile; nothing is marked done. */
  apply(writes: readonly LegacyWrite[]): void
}

export type RegistryStatus =
  | { mode: 'ready' }
  | { mode: 'recovery'; reason: 'unloaded' | 'unreadable' | 'invalid' | 'newer-schema'; problems: readonly string[] }

export type StoreFailureCode = 'recovery' | 'persist-failed'
export type StoreResult = RegistryResult | { ok: false; code: StoreFailureCode; message: string }

export type LegacyReconcileOutcome =
  | { ok: true; created: number; imported: number; archived: number; restored: number; writes: number; warnings: readonly string[]; applyFailed?: boolean; convergeFailed?: boolean }
  | { ok: false; code: StoreFailureCode | 'legacy-unreadable' | 'reconcile-refused'; message: string }

export const REGISTRY_BACKUPS_KEPT = 5
const BACKUP_RE = /^registry\.(\d+)\.json\.bak$/

/** A stable opaque id from a seed, so one legacy record always maps to the
 *  same account, realm and identity (a lost registry reattaches). */
export function deterministicOpaqueId(kind: OpaqueIdKind, seed: string): string {
  return `${ID_PREFIX[kind]}-${createHash('sha256').update(`${kind}:${seed}`).digest('hex').slice(0, 32)}`
}

/** JSON with object keys sorted, so two equal documents compare equal however
 *  they were built. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
    : v))
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The store hands out its documents; freezing them means a caller cannot
 *  edit one in place and have the next unrelated change persist the edit
 *  past every transition rule. The pure transitions never mutate input. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v)
  }
  return value
}

export interface AccountRegistryStoreOptions {
  fs: RegistryFsPort
  now: () => number
  /** Sessions and operations holding each account (the lease registry). */
  consumers?: (accountId: string) => number
  log?: (message: string) => void
}

export class AccountRegistryStore {
  private doc: ProviderRegistryDoc | null = null
  private state: RegistryStatus = { mode: 'recovery', reason: 'unloaded', problems: ['the registry has not been loaded'] }
  private backupPending = false
  private tail: Promise<unknown> = Promise.resolve()
  private readonly inLock = new AsyncLocalStorage<symbol>()
  /** The token of the run holding the lock right now, if any. */
  private holder: symbol | null = null
  private readonly listeners = new Set<(doc: ProviderRegistryDoc) => void>()

  constructor(private readonly opts: AccountRegistryStoreOptions) {}

  /** Read the file once at start. Never throws. */
  load(): RegistryStatus {
    const read = this.opts.fs.read()
    if (read.kind === 'missing') {
      this.doc = deepFreeze(emptyRegistry())
      this.backupPending = false
      this.state = { mode: 'ready' }
      return this.state
    }
    this.doc = null
    if (read.kind === 'error') return this.enterRecovery('unreadable', [read.message])
    let raw: unknown
    try { raw = JSON.parse(read.text) } catch (e) { return this.enterRecovery('invalid', [`not JSON: ${errText(e)}`]) }
    const parsed = parseRegistryDoc(raw)
    if (!parsed.ok) return this.enterRecovery(parsed.reason, parsed.problems)
    this.doc = deepFreeze(parsed.doc)
    this.backupPending = true
    this.state = { mode: 'ready' }
    return this.state
  }

  status(): RegistryStatus { return this.state }

  /** The current document, or null in recovery mode. Treat it as read-only. */
  current(): ProviderRegistryDoc | null { return this.doc }

  subscribe(listener: (doc: ProviderRegistryDoc) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Run `fn` alone: every change, every reconcile and (later) every lease
   *  acquisition queue behind one another. Not re-entrant: a call from inside
   *  `fn` would wait on itself forever, so it is refused instead. */
  exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    // Refused only while the SAME run still holds the lock: work that run
    // started but left running (a timer, an unawaited promise) carries its
    // token too, and must be free to queue once the run has finished.
    const token = this.inLock.getStore()
    if (token !== undefined && token === this.holder) return Promise.reject(new Error('the account registry lock is not re-entrant; this call would wait on itself'))
    const run = this.tail.then(async () => {
      const mine = Symbol('registry-lock')
      this.holder = mine
      try { return await this.inLock.run(mine, fn) } finally { if (this.holder === mine) this.holder = null }
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Apply one pure transition and persist its result. */
  mutate(fn: (doc: ProviderRegistryDoc, now: number) => RegistryResult): Promise<StoreResult> {
    return this.exclusive(() => {
      const doc = this.doc
      if (!doc || this.state.mode !== 'ready') return this.refuseRecovery()
      const r = fn(doc, this.opts.now())
      if (!r.ok) return r
      if (canonical(r.doc) === canonical(doc)) return { ok: true as const, doc }
      const saved = this.persist(r.doc)
      return saved.ok ? { ok: true as const, doc: saved.doc } : { ok: false as const, code: 'persist-failed' as const, message: saved.message }
    })
  }

  /** Reconcile one provider's legacy store: read it, merge, persist, and only
   *  then hand the provider the writes it has not caught up with. */
  reconcileLegacy(port: LegacyAccountsPort): Promise<LegacyReconcileOutcome> {
    return this.exclusive((): LegacyReconcileOutcome => {
      const doc = this.doc
      if (!doc || this.state.mode !== 'ready') return this.refuseRecovery()
      let records: readonly LegacyAccountSnapshot[] | null
      try { records = port.read() } catch (e) { records = null; this.log(`[registry] ${port.providerId} legacy read threw: ${errText(e)}`) }
      if (records === null) return { ok: false, code: 'legacy-unreadable', message: `the ${port.providerId} account list could not be read; nothing changed` }
      const r = reconcileLegacyAccounts(doc, port.providerId, records, { now: this.opts.now(), deterministicId: deterministicOpaqueId, consumers: this.opts.consumers })
      if (!r.ok) {
        this.log(`[registry] ${port.providerId} reconcile refused: ${r.problems.join('; ')}`)
        return { ok: false, code: 'reconcile-refused', message: r.problems.join('; ') }
      }
      for (const w of r.warnings) this.log(`[registry] ${port.providerId}: ${w}`)
      if (canonical(r.doc) !== canonical(doc)) {
        const saved = this.persist(r.doc)
        if (!saved.ok) return { ok: false, code: 'persist-failed', message: saved.message }
      }
      let applyFailed = false
      let convergeFailed = false
      if (r.writes.length) {
        try { port.apply(r.writes) } catch (e) {
          applyFailed = true
          this.log(`[registry] ${port.providerId} legacy write-through failed (retried next reconcile): ${errText(e)}`)
        }
        // The writes landed (as far as the store would take them): read it
        // back and reconcile once more NOW, so the shadow records the
        // agreement. Left to the next start, a user edit made in the legacy
        // store in between would read as "legacy unchanged" and be
        // overwritten by the registry value.
        if (!applyFailed && !this.convergeAfterApply(port)) convergeFailed = true
      }
      const out = { ok: true as const, created: r.created, imported: r.imported, archived: r.archived, restored: r.restored, writes: r.writes.length, warnings: r.warnings }
      return { ...out, ...(applyFailed ? { applyFailed } : {}), ...(convergeFailed ? { convergeFailed } : {}) }
    })
  }

  /** False when the shadow could not be moved now (it moves next start). */
  private convergeAfterApply(port: LegacyAccountsPort): boolean {
    const doc = this.doc
    if (!doc) return false
    let records: readonly LegacyAccountSnapshot[] | null = null
    try { records = port.read() } catch { records = null }
    if (records === null) { this.log(`[registry] ${port.providerId}: could not re-read after write-through; the shadow moves next start`); return false }
    const r = reconcileLegacyAccounts(doc, port.providerId, records, { now: this.opts.now(), deterministicId: deterministicOpaqueId, consumers: this.opts.consumers })
    if (!r.ok) { this.log(`[registry] ${port.providerId}: post-write reconcile refused: ${r.problems.join('; ')}`); return false }
    if (canonical(r.doc) === canonical(doc)) return true
    const saved = this.persist(r.doc)
    if (saved.ok) return true
    this.log(`[registry] ${port.providerId}: post-write reconcile not saved: ${saved.message}`)
    return false
  }

  private persist(next: ProviderRegistryDoc): { ok: true; doc: ProviderRegistryDoc } | { ok: false; message: string } {
    let text: string
    try { text = `${JSON.stringify(next, null, 2)}\n` } catch (e) { return { ok: false, message: `the registry could not be serialised: ${errText(e)}` } }
    const back = parseRegistryDoc(JSON.parse(text))
    if (!back.ok) return { ok: false, message: `refused to write a registry the next start would reject: ${back.problems.slice(0, 3).join('; ')}` }
    if (canonical(back.doc) !== canonical(next)) return { ok: false, message: 'refused to write a registry that does not read back as written' }
    if (this.backupPending) {
      const name = `registry.${this.opts.now()}.json.bak`
      try { this.opts.fs.backup(name) } catch (e) { return { ok: false, message: `the registry backup failed, so nothing was written: ${errText(e)}` } }
      this.backupPending = false
      this.pruneBackups(name)
    }
    try { this.opts.fs.write(text) } catch (e) { return { ok: false, message: `the registry could not be written: ${errText(e)}` } }
    const doc = deepFreeze(back.doc)
    this.doc = doc
    // Listeners run outside the lock's context: one that starts a change
    // queues it behind this one instead of being refused as re-entrant.
    this.inLock.exit(() => {
      for (const l of this.listeners) {
        try { l(doc) } catch (e) { this.log(`[registry] a listener threw: ${errText(e)}`) }
      }
    })
    return { ok: true, doc }
  }

  /** Keep the backup just written and the newest others, by stamp. The one
   *  just written is never pruned, whatever the clock says of the others. */
  private pruneBackups(justWritten: string): void {
    try {
      const stamped = this.opts.fs.listBackups()
        .filter((name) => name !== justWritten)
        .map((name) => ({ name, m: BACKUP_RE.exec(name) }))
        .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
        // A stamp from the future (clock skew) sorts as the oldest, so it can
        // never pin itself in place of real history.
        .map((x) => ({ ...x, at: Number(x.m[1]) <= this.opts.now() ? Number(x.m[1]) : -1 }))
        .sort((a, b) => b.at - a.at)
      for (const old of stamped.slice(REGISTRY_BACKUPS_KEPT - 1)) this.opts.fs.removeBackup(old.name)
    } catch (e) {
      this.log(`[registry] pruning old backups failed: ${errText(e)}`)
    }
  }

  private enterRecovery(reason: 'unreadable' | 'invalid' | 'newer-schema', problems: readonly string[]): RegistryStatus {
    this.state = { mode: 'recovery', reason, problems }
    this.log(`[registry] recovery mode (${reason}): ${problems.slice(0, 5).join('; ')}`)
    return this.state
  }

  private refuseRecovery(): { ok: false; code: 'recovery'; message: string } {
    return { ok: false, code: 'recovery', message: 'the account registry is in recovery mode; no change is made until it is repaired' }
  }

  private log(message: string): void {
    try { this.opts.log?.(message) } catch { /* a logger never breaks the store */ }
  }
}
