/**
 * log-supervisor.ts — owns the logging utilityProcess worker (Logs v2: the
 * transcript-indexing worker, transcripts-worker.ts).
 *
 * Mirrors src/main/services/service-supervisor.ts (the hooks supervisor):
 * injectable forkChild + clock, backoff [250,1000,4000,...], restart/maxRestarts,
 * createInitialHealth, appendLog, pushHealth via emit(SERVICE_HEALTH_UPDATE).
 *
 * KEY DIFFERENCE from the hooks supervisor: there is NO in-process DB fallback.
 * better-sqlite3 lives ONLY in the forked worker (out/main/transcripts-worker.js);
 * main must never load it. So after maxRestarts the logging service degrades
 * permanently (a visible log) rather than failing open. To keep the worker
 * module (and better-sqlite3) out of main's bundle this file imports the worker
 * ONLY by the transport types — never `./transcripts-worker` or `./transcripts-db`.
 *
 * Two robustness layers on top of the base supervisor:
 *  - an id-keyed query() promise layer that rejects on error/worker-exit/timeout
 *    (a pending query never hangs);
 *  - a bounded, ORDERED while-down buffer for run-start/run-end/run-account/
 *    transcript-bind (drop-oldest + degrade on overflow; replayed in order on
 *    ready). Ordering of start -> bind -> end is preserved because all four
 *    share one queue.
 *
 * Crash reconciliation is now WORKER-SIDE: the worker closes dangling runs and
 * resumes tails itself on every `open` — the supervisor no longer posts a
 * reconcile message.
 *
 * No default export (project convention).
 */
import { createInitialHealth, computeThroughput } from '../../shared/service-health'
import { IPC } from '../../shared/ipc-channels'
import type { ServiceHealth, ServiceLogEntry, DiagnosticsSnapshot, ThroughputSample } from '../../shared/service-health'
import type { ForkedTranscriptsWorker } from './fork-transcripts-worker'
import type { ToTranscriptsWorker, FromTranscriptsWorker } from './log-worker-transport'

export interface LogSupervisorOptions {
  forkChild: () => ForkedTranscriptsWorker
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
// A rough byte estimate for the tiny lifecycle posts (run-start/run-end/
// run-account/transcript-bind) so they count toward the buffer cap without an
// expensive serialize. All buffered v2 messages are lifecycle-sized.
const LIFECYCLE_EST_BYTES = 256

type RunStartMessage = Extract<ToTranscriptsWorker, { type: 'run-start' }>
/** The run metadata pty-manager hands runStart() (the `run-start` message's meta). */
export type RunStartMeta = RunStartMessage['meta']

type NewMessagesEvent = Extract<FromTranscriptsWorker, { type: 'new-messages' }>

type BufferedMessage =
  | RunStartMessage
  | Extract<ToTranscriptsWorker, { type: 'run-end' }>
  | Extract<ToTranscriptsWorker, { type: 'run-account' }>
  | Extract<ToTranscriptsWorker, { type: 'run-rename' }>
  | Extract<ToTranscriptsWorker, { type: 'transcript-bind' }>

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
  // Last (eventsTotal, ts) sample throughput was computed against. eventsTotal
  // here maps onto the worker's messagesTotal ingest counter. Reset on respawn.
  private prevThroughput: ThroughputSample | null = null
  private log: ServiceLogEntry[] = []
  private worker: ForkedTranscriptsWorker | null = null
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

  // Ordered while-down buffer + its running byte total.
  private buffer: QueuedItem[] = []
  private bufferBytes = 0

  // id-keyed pending queries.
  private pending = new Map<number, PendingQuery>()
  private nextQueryId = 1

