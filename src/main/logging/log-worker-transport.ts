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

/**
 * Final report of a migrate-dir run (the worker-internal streaming legacy
 * import). Field semantics match the old main-side ImportReport + parse tallies
 * so the renderer's reconciliation contract is unchanged:
 *   detectedFolders === totalSessions + foldedPartnerDirs + noEventDirs
 * For groups that are SKIPPED without parsing (already complete in the DB) or
 * that FAIL mid-stream, extra member dirs are attributed to foldedPartnerDirs —
 * a documented approximation that keeps the identity exact without re-parsing.
 */
export interface DirMigrationReport {
  totalSessions: number
  importedSessions: number
  skippedSessions: number
  /** Sessions whose streamed import failed (data did NOT fully reach the DB; the
   *  row stays status='importing'). Any failure blocks the completion marker. */
  failedSessions: number
  importedEvents: number
  unparseable: { path: string; reason: string; skippedLines: number }[]
  foldedPartnerDirs: number
  noEventDirs: number
}

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
  | {
      type: 'migrate'
      /** Correlates this chunk's ack back to the caller. */
      id: number
      sessions: {
        sessionId: string
        configLabel: string
        projectCwd?: string
        accountEmail?: string
        profileId?: string
        provider: string
        startedAt: number
        events: { ts: number; type: 'start' | 'data' | 'restart' | 'switch' | 'end'; raw: Uint8Array; text: string }[]
      }[]
    }
  | {
      /** Worker-internal streaming legacy import: the worker walks + parses the
       *  legacy tree ITSELF (no 16 GB transits the process boundary) and imports
       *  group by group with bounded memory, interleaving live capture. */
      type: 'migrate-dir'
      id: number
      logsDir: string
      /** Event-batch byte budget (default 4 MiB). Tests shrink it to force splits. */
      batchBytes?: number
    }
  | { type: 'reconcile' }
  | { type: 'shutdown' }

/** Worker -> main */
export type FromWorker =
  | { type: 'ready' }
  | { type: 'health'; inFlight: number; eventsTotal: number; dropsTotal: number; dbBytes: number }
  | { type: 'log'; entry: { level: 'info' | 'warn' | 'error'; message: string } }
  | { type: 'query-result'; id: number; rows: unknown[] }
  | { type: 'migrate-progress'; id: number; importedSessions: number; skippedSessions: number; failedSessions: number; importedEvents: number }
  | { type: 'migrate-dir-progress'; id: number; done: number; total: number }
  | { type: 'migrate-dir-done'; id: number; report: DirMigrationReport }
  | { type: 'migrate-error'; id: number; message: string }
  | { type: 'error'; id?: number; message: string }

// ---------------------------------------------------------------------------
// Transcripts message unions (Logs v2)
//
// The transcript-indexing stack replaces the byte-capture stack above. Both
// contracts coexist until the Phase-5 deletion sweep removes ToWorker/FromWorker
// and the old worker. The transcripts worker tails Claude transcript JSONL
// files ITSELF — main only sends lifecycle (run-start/run-end/run-account),
// bindings (transcript-bind) and queries; no terminal bytes ever transit.
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
