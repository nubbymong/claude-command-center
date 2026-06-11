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
// Transcripts message unions (Logs v2)
//
// The transcript-indexing stack is the ONLY logging contract (the old
// byte-capture stack was removed in the deletion sweep). The transcripts worker
// tails Claude transcript JSONL files ITSELF — main only sends lifecycle
// (run-start/run-end/run-account), bindings (transcript-bind) and queries; no
// terminal bytes ever transit.
// ---------------------------------------------------------------------------

/** Main -> transcripts worker */
export type ToTranscriptsWorker =
  | { type: 'open'; dbPath: string }
  | {
      type: 'run-start'
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
  | { type: 'run-end'; sessionId: string; ts: number; status: string }
  | { type: 'run-account'; sessionId: string; accountEmail: string }
  | {
      type: 'transcript-bind'
      sessionId: string
      path: string
      confidence: 'exact' | 'heuristic'
      sourceVersion?: string
    }
  | { type: 'query'; id: number; kind: string; args: Record<string, unknown> }
  | { type: 'shutdown' }

/** Transcripts worker -> main */
export type FromTranscriptsWorker =
  | { type: 'ready' }
  | { type: 'health'; inFlight: number; tailing: number; messagesTotal: number; dbBytes: number }
  | { type: 'log'; entry: { level: 'info' | 'warn' | 'error'; message: string } }
  | { type: 'query-result'; id: number; rows: unknown[] }
  | { type: 'new-messages'; sessionId: string; configId: string | null; count: number }
  | { type: 'error'; id?: number; message: string }

/** Main-side handle to the transcripts worker.
 *  NOTE: `onMessage` is SINGLE-HANDLER — the last registration wins. */
export interface TranscriptsWorkerTransport {
  post(msg: ToTranscriptsWorker): void
  onMessage(handler: (msg: FromTranscriptsWorker) => void): void
  kill(): void
}

/** Worker-side inverse: post() sends FromTranscriptsWorker to main;
 *  onMessage() receives ToTranscriptsWorker. */
export interface TranscriptsWorkerHostTransport {
  post(msg: FromTranscriptsWorker): void
  onMessage(handler: (msg: ToTranscriptsWorker) => void): void
}

/** In-memory fake mirroring FakeWorkerTransport for the transcripts contract. */
export class FakeTranscriptsWorkerTransport implements TranscriptsWorkerTransport {
  private workerHandler: ((m: ToTranscriptsWorker) => void) | null = null
  private mainHandler: ((m: FromTranscriptsWorker) => void) | null = null
  killed = false
  /** All messages posted from main to the worker (in order). */
  workerMessages: ToTranscriptsWorker[] = []

  post(msg: ToTranscriptsWorker): void {
    this.workerMessages.push(msg)
    this.workerHandler?.(msg)
  }

  onMessage(handler: (m: FromTranscriptsWorker) => void): void {
    this.mainHandler = handler
  }

  kill(): void {
    this.killed = true
  }

  // --- test helpers ---

  /** Register a handler that receives messages the main side posts to the worker. */
  onWorker(handler: (m: ToTranscriptsWorker) => void): void {
    this.workerHandler = handler
  }

  /** Simulate the worker sending a message back to the main side. */
  emitToMain(msg: FromTranscriptsWorker): void {
    this.mainHandler?.(msg)
  }

  /** View this fake from the WORKER side: post() -> main (emitToMain),
   *  onMessage() receives what main posted (onWorker). */
  asWorkerSide(): TranscriptsWorkerHostTransport {
    return {
      post: (m: FromTranscriptsWorker) => this.emitToMain(m),
      onMessage: (h: (m: ToTranscriptsWorker) => void) => this.onWorker(h),
    }
  }
}

