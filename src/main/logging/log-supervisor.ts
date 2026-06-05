/**
 * log-supervisor.ts — owns the logging utilityProcess worker.
 *
 * Mirrors src/main/services/service-supervisor.ts (the hooks supervisor):
 * injectable forkChild + clock, backoff [250,1000,4000,...], restart/maxRestarts,
 * createInitialHealth, appendLog, pushHealth via emit(SERVICE_HEALTH_UPDATE).
 *
 * KEY DIFFERENCE from the hooks supervisor: there is NO in-process DB fallback.
 * better-sqlite3 lives ONLY in the forked worker (out/main/log-worker.js); main
 * must never load it. So after maxRestarts the logging service degrades
 * permanently (drops + a visible log) rather than failing open. To keep the
 * worker module (and better-sqlite3) out of main's bundle this file imports the
 * worker ONLY by the transport types — never `./log-worker` or `./log-db`.
 *
 * Two robustness layers on top of the base supervisor:
 *  - an id-keyed query() promise layer that rejects on error/worker-exit/timeout
 *    (a pending query never hangs);
 *  - a bounded, ORDERED while-down buffer for batch/session-start/session-end
 *    (drop-oldest + degrade on overflow; flushed in order on ready). Ordering of
 *    start -> batch -> end is preserved because all three share one queue.
 *
 * No default export (project convention).
 */
import { createInitialHealth } from '../../shared/service-health'
import { IPC } from '../../shared/ipc-channels'
import type { ServiceHealth, ServiceLogEntry, DiagnosticsSnapshot } from '../../shared/service-health'
import type { ForkedLogWorker } from './fork-log-worker'
import type { ToWorker, FromWorker } from './log-worker-transport'
import type { ChunkProgress } from './legacy-log-importer'

export interface LogSupervisorOptions {
  forkChild: () => ForkedLogWorker
  dbPath: string
  emit: (channel: string, payload: unknown) => void
  now?: () => number          // injectable clock for tests
  maxRestarts?: number        // permanent degrade after this many failed restarts (default 5)
  bufferCapBytes?: number     // while-down buffer cap (default ~8 MB)
  queryTimeoutMs?: number     // safety timeout per query so it can never hang (default 15 s)
}

const LOG_CAP = 200
const SERVICE_ID = 'logging'
const DEFAULT_BUFFER_CAP_BYTES = 8 * 1024 * 1024
const DEFAULT_QUERY_TIMEOUT_MS = 15_000
// A rough byte estimate for tiny lifecycle posts (session-start/session-end) so
// they count toward the buffer cap without an expensive serialize.
const LIFECYCLE_EST_BYTES = 256

type BatchMessage = Extract<ToWorker, { type: 'batch' }>
type SessionStartMessage = Extract<ToWorker, { type: 'session-start' }>
type MigrateMessage = Extract<ToWorker, { type: 'migrate' }>
/** The per-chunk session list the migration importer hands migrate() (the `migrate`
 *  message's `sessions` field). */
type MigrateSessions = MigrateMessage['sessions']
/** The batch payload the rest of main hands us (the `batch` message minus its tag). */
export type LogBatch = Omit<BatchMessage, 'type'>

type BufferedMessage =
  | BatchMessage
  | SessionStartMessage
  | Extract<ToWorker, { type: 'session-end' }>

interface QueuedItem {
  msg: BufferedMessage
  bytes: number
}

interface PendingQuery {
  resolve: (rows: unknown[]) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

export class LogSupervisor {
  private opts: LogSupervisorOptions
  private now: () => number
  private health: ServiceHealth = createInitialHealth(SERVICE_ID, 'Session logging')
  private log: ServiceLogEntry[] = []
  private worker: ForkedLogWorker | null = null
  private shuttingDown = false
  // Set once we degrade permanently (maxRestarts exhausted). Like the hooks
  // supervisor's fellOpen guard: stops a late/self-kill exit from re-entering the
  // restart path. There is NO fallback engine — this is a terminal state.
  private degradedPermanently = false
  private restarts = 0
  // backoffIdx only advances (never reset on a healthy ready) — same conservative
  // choice as the hooks supervisor: slower escalation beats restart thrash.
  private backoffIdx = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private static BACKOFFS = [250, 1000, 4000, 4000, 4000]

  // First-ready-only reconcile (crash reconciliation, spec §11).
  private reconciledOnce = false

  // Ordered while-down buffer + its running byte total.
  private buffer: QueuedItem[] = []
  private bufferBytes = 0

