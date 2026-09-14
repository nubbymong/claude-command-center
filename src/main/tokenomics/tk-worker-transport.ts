import type { TkConfigDim, TkPricing } from './tk-types'

export type ToTkWorker =
  | { type: 'open'; dbPath: string; pricing: Record<string, TkPricing>; configs: TkConfigDim[]; claudeProjectsDir: string; codexSessionsDir: string }
  | { type: 'set-pricing'; pricing: Record<string, TkPricing> }
  | { type: 'set-configs'; configs: TkConfigDim[] }
  | { type: 'reindex' }
  | { type: 'query'; id: number; kind: string; args: Record<string, unknown> }
  | { type: 'shutdown' }

export type FromTkWorker =
  /** `firstIndexComplete` is what the DB already knows at open. The supervisor
   *  used to learn it only from a fresh `index-complete`, so every launch showed
   *  "Indexing" until a whole sweep finished - or forever, if it did not. */
  | { type: 'ready'; firstIndexComplete: boolean; eventsTotal: number }
  | { type: 'health'; eventsTotal: number; filesTracked: number; dbBytes: number }
  | { type: 'index-progress'; filesDone: number; filesTotal: number; eventsIngested: number; phase: 'initial' | 'incremental' }
  /** `drained` = every file this sweep visited that COULD be read was read to
   *  its end; `filesFailed` counts the ones that could not be opened or read at
   *  all. Those are separate on purpose — a file that is unreadable now may be
   *  unreadable forever, so letting it block completion left a first index
   *  permanently unfinished. A sweep FINISHING is a third thing again: with a
   *  per-tick byte budget a multi-GB rollout needs tens of sweeps, so a sweep
   *  can finish with most of the user's spend still unread. Anything deciding
   *  whether to stop saying "Indexing" must gate on this, not on the message
   *  merely arriving — which is what left the page showing a confidently wrong
   *  total after the very first sweep. */
  | { type: 'index-complete'; firstIndex: boolean; drained: boolean; filesFailed: number; eventsTotal: number }
  | { type: 'log'; entry: { level: 'info' | 'warn' | 'error'; message: string } }
  | { type: 'query-result'; id: number; rows: unknown[] }
  | { type: 'error'; id?: number; message: string }

export interface TkWorkerTransport {
  post(msg: ToTkWorker): void
  onMessage(handler: (msg: FromTkWorker) => void): void
  kill(): void
}

export interface TkWorkerHostTransport {
  post(msg: FromTkWorker): void
  onMessage(handler: (msg: ToTkWorker) => void): void
}

export class FakeTkWorkerTransport implements TkWorkerTransport {
  private workerHandler: ((m: ToTkWorker) => void) | null = null
  private mainHandler: ((m: FromTkWorker) => void) | null = null
  killed = false
  workerMessages: ToTkWorker[] = []
  post(msg: ToTkWorker): void { this.workerMessages.push(msg); this.workerHandler?.(msg) }
  onMessage(handler: (m: FromTkWorker) => void): void { this.mainHandler = handler }
  kill(): void { this.killed = true }
  onWorker(handler: (m: ToTkWorker) => void): void { this.workerHandler = handler }
  emitToMain(msg: FromTkWorker): void { this.mainHandler?.(msg) }
  asWorkerSide(): TkWorkerHostTransport {
    return { post: (m) => this.emitToMain(m), onMessage: (h) => this.onWorker(h) }
  }
}
