/**
 * log-worker.ts — logging utilityProcess worker.
 *
 * TWO PARTS:
 *  1. Pure, exported `handleWorkerMessage(db, msg, post)` — testable with a
 *     real :memory: DB and a fake `post`. All DB writes and query responses go
 *     through here; it never touches parentPort.
 *  2. Guarded bootstrap — wires `process.parentPort` to the handler, opens the
 *     DB, posts periodic health, and checkpoints WAL. The guard ensures that
 *     importing this module in a test (where parentPort is undefined) is a
 *     no-op.
 *
 * IMPORT RULES:
 *  - No `electron` import — a utilityProcess child uses `process.parentPort`,
 *    not the electron module.
 *  - Must NEVER be statically imported by main-process code. The supervisor
 *    (Task 6) forks it by FILE PATH.
 */
import * as fs from 'fs'
import { openLogDb } from './log-db'
import type { LogDb } from './log-db'
import { stripAnsi } from './ansi-strip'
import type { ToWorker, FromWorker } from './log-worker-transport'

// ---------------------------------------------------------------------------
// Internal counters — shared across all handleWorkerMessage calls made against
// the same module instance. Tests that call handleWorkerMessage directly will
// share these, which is fine: the tests only assert that drops are reflected,
// not the exact cumulative total across independent test cases.
// ---------------------------------------------------------------------------

let _eventsTotal = 0
let _dropsTotal = 0

/** Read the current counters (used by the bootstrap health timer). */
export function getStats(): { eventsTotal: number; dropsTotal: number } {
  return { eventsTotal: _eventsTotal, dropsTotal: _dropsTotal }
}

// ---------------------------------------------------------------------------
// Pure handler — no parentPort, no side-effects beyond the DB and the post cb.
// ---------------------------------------------------------------------------

/**
 * Apply a single ToWorker message to the database and post any response via
 * `post`. `open` and `shutdown` are lifecycle messages handled by the bootstrap;
 * the pure handler ignores them (no-op) rather than throwing.
 *
 * Wrapped in try/catch — errors are reported via `post({type:'error'})` and
 * never propagate to the caller.
 */
export function handleWorkerMessage(
  db: LogDb,
  msg: ToWorker,
  post: (m: FromWorker) => void,
): void {
  try {
    _handleWorkerMessage(db, msg, post)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    post({ type: 'error', message })
  }
}