  // id-keyed pending queries.
  private pending = new Map<number, PendingQuery>()
  private nextQueryId = 1

  // id-keyed pending migration chunks (mirrors `pending` so a chunk's ack can
  // never hang: resolved by migrate-progress, rejected by migrate-error / exit /
  // shutdown / timeout). The id is supplied by the caller (one per chunk).
  private pendingMigrations = new Map<number, { resolve: (p: ChunkProgress) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }>()

  constructor(opts: LogSupervisorOptions) {
    this.opts = opts
    this.now = opts.now ?? (() => Date.now())
  }

  getDiagnosticsSnapshot(): DiagnosticsSnapshot {
    return { capturedAt: this.now(), services: [{ ...this.health }], log: [...this.log] }
  }

  private appendLog(level: ServiceLogEntry['level'], code: string, message: string): void {
    this.log.push({ ts: this.now(), serviceId: SERVICE_ID, level, code, message })
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP)
  }

  // Push the live snapshot to the renderer after every health mutation so the
  // Conductor services pill reflects reality without polling. Guarded: the window
  // may be gone during teardown.
  private pushHealth(): void {
    try { this.opts.emit(IPC.SERVICE_HEALTH_UPDATE, this.getDiagnosticsSnapshot()) } catch { /* window gone */ }
  }

  private isListening(): boolean {
    return this.health.state === 'listening'
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    this.spawnWorker()
  }

  private spawnWorker(): void {
    const w = this.opts.forkChild()
    this.worker = w
    w.transport.onMessage((m) => this.onWorkerMessage(m))
    this.health = { ...this.health, state: this.restarts > 0 ? 'restarting' : 'starting' }
    this.appendLog('info', 'worker-up', `logging worker forked (restart ${this.restarts})`)
    // Tell the fresh worker to open (re-open) the DB. The worker posts `ready`
    // once the DB is open; only then do we flush the buffer.
    w.transport.post({ type: 'open', dbPath: this.opts.dbPath })
    this.pushHealth()
    w.onExit(() => { if (this.worker === w) this.onWorkerExit() })
  }

  /** Post a crash-reconciliation request. Idempotent on the worker side
   *  (markRunningCrashed). Called once on first ready; Task 8 may also call it. */
  reconcile(): void {
    if (!this.worker) return
    this.worker.transport.post({ type: 'reconcile' })
  }

  // -------------------------------------------------------------------------
  // Worker -> main messages
  // -------------------------------------------------------------------------

  private onWorkerMessage(m: FromWorker): void {
    // Once shutting down or permanently degraded the worker is dead/irrelevant;
    // ignore any messages still draining out of the pipe so a stale `ready`/`health`
    // can't flip the pill back to listening and clobber the degraded state.
    if (this.shuttingDown || this.degradedPermanently) return
    switch (m.type) {
      case 'ready': {
        this.health = {
          ...this.health,
          state: 'listening',
          host: 'utility-process',
          startedAt: this.health.startedAt ?? this.now(),
        }
        this.appendLog('info', 'ready', 'logging worker ready (DB open)')
        // Reconcile once across the supervisor's life (crash reconciliation).
        if (!this.reconciledOnce) { this.reconciledOnce = true; this.reconcile() }
        this.flushBuffer()
        this.pushHealth()
        return
      }
      case 'health': {
        this.health = {
          ...this.health,
          inFlight: m.inFlight,
          eventsTotal: m.eventsTotal,
          dropsTotal: m.dropsTotal,
          dbBytes: m.dbBytes,
          lastHeartbeatAt: this.now(),
          lastFlushAt: this.now(),
        }
        this.pushHealth()
        return
      }
      case 'log': {
        this.appendLog(m.entry.level, 'worker', m.entry.message)
        this.pushHealth()
        return
      }
      case 'query-result': {
        const p = this.pending.get(m.id)
        if (p) {
          if (p.timer) clearTimeout(p.timer)
          this.pending.delete(m.id)
          p.resolve(m.rows)
        }
        return
      }
      case 'error': {
        if (m.id != null) {
          const p = this.pending.get(m.id)
          if (p) {
            if (p.timer) clearTimeout(p.timer)
            this.pending.delete(m.id)
            p.reject(new Error(m.message))
          }
          return
        }
        // Un-correlated error: surface it on the pill (visible, never silent).
        this.health = { ...this.health, lastError: { message: m.message, ts: this.now() } }
        this.appendLog('error', 'worker-error', m.message)
        this.pushHealth()
        return
      }
      case 'migrate-progress': {
        const p = this.pendingMigrations.get(m.id)
        if (p) {
          if (p.timer) clearTimeout(p.timer)
          this.pendingMigrations.delete(m.id)
          p.resolve({ importedSessions: m.importedSessions, skippedSessions: m.skippedSessions, failedSessions: m.failedSessions, importedEvents: m.importedEvents })
        }
        return
      }
      case 'migrate-error': {
        const p = this.pendingMigrations.get(m.id)
        if (p) {
          if (p.timer) clearTimeout(p.timer)
          this.pendingMigrations.delete(m.id)
          p.reject(new Error(m.message))
        }
        return
      }
      default: {
        const _exhaustive: never = m
        void _exhaustive
        return
      }
    }
  }