  // new-messages fan-out subscribers.
  private newMessagesSubs = new Set<(e: NewMessagesEvent) => void>()

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
    // Fresh worker = fresh messagesTotal counter; forget the prior throughput
    // sample so the next health beat starts a clean interval (no negative rate).
    this.prevThroughput = null
    // Surface the forked worker's OS pid on the diagnostics pill (hooks does this
    // via its `bound` message; the transcripts worker has no bind, so we read the
    // utilityProcess pid directly at fork — covers initial start AND each restart).
    this.health = {
      ...this.health,
      pid: w.pid,
      state: this.restarts > 0 ? 'restarting' : 'starting',
    }
    this.appendLog('info', 'worker-up', `logging worker forked (restart ${this.restarts})`)
    // Tell the fresh worker to open (re-open) the DB. The worker closes dangling
    // runs + resumes tails itself, then posts `ready`; only then do we replay
    // the while-down buffer.
    w.transport.post({ type: 'open', dbPath: this.opts.dbPath })
    this.pushHealth()
    w.onExit(() => { if (this.worker === w) this.onWorkerExit() })
  }

  // -------------------------------------------------------------------------
  // Worker -> main messages
  // -------------------------------------------------------------------------

  private onWorkerMessage(m: FromTranscriptsWorker): void {
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
        this.flushBuffer()
        this.pushHealth()
        return
      }
      case 'health': {
        const ts = this.now()
        const sample: ThroughputSample = { eventsTotal: m.messagesTotal, ts }
        const throughputPerSec = computeThroughput(this.prevThroughput, sample)
        this.prevThroughput = sample
        this.health = {
          ...this.health,
          inFlight: m.inFlight,
          // v2 health shape: messagesTotal is the worker's ingest counter — it
          // maps onto the pill's eventsTotal slot (same "work done" semantic).
          eventsTotal: m.messagesTotal,
          throughputPerSec,
          dbBytes: m.dbBytes,
          lastHeartbeatAt: ts,
          lastFlushAt: ts,
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
      case 'new-messages': {
        for (const cb of this.newMessagesSubs) {
          try { cb(m) } catch { /* never let a subscriber kill routing */ }
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
      default: {
        const _exhaustive: never = m
        void _exhaustive
        return
      }
    }
  }

  // -------------------------------------------------------------------------
  // Run lifecycle + binds — buffered while not listening, ordered
  // -------------------------------------------------------------------------

  /** Record a new run (one per spawn). pty-manager calls this at PTY spawn. */
  runStart(meta: RunStartMeta): void {
    this.enqueueOrSend({ type: 'run-start', meta })
  }

  /** Close the latest open run for the session (PTY exit). */
  runEnd(sessionId: string, ts: number, status: string): void {
    this.enqueueOrSend({ type: 'run-end', sessionId, ts, status })
  }

  /** Back-fill the account email on the latest open run (identity poll). */
  runAccount(sessionId: string, accountEmail: string): void {
    this.enqueueOrSend({ type: 'run-account', sessionId, accountEmail })
  }

  /** Update the display label on the latest open run (session rename), so the
   *  logs/history tab shows the custom work name durably. */
  renameRun(sessionId: string, configLabel: string): void {
    this.enqueueOrSend({ type: 'run-rename', sessionId, configLabel })
  }

  /** Bind a discovered transcript file to the session's current run; the worker
   *  starts tailing it immediately. */
  bindTranscript(sessionId: string, path: string, confidence: 'exact' | 'heuristic', sourceVersion?: string): void {
    this.enqueueOrSend({ type: 'transcript-bind', sessionId, path, confidence, sourceVersion })
  }

  /** Subscribe to the worker's new-messages fan-out. Returns an unsubscribe. */
  onNewMessages(cb: (e: { sessionId: string; configId: string | null; count: number }) => void): () => void {
    this.newMessagesSubs.add(cb)
    return () => { this.newMessagesSubs.delete(cb) }
  }

  /** Forward straight to the worker when listening; otherwise buffer (ordered),
   *  dropping the oldest + degrading if the cap would be exceeded. */
  private enqueueOrSend(msg: BufferedMessage): void {
    if (this.isListening() && this.worker) {
      this.worker.transport.post(msg)
      return
    }
    const cap = this.opts.bufferCapBytes ?? DEFAULT_BUFFER_CAP_BYTES
    this.buffer.push({ msg, bytes: LIFECYCLE_EST_BYTES })
    this.bufferBytes += LIFECYCLE_EST_BYTES
    // Drop the OLDEST buffered item(s) until back under the cap. A single item
    // larger than the cap still drops everything before it then sits alone
    // (we never silently discard the just-arrived message without recording it).
    let dropped = 0
    while (this.bufferBytes > cap && this.buffer.length > 1) {
      const old = this.buffer.shift()!
      this.bufferBytes -= old.bytes
      dropped += 1
    }
    if (dropped > 0) {
      this.health = {
        ...this.health,
        state: 'degraded',
        dropsTotal: this.health.dropsTotal + dropped,
      }
      this.appendLog('warn', 'buffer-overflow',
        `while-down log buffer exceeded ${cap}B: dropped ${dropped} oldest message(s)`)
      this.pushHealth()
    }
  }

  /** Replay the ordered buffer to the worker, then clear it. */
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

  /** Reject + clear every pending query so none can hang (on exit/shutdown). */
  private rejectAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
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
   *  (a visible log; run lifecycle is lost while down). Host stays
   *  utility-process (not in-process-fallback) because there IS no fallback —
   *  the worker is dead. Keeping utility-process means the renderer pill shows
   *  the honest label "Degraded" rather than the misleading "Fallback". */
  private degradePermanently(): void {
    this.degradedPermanently = true
    this.appendLog('error', 'degraded',
      `logging worker failed to recover after ${this.restarts} restarts; logging degraded (runs will not be recorded)`)
    this.health = { ...this.health, host: 'utility-process', state: 'degraded', restartCount: this.restarts }
    // Free the dead worker; there is nothing to fall back to.
    try { this.worker?.kill() } catch { /* best-effort */ }
    this.pushHealth()
  }

  // -------------------------------------------------------------------------
  // Manual restart — recovery from permanent degrade
  // -------------------------------------------------------------------------

  /** User-requested restart of the logging worker. Unlike the hooks supervisor
   *  there is NO in-process fallback, so once `degradePermanently` fires a manual
   *  restart is the ONLY way back: clear the terminal `degradedPermanently` flag,
   *  reset the restart/backoff counters, free any dead worker, and respawn (which
   *  re-sends `open` so the worker reopens the DB + resumes tails). Mirrors
   *  ServiceSupervisor.manualRestart. Declines during shutdown. */
  manualRestart(serviceId: string): { ok: boolean; reason?: string } {
    if (serviceId !== SERVICE_ID) return { ok: false, reason: 'unknown-service' }
    if (this.shuttingDown) return { ok: false, reason: 'shutting-down' }
    this.appendLog('info', 'manual-restart', 'manual restart requested')
    if (this.restartTimer !== null) { clearTimeout(this.restartTimer); this.restartTimer = null }
    this.restarts = 0
    this.backoffIdx = 0
    this.degradedPermanently = false
    this.health = { ...this.health, restartCount: 0 }
    // Free any lingering (dead/degraded) worker before respawning. The old worker's
    // late exit is ignored by spawnWorker's onExit guard (`this.worker === w`).
    try { this.worker?.kill() } catch { /* best-effort */ }
    this.worker = null
    this.spawnWorker()
    this.pushHealth()
    return { ok: true }
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
