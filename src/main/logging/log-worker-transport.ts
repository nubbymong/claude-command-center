/**
 * log-worker-transport.ts — Typed message contract between the main process
 * and the logging utilityProcess worker.
 *
 * Mirrors the discriminated-union + transport-interface pattern from
 * src/main/services/service-transport.ts.
 *
 * No native deps, no Electron imports — safe to import from either side.
 * No default export (project convention).
 */

// ---------------------------------------------------------------------------
// Message unions
// ---------------------------------------------------------------------------

/** Main -> worker */
export type ToWorker =
  | { type: 'open'; dbPath: string }
  | {
      type: 'batch'
      sessions: {
        sessionId: string
        chunks: {
          ts: number
          type: 'start' | 'data' | 'restart' | 'switch' | 'end'
          raw: Uint8Array
        }[]
        dropped?: number
      }[]
    }
  | {
      type: 'session-start'
      meta: {
        sessionId: string
        configId?: string
        configLabel: string
        projectCwd?: string
        accountEmail?: string
        profileId?: string
        provider: string
        startedAt: number
      }
    }
  | { type: 'session-end'; sessionId: string; ts: number; status: string }
  | { type: 'query'; id: number; kind: string; args: Record<string, unknown> }
  | { type: 'reconcile' }
  | { type: 'shutdown' }

/** Worker -> main */
export type FromWorker =
  | { type: 'ready' }
  | { type: 'health'; inFlight: number; eventsTotal: number; dropsTotal: number; dbBytes: number }
  | { type: 'log'; entry: { level: 'info' | 'warn' | 'error'; message: string } }
  | { type: 'query-result'; id: number; rows: unknown[] }
  | { type: 'error'; id?: number; message: string }

// ---------------------------------------------------------------------------
// Transport interfaces
// ---------------------------------------------------------------------------

/** Main-side handle to the logging worker.
 *  NOTE: `onMessage` is SINGLE-HANDLER — the last registration wins. */
export interface WorkerTransport {
  post(msg: ToWorker): void
  onMessage(handler: (msg: FromWorker) => void): void
  kill(): void
}

/** Worker-side inverse: post() sends FromWorker to main; onMessage() receives ToWorker. */
export interface WorkerHostTransport {
  post(msg: FromWorker): void
  onMessage(handler: (msg: ToWorker) => void): void
}

// ---------------------------------------------------------------------------
// In-memory fake for tests
// ---------------------------------------------------------------------------

/** In-memory fake: `post`/`onMessage` carry main->worker; `emitToMain`/`workerMessages`
 *  simulate worker->main so tests can drive both directions without a real process. */
export class FakeWorkerTransport implements WorkerTransport {
  private workerHandler: ((m: ToWorker) => void) | null = null
  private mainHandler: ((m: FromWorker) => void) | null = null
  killed = false
  /** All messages posted from main to the worker (in order). */
  workerMessages: ToWorker[] = []

  post(msg: ToWorker): void {
    this.workerMessages.push(msg)
    this.workerHandler?.(msg)
  }

  onMessage(handler: (m: FromWorker) => void): void {
    this.mainHandler = handler
  }

  kill(): void {
    this.killed = true
  }

  // --- test helpers ---

  /** Register a handler that receives messages the main side posts to the worker. */
  onWorker(handler: (m: ToWorker) => void): void {
    this.workerHandler = handler
  }

  /** Simulate the worker sending a message back to the main side. */
  emitToMain(msg: FromWorker): void {
    this.mainHandler?.(msg)
  }

  /** View this fake from the WORKER side: post() -> main (emitToMain),
   *  onMessage() receives what main posted (onWorker). */
  asWorkerSide(): WorkerHostTransport {
    return {
      post: (m: FromWorker) => this.emitToMain(m),
      onMessage: (h: (m: ToWorker) => void) => this.onWorker(h),
    }
  }
}
