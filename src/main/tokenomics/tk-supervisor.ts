import { logError, logWarn, logInfo } from '../debug-logger'
import type { ForkedTkWorker } from './fork-tokenomics-worker'
import type { ToTkWorker, FromTkWorker } from './tk-worker-transport'
import type { TkConfigDim, TkPricing, TkIndexStatus, TkSessionsRoot, TkAccountReread, TkAccountKey } from './tk-types'
import { tkSessionUuidOk, tkClaudeAccountKeyOk } from './tk-types'

export interface TokenomicsSupervisorOptions {
  forkChild: () => ForkedTkWorker
  dbPath: string
  pricing: Record<string, TkPricing>
  configs: TkConfigDim[]
  claudeProjectsDir: string
  codexSessionsDir: string
  /** WP2 (plan A13): the transcript folders of the app's Codex accounts,
   *  each with the account's key (usage track MP9). */
  codexRealmSessionsDirs?: TkSessionsRoot[]
  emit: (channel: string, payload: unknown) => void
  now?: () => number
  maxRestarts?: number
  queryTimeoutMs?: number
}

export interface TkIndexProgress { filesDone: number; filesTotal: number; eventsIngested: number; phase: string; accountReread?: TkAccountReread | null }
export interface TkIndexCompleteEvent { firstIndex: boolean; drained: boolean; filesFailed: number; eventsTotal: number }

const BACKOFFS = [250, 1000, 4000, 4000, 4000]
/** Session attributions kept for a restarted worker (MP10), oldest dropped. */
const SESSION_ACCOUNTS_KEPT = 4096
const DEFAULT_QUERY_TIMEOUT_MS = 15_000