  // -------------------------------------------------------------------------
  // Ingest (batch + lifecycle) — buffered while not listening, ordered
  // -------------------------------------------------------------------------

  postBatch(batch: LogBatch): void {
    this.enqueueOrSend({ type: 'batch', sessions: batch.sessions }, estimateBatchBytes(batch.sessions))
  }

  startSession(meta: SessionStartMessage['meta']): void {
    this.enqueueOrSend({ type: 'session-start', meta }, LIFECYCLE_EST_BYTES)
  }

  endSession(sessionId: string, ts: number, status: string): void {
    this.enqueueOrSend({ type: 'session-end', sessionId, ts, status }, LIFECYCLE_EST_BYTES)
  }

  /** Forward straight to the worker when listening; otherwise buffer (ordered),
   *  dropping the oldest + degrading if the cap would be exceeded. */
  private enqueueOrSend(msg: BufferedMessage, bytes: number): void {
    if (this.isListening() && this.worker) {
      this.worker.transport.post(msg)
      return
    }
    const cap = this.opts.bufferCapBytes ?? DEFAULT_BUFFER_CAP_BYTES
    this.buffer.push({ msg, bytes })
    this.bufferBytes += bytes
    // Drop the OLDEST buffered item(s) until back under the cap. A single item
    // larger than the cap still drops everything before it then sits alone
    // (we never silently discard the just-arrived message without recording it).
    let dropped = 0
    while (this.bufferBytes > cap && this.buffer.length > 1) {
      const old = this.buffer.shift()!
      this.bufferBytes -= old.bytes
      dropped += countEvents(old.msg)
    }
    if (dropped > 0) {
      this.health = {
        ...this.health,
        state: 'degraded',
        dropsTotal: this.health.dropsTotal + dropped,
      }
      this.appendLog('warn', 'buffer-overflow',
        `while-down log buffer exceeded ${cap}B: dropped ${dropped} oldest event(s)`)
      this.pushHealth()
    }
  }

  /** Flush the ordered buffer to the worker, then clear it. */
  private flushBuffer(): void {
    if (!this.worker || this.buffer.length === 0) {
      this.buffer = []
      this.bufferBytes = 0
      return
    }
    // Note: a worker death mid-flush loses the just-flushed messages — inherent to best-effort fork transport.
    for (const item of this.buffer) {
      this.worker.transport.post(item.msg)
    }
    this.buffer = []
    this.bufferBytes = 0
  }

  // -------------------------------------------------------------------------
  // Queries — id-keyed promise layer that can never hang
  // -------------------------------------------------------------------------