function _handleWorkerMessage(
  db: LogDb,
  msg: ToWorker,
  post: (m: FromWorker) => void,
): void {
  switch (msg.type) {
    // ---- open / shutdown: lifecycle — bootstrap handles these, not this fn ----
    case 'open':
    case 'shutdown':
      // No-op in the pure handler; bootstrap owns lifecycle.
      return

    // ---- session-start ----
    case 'session-start':
      db.upsertSession(msg.meta)
      return

    // ---- session-end ----
    case 'session-end':
      db.finishSession(msg.sessionId, msg.ts, msg.status)
      return

    // ---- batch ----
    case 'batch': {
      const flat: Array<{
        sessionId: string
        ts: number
        type: 'start' | 'data' | 'restart' | 'switch' | 'end'
        raw: Buffer | Uint8Array
        text: string
      }> = []

      for (const sess of msg.sessions) {
        // Flatten all chunks for this session into the flat array
        for (const chunk of sess.chunks) {
          const text = stripAnsi(Buffer.from(chunk.raw).toString('utf8'))
          flat.push({
            sessionId: sess.sessionId,
            ts: chunk.ts,
            type: chunk.type,
            raw: chunk.raw,
            text,
          })
          _eventsTotal += 1
        }

        // If any bytes were dropped by the PTY ring-buffer, insert a visible
        // gap marker so replay shows the discontinuity.
        const dropped = sess.dropped ?? 0
        if (dropped > 0) {
          _dropsTotal += dropped
          const markerText = `\n[${dropped} bytes dropped]\n`
          flat.push({
            sessionId: sess.sessionId,
            ts: sess.chunks.length > 0 ? sess.chunks[sess.chunks.length - 1].ts : Date.now(),
            type: 'data',
            raw: Buffer.alloc(0),
            text: markerText,
          })
        }
      }

      // ONE appendBatch call = one SQLite transaction for the whole message.
      db.appendBatch(flat)
      return
    }

    // ---- query ----
    case 'query': {
      const { id, kind, args } = msg
      let rows: unknown[]

      switch (kind) {
        case 'listSessions': {
          const opts: { offset?: number; limit?: number } = {}
          if (typeof args.offset === 'number') opts.offset = args.offset
          if (typeof args.limit === 'number') opts.limit = args.limit
          rows = db.listSessions(opts)
          break
        }
        case 'readEvents': {
          const sessionId = args.sessionId as string
          const offset = typeof args.offset === 'number' ? args.offset : 0
          const limit = typeof args.limit === 'number' ? args.limit : 100
          rows = db.readEvents(sessionId, { offset, limit })
          break
        }
        case 'search': {
          const query = args.query as string
          const opts: { limit?: number } = {}
          if (typeof args.limit === 'number') opts.limit = args.limit
          rows = db.search(query, opts)
          break
        }
        default: {
          post({ type: 'error', message: `unknown query kind: ${kind}` })
          return
        }
      }

      post({ type: 'query-result', id, rows })
      return
    }

    // ---- reconcile ----
    case 'reconcile':
      db.markRunningCrashed()
      return

    default: {
      // Exhaustiveness guard — should never happen with correct ToWorker union.
      const _exhaustive: never = msg
      void _exhaustive
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Guarded utilityProcess bootstrap.
//
// `process.parentPort` is only defined when running inside a utilityProcess
// child (Electron). When this module is imported in tests, parentPort is
// undefined and the block below is skipped entirely — safe to import freely.
// ---------------------------------------------------------------------------

// Top-level fs import is fine: Node built-in, loaded in any Node/worker context.

const parentPort = (process as any).parentPort as
  | {
      on(event: 'message', handler: (e: { data: unknown }) => void): void
      postMessage(msg: FromWorker): void
    }
  | undefined

if (parentPort) {
  // Single mutable state for the bootstrap — both the message handler and the
  // health timer close over these variables.
  let db: LogDb | undefined
  let openedDbPath: string | undefined

  const post = (m: FromWorker) => parentPort!.postMessage(m)

  parentPort.on('message', (e) => {
    const msg = e.data as ToWorker

    // ---- open: lifecycle ----
    if (msg.type === 'open') {
      try {
        db = openLogDb(msg.dbPath)
        openedDbPath = msg.dbPath
        post({ type: 'ready' })
      } catch (err: unknown) {
        post({
          type: 'error',
          message: `failed to open DB: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
      return
    }

    // ---- shutdown: lifecycle ----
    if (msg.type === 'shutdown') {
      db?.close()
      db = undefined
      openedDbPath = undefined
      // Let the process exit naturally; the supervisor will await it.
      return
    }

    // ---- all other messages require an open DB ----
    if (!db) {
      post({ type: 'error', message: `worker received ${msg.type} before open` })
      return
    }

    handleWorkerMessage(db, msg, post)
  })

  // ---- periodic health report (every 10 s) ----
  // dbBytes: read the DB file size when available; :memory: reports 0.
  const HEALTH_INTERVAL_MS = 10_000

  setInterval(() => {
    let dbBytes = 0
    if (openedDbPath && openedDbPath !== ':memory:') {
      try {
        dbBytes = fs.statSync(openedDbPath).size
      } catch {
        // DB file might not be flushed yet — ignore
      }
    }
    const { eventsTotal, dropsTotal } = getStats()
    post({
      type: 'health',
      inFlight: 0, // synchronous worker — no async in-flight ops
      eventsTotal,
      dropsTotal,
      dbBytes,
    })
  }, HEALTH_INTERVAL_MS).unref()

  // TODO (Task 6/8): WAL checkpoint cadence. Preferred approach: add a
  // `checkpoint()` method to LogDb (it owns the connection) and call it from
  // the periodic health timer or a separate interval. Avoids reaching into raw
  // SQLite from here. Deferred to avoid scope-creep in Task 5.
}