export class TokenomicsSupervisor {
  private worker: ForkedTkWorker | null = null
  private listening = false
  private shuttingDown = false
  private degraded = false
  private restarts = 0
  private backoffIdx = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private pending = new Map<number, { resolve: (r: unknown[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private nextId = 1
  private buffer: ToTkWorker[] = []
  private progressSubs = new Set<(p: TkIndexProgress) => void>()
  private completeSubs = new Set<(c: TkIndexCompleteEvent) => void>()
  private errorSubs = new Set<(s: TkIndexStatus) => void>()
  private lastProgress: TkIndexProgress = { filesDone: 0, filesTotal: 0, eventsIngested: 0, phase: 'initial' }
  private firstIndexComplete = false
  private lastEventsTotal = 0
  /** Files the last sweep could not read at all. Reported, never blocking. */
  private lastFilesFailed = 0
  private lastIndexAt: number | null = null
  /** MP9: the one-off account attribution, as the worker last reported it. */
  private lastAccountReread: TkAccountReread | null = null
  /** MP10: the Claude session attributions sent so far, first wins, sent
   *  again to a restarted worker (one that died before storing them). */
  private sessionAccounts = new Map<string, TkAccountKey>()
  /** MP9 round 1 (Q-4): the Codex account folders have been named (given at
   *  construction, or set since); a restarted worker is told so. */
  private realmDirsKnown: boolean
  // Set when the worker reports an UNCORRELATED error (e.g. a failed DB open,
  // which leaves the worker alive but never `ready` — no exit, no restart). The
  // renderer consumes this so the tokenomics page can stop showing 'indexing'
  // forever and surface a fault instead of a perpetual spinner.
  private lastError: { message: string; ts: number } | null = null

  constructor(private opts: TokenomicsSupervisorOptions) {
    this.realmDirsKnown = Array.isArray(opts.codexRealmSessionsDirs)
  }
  private now(): number { return this.opts.now ? this.opts.now() : Date.now() }

  start(): void {
    if (this.worker || this.shuttingDown) return
    this.spawn()
  }

  private spawn(): void {
    // Fresh worker, clean slate: a fatal error from a previous worker must not
    // keep the renderer's error banner latched after a successful restart.
    this.lastError = null
    const w = this.opts.forkChild()
    this.worker = w
    this.listening = false
    w.transport.onMessage((m) => this.onMessage(m))
    w.onExit(() => this.onExit())
    // MP10: every attribution kept, once, when the worker is ready (the
    // index ignores one it already has). Queued before the open: its ready
    // may come back at once.
    this.buffer = [
      ...this.buffer.filter((m) => m.type !== 'set-session-account'),
      ...[...this.sessionAccounts].map(([sessionId, accountKey]) => ({ type: 'set-session-account' as const, sessionId, accountKey })),
    ]
    w.transport.post({
      type: 'open', dbPath: this.opts.dbPath, pricing: this.opts.pricing, configs: this.opts.configs,
      claudeProjectsDir: this.opts.claudeProjectsDir, codexSessionsDir: this.opts.codexSessionsDir,
      codexRealmSessionsDirs: this.opts.codexRealmSessionsDirs ?? [],
      codexRealmDirsKnown: this.realmDirsKnown,
    })
  }

  private onMessage(m: FromTkWorker): void {
    switch (m.type) {
      case 'ready': {
        this.listening = true
        this.backoffIdx = 0
        // The DB's own record of a completed first index. Without this the
        // page said "Indexing usage data" on EVERY launch until a fresh sweep
        // completed - and stayed there for hours when the sweep wedged on the
        // Codex tail, over a database that had been complete since July.
        if (m.firstIndexComplete) { this.firstIndexComplete = true; this.lastEventsTotal = m.eventsTotal }
        const buf = this.buffer
        this.buffer = []
        for (const msg of buf) this.worker?.transport.post(msg)
        return
      }
      case 'index-progress': {
        this.lastAccountReread = m.accountReread ?? null
        this.lastProgress = { filesDone: m.filesDone, filesTotal: m.filesTotal, eventsIngested: m.eventsIngested, phase: m.phase, accountReread: this.lastAccountReread }
        for (const cb of this.progressSubs) { try { cb(this.lastProgress) } catch { /* ignore */ } }
        return
      }
      case 'index-complete': {
        // A sweep FINISHING is not a first index. With a per-tick byte budget a
        // multi-GB rollout needs tens of sweeps, so latching on the message
        // itself put the dashboard up over a fraction of the user's spend and
        // called it complete. `drained` is the worker saying every file it
        // visited was actually read to the end.
        if (m.drained) this.firstIndexComplete = true
        this.lastEventsTotal = m.eventsTotal
        this.lastFilesFailed = m.filesFailed
        this.lastIndexAt = this.now()
        for (const cb of this.completeSubs) { try { cb({ firstIndex: m.firstIndex, drained: m.drained, filesFailed: m.filesFailed, eventsTotal: m.eventsTotal }) } catch { /* ignore */ } }
        return
      }
      case 'health': { this.lastEventsTotal = m.eventsTotal; return }
      case 'query-result': {
        const p = this.pending.get(m.id)
        if (p) { this.pending.delete(m.id); clearTimeout(p.timer); p.resolve(m.rows) }
        return
      }
      case 'error': {
        if (m.id !== undefined) {
          const p = this.pending.get(m.id)
          if (p) { this.pending.delete(m.id); clearTimeout(p.timer); p.reject(new Error(m.message)) }
          return
        }
        // Uncorrelated error: the worker stays alive (e.g. a failed DB open never
        // posts `ready`, so onExit/restart never fires and queries reject forever).
        // Mirror LogSupervisor: log it loudly and record a fatal state so the UI
        // can stop showing 'indexing' instead of spinning silently forever.
        this.lastError = { message: m.message, ts: this.now() }
        logError('[tokenomics] worker error:', m.message)
        const status = this.getIndexStatus()
        for (const cb of this.errorSubs) { try { cb(status) } catch { /* ignore */ } }
        return
      }
      case 'log': {
        // Forward the worker's own logs to the main debug log (were discarded).
        const lvl = m.entry.level
        const fn = lvl === 'error' ? logError : lvl === 'warn' ? logWarn : logInfo
        fn('[tokenomics worker]', m.entry.message)
        return
      }
    }
  }

  query(kind: string, args: Record<string, unknown>): Promise<unknown[]> {
    if (this.shuttingDown) return Promise.reject(new Error('tokenomics supervisor shutting down'))
    if (!this.listening || !this.worker) return Promise.reject(new Error(`tokenomics worker not ready (degraded=${this.degraded})`))
    const id = this.nextId++
    return new Promise<unknown[]>((resolve, reject) => {
      const timeoutMs = this.opts.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`tokenomics query timed out after ${timeoutMs}ms (kind=${kind})`)) }, timeoutMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.worker!.transport.post({ type: 'query', id, kind, args })
    })
  }

