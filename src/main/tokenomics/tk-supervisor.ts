import { logError, logWarn, logInfo } from '../debug-logger'
import type { ForkedTkWorker } from './fork-tokenomics-worker'
import type { ToTkWorker, FromTkWorker } from './tk-worker-transport'
import type { TkConfigDim, TkPricing, TkIndexStatus } from './tk-types'

export interface TokenomicsSupervisorOptions {
  forkChild: () => ForkedTkWorker
  dbPath: string
  pricing: Record<string, TkPricing>
  configs: TkConfigDim[]
  claudeProjectsDir: string
  codexSessionsDir: string
  emit: (channel: string, payload: unknown) => void
  now?: () => number
  maxRestarts?: number
  queryTimeoutMs?: number
}

export interface TkIndexProgress { filesDone: number; filesTotal: number; eventsIngested: number; phase: string }
export interface TkIndexCompleteEvent { firstIndex: boolean; eventsTotal: number }

const BACKOFFS = [250, 1000, 4000, 4000, 4000]
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
  private lastIndexAt: number | null = null
  // Set when the worker reports an UNCORRELATED error (e.g. a failed DB open,
  // which leaves the worker alive but never `ready` — no exit, no restart). The
  // renderer consumes this so the tokenomics page can stop showing 'indexing'
  // forever and surface a fault instead of a perpetual spinner.
  private lastError: { message: string; ts: number } | null = null

  constructor(private opts: TokenomicsSupervisorOptions) {}
  private now(): number { return this.opts.now ? this.opts.now() : Date.now() }

  start(): void {
    if (this.worker || this.shuttingDown) return
    this.spawn()
  }

  private spawn(): void {
    const w = this.opts.forkChild()
    this.worker = w
    this.listening = false
    w.transport.onMessage((m) => this.onMessage(m))
    w.onExit(() => this.onExit())
    w.transport.post({
      type: 'open', dbPath: this.opts.dbPath, pricing: this.opts.pricing, configs: this.opts.configs,
      claudeProjectsDir: this.opts.claudeProjectsDir, codexSessionsDir: this.opts.codexSessionsDir,
    })
  }

  private onMessage(m: FromTkWorker): void {
    switch (m.type) {
      case 'ready': {
        this.listening = true
        this.backoffIdx = 0
        const buf = this.buffer
        this.buffer = []
        for (const msg of buf) this.worker?.transport.post(msg)
        return
      }
      case 'index-progress': {
        this.lastProgress = { filesDone: m.filesDone, filesTotal: m.filesTotal, eventsIngested: m.eventsIngested, phase: m.phase }
        for (const cb of this.progressSubs) { try { cb(this.lastProgress) } catch { /* ignore */ } }
        return
      }
      case 'index-complete': {
        this.firstIndexComplete = true   // any completed sweep means the DB has a first index
        this.lastEventsTotal = m.eventsTotal
        this.lastIndexAt = this.now()
        for (const cb of this.completeSubs) { try { cb({ firstIndex: m.firstIndex, eventsTotal: m.eventsTotal }) } catch { /* ignore */ } }
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
  reindex(): void { this.sendOrBuffer({ type: 'reindex' }) }

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
      lastIndexAt: this.lastIndexAt,
      error,
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