  query(kind: string, args: Record<string, unknown>): Promise<unknown[]> {
    // A query while the worker is unavailable rejects quickly rather than
    // hanging — the caller can retry once the pill shows listening again.
    if (this.shuttingDown) return Promise.reject(new Error('log supervisor is shutting down'))
    if (!this.isListening() || !this.worker) {
      return Promise.reject(new Error(`logging worker not available (state=${this.health.state})`))
    }
    const id = this.nextQueryId++
    return new Promise<unknown[]>((resolve, reject) => {
      const timeoutMs = this.opts.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`log query timed out after ${timeoutMs}ms (kind=${kind})`))
        }
      }, timeoutMs)
      // unref so a pending query timer can't keep the process alive (no-op in tests).
      ;(timer as { unref?: () => void }).unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.worker!.transport.post({ type: 'query', id, kind, args })
    })
  }

  /** Post a migration chunk and resolve on its ack. Rejects fast when the worker
   *  is unavailable and on worker exit/shutdown — like query(), it can never hang.
   *  `id` correlates the chunk to its ack; callers pass a unique id per chunk. */
  migrate(sessions: MigrateSessions, id: number): Promise<ChunkProgress> {
    if (this.shuttingDown) return Promise.reject(new Error('log supervisor is shutting down'))
    if (!this.isListening() || !this.worker) {
      return Promise.reject(new Error(`logging worker not available (state=${this.health.state})`))
    }
    return new Promise<ChunkProgress>((resolve, reject) => {
      const timeoutMs = this.opts.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS
      // 4x the query budget: a migrate chunk imports a whole chunk of sessions +
      // their events (far heavier than a single read), so it needs more headroom --
      // but it stays bounded so a wedged worker can never hang the import forever.
      const timer = setTimeout(() => {
        if (this.pendingMigrations.delete(id)) reject(new Error(`migrate chunk timed out after ${timeoutMs * 4}ms`))
      }, timeoutMs * 4)
      ;(timer as { unref?: () => void }).unref?.()
      this.pendingMigrations.set(id, { resolve, reject, timer })
      this.worker!.transport.post({ type: 'migrate', id, sessions })
    })
  }

  /** Reject + clear every pending query so none can hang (on exit/shutdown). */
  private rejectAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
    for (const [, p] of this.pendingMigrations) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pendingMigrations.clear()
  }

  // -------------------------------------------------------------------------
  // Worker exit -> restart with backoff -> permanent degrade
  // -------------------------------------------------------------------------

  private onWorkerExit(): void {
    // Ignore exits once shutting down OR once permanently degraded (the latter so
    // a degrade-time kill can't re-enter and re-run the restart logic).
    if (this.shuttingDown || this.degradedPermanently) return
    this.health = { ...this.health, state: 'crashed', lastError: { message: 'worker exited', ts: this.now() } }
    this.appendLog('error', 'crashed', 'logging worker exited unexpectedly')
    // Reject every in-flight query so no caller hangs on a dead worker.
    this.rejectAllPending('logging worker exited')
    this.pushHealth()
    if (this.restarts >= (this.opts.maxRestarts ?? 5)) { this.degradePermanently(); return }
    const delay = LogSupervisor.BACKOFFS[Math.min(this.backoffIdx, LogSupervisor.BACKOFFS.length - 1)]
    this.backoffIdx++
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.shuttingDown) return   // shutdown() raced the backoff — do not resurrect
      this.restarts++
      this.health = { ...this.health, restartCount: this.restarts }
      this.spawnWorker()   // re-sends {type:'open'} so the worker reopens the DB
    }, delay)
  }

  /** Terminal state: no in-process DB fallback exists, so logging just degrades
   *  (drops + a visible log). Host stays utility-process (not in-process-fallback)
   *  because there IS no fallback — the worker is dead and events will be dropped.
   *  Keeping utility-process means the renderer pill shows the honest label
   *  "Degraded" rather than the misleading "Fallback". */
  private degradePermanently(): void {
    this.degradedPermanently = true
    this.appendLog('error', 'degraded',
      `logging worker failed to recover after ${this.restarts} restarts; logging degraded (events will be dropped)`)
    this.health = { ...this.health, host: 'utility-process', state: 'degraded', restartCount: this.restarts }
    // Free the dead worker; there is nothing to fall back to.
    try { this.worker?.kill() } catch { /* best-effort */ }
    this.pushHealth()
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  shutdown(): void {
    this.shuttingDown = true
    if (this.restartTimer !== null) { clearTimeout(this.restartTimer); this.restartTimer = null }
    // best-effort graceful close, then kill.
    try { this.worker?.transport.post({ type: 'shutdown' }) } catch { /* worker gone */ }
    try { this.worker?.kill() } catch { /* already dead */ }
    this.rejectAllPending('log supervisor is shutting down')
  }
}

// ---------------------------------------------------------------------------
// Byte estimation helpers (module-private)
// ---------------------------------------------------------------------------

/** Estimate a batch's payload size by summing the raw byteLengths of every chunk.
 *  Used to bound the while-down buffer (spec §5 — visible loss, never silent). */
function estimateBatchBytes(sessions: Extract<ToWorker, { type: 'batch' }>['sessions']): number {
  let total = 0
  for (const s of sessions) {
    for (const c of s.chunks) total += c.raw.byteLength
  }
  return total
}

/** How many log events a buffered message represents, for the dropsTotal counter
 *  (matches the worker's per-chunk eventsTotal accounting). */
function countEvents(msg: BufferedMessage): number {
  if (msg.type !== 'batch') return 1
  let n = 0
  for (const s of msg.sessions) n += s.chunks.length
  return n
}