  private sendOrBuffer(msg: ToTkWorker): void {
    if (this.listening && this.worker) this.worker.transport.post(msg)
    else this.buffer.push(msg)
  }

  setPricing(pricing: Record<string, TkPricing>): void { this.opts.pricing = pricing; this.sendOrBuffer({ type: 'set-pricing', pricing }) }
  setConfigs(configs: TkConfigDim[]): void { this.opts.configs = configs; this.sendOrBuffer({ type: 'set-configs', configs }) }
  /** Kept for a restarted worker's `open`, and sent to the running one. */
  setCodexRealmSessionsDirs(dirs: TkSessionsRoot[]): void {
    const copy = dirs.map((d) => ({ dir: d.dir, accountKey: d.accountKey }))
    this.opts.codexRealmSessionsDirs = copy
    this.realmDirsKnown = true
    this.sendOrBuffer({ type: 'set-codex-realm-dirs', dirs: copy.map((d) => ({ ...d })) })
  }
  reindex(): void { this.sendOrBuffer({ type: 'reindex' }) }
  /** Usage track MP10: a Claude session id and the account its session
   *  launched under. The first attribution of a session id wins; anything
   *  not well formed is dropped. */
  setSessionAccount(sessionId: string, accountKey: TkAccountKey): void {
    if (this.shuttingDown || !tkSessionUuidOk(sessionId) || !tkClaudeAccountKeyOk(accountKey)) return
    if (this.sessionAccounts.has(sessionId)) return
    this.sessionAccounts.set(sessionId, accountKey)
    if (this.sessionAccounts.size > SESSION_ACCOUNTS_KEPT) {
      const oldest = this.sessionAccounts.keys().next()
      if (!oldest.done) this.sessionAccounts.delete(oldest.value)
    }
    this.sendOrBuffer({ type: 'set-session-account', sessionId, accountKey })
  }

  onIndexProgress(cb: (p: TkIndexProgress) => void): () => void { this.progressSubs.add(cb); return () => { this.progressSubs.delete(cb) } }
  onIndexComplete(cb: (c: TkIndexCompleteEvent) => void): () => void { this.completeSubs.add(cb); return () => { this.completeSubs.delete(cb) } }
  /** Fires with the fault status when the worker reports an uncorrelated error
   *  (e.g. a failed DB open). The handler layer forwards it to the renderer. */
  onIndexError(cb: (s: TkIndexStatus) => void): () => void { this.errorSubs.add(cb); return () => { this.errorSubs.delete(cb) } }

  getIndexStatus(): TkIndexStatus {
    const error = this.lastError?.message ?? null
    return {
      firstIndexComplete: this.firstIndexComplete,
      // A fatal error means the index will never complete on its own; stop
      // reporting 'indexing' so the page leaves its perpetual spinner.
      indexing: !this.firstIndexComplete && error === null,
      filesDone: this.lastProgress.filesDone,
      filesTotal: this.lastProgress.filesTotal,
      eventsTotal: this.lastEventsTotal,
      filesFailed: this.lastFilesFailed,
      lastIndexAt: this.lastIndexAt,
      error,
      accountReread: this.lastAccountReread,
    }
  }

  private onExit(): void {
    if (this.shuttingDown || this.degraded) return
    this.listening = false
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('tokenomics worker exited')) }
    this.pending.clear()
    this.worker = null
    if (this.restarts >= (this.opts.maxRestarts ?? 5)) { this.degraded = true; return }
    const delay = BACKOFFS[Math.min(this.backoffIdx, BACKOFFS.length - 1)]
    this.backoffIdx++
    this.restartTimer = setTimeout(() => { if (this.shuttingDown) return; this.restarts++; this.spawn() }, delay)
    ;(this.restartTimer as unknown as { unref?: () => void }).unref?.()
  }

  shutdown(): void {
    this.shuttingDown = true
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('tokenomics supervisor shut down')) }
    this.pending.clear()
    try { this.worker?.transport.post({ type: 'shutdown' }) } catch { /* ignore */ }
    try { this.worker?.kill() } catch { /* ignore */ }
    this.worker = null
    this.listening = false
  }
}
