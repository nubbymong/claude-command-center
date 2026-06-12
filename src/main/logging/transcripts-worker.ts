/**
 * transcripts-worker.ts — Logs v2 utilityProcess worker (transcript-indexing).
 *
 * Replaces the byte-capture log-worker for the LIVE app: instead of receiving
 * terminal bytes, this worker TAILS Claude Code transcript JSONL files itself.
 * Main sends only run lifecycle (run-start / run-end / run-account), transcript
 * bindings (transcript-bind) and queries.
 *
 * TWO PARTS (mirrors log-worker.ts):
 *  1. Pure, exported `createTranscriptsWorker(host, fsImpl?)` factory — testable
 *     with a FakeTranscriptsWorkerTransport.asWorkerSide() host and tmp dirs.
 *     Returns a handle with `tickNow()` / `healthNow()` / `stop()` so tests can
 *     drive the tail loop deterministically (no fake timers needed).
 *  2. Guarded bootstrap — wires `process.parentPort` to the factory. Importing
 *     this module in a test (parentPort undefined) is a no-op.
 *
 * IMPORT RULES:
 *  - No `electron` import — a utilityProcess child uses `process.parentPort`.
 *  - Must NEVER be statically imported by main-process code (better-sqlite3
 *    lives only here). The supervisor forks it by FILE PATH.
 *
 * TAIL LOOP CONTRACT:
 *  - One persistent normalizer per tailed transcript (idx/ts continuity).
 *  - Byte-exact cursor: only complete lines (up to the last '\n') are consumed;
 *    a partial trailing line stays unconsumed until completed. All offsets are
 *    BYTE offsets (multi-byte UTF-8 safe — lines are decoded only after being
 *    sliced on the '\n' byte).
 *  - Atomicity: each batch commits rows + cursor in ONE transaction via
 *    db.appendBatch — a crash between batches can never duplicate or skip
 *    messages on resume.
 *  - Bounded batches (<=512 msgs or ~1 MiB of consumed bytes per transaction);
 *    a `new-messages` post follows every non-empty batch.
 *  - Poison-message guard: the host handler NEVER throws; failures are posted
 *    as `error` (with the query id when one exists).
 */
import * as nodeFs from 'fs'
import { openTranscriptsDb } from './transcripts-db'
import type { TranscriptsDb, NewMessage, TranscriptScope } from './transcripts-db'
import { makeNormalizer, PARSER_VERSION } from './transcript-normalizer'
import { mangleCwdToProjectDir } from '../../shared/project-key'
import type { Normalizer } from './transcript-normalizer'
import type {
  ToTranscriptsWorker,
  FromTranscriptsWorker,
  TranscriptsWorkerHostTransport,
} from './log-worker-transport'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const TAIL_INTERVAL_MS = 1000
const HEALTH_INTERVAL_MS = 10_000
/** Per-transaction bounds: flush a batch at 512 messages or ~1 MiB consumed. */
const MAX_BATCH_MSGS = 512
const MAX_BATCH_BYTES = 1024 * 1024
/** Per-transcript per-tick consumption cap so one giant catch-up (first index of
 *  a large transcript) cannot wedge the worker's event loop for the duration —
 *  the remainder is picked up on subsequent ticks. */
const MAX_TICK_BYTES = 16 * 1024 * 1024
const READ_BUF_SIZE = 256 * 1024

// ---------------------------------------------------------------------------
// Injectable fs surface (tests can substitute; defaults to node:fs)
// ---------------------------------------------------------------------------

export interface TranscriptsWorkerFs {
  statSync(path: string): { size: number }
  openSync(path: string, flags: string): number
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number
  closeSync(fd: number): void
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

interface TailState {
  transcriptId: number
  runId: number
  sessionId: string
  configId: string | null
  path: string
  /** Byte offset of the consumed prefix (always just past a '\n'). */
  cursor: number
  normalizer: Normalizer
}

export interface TranscriptsWorker {
  /** Run one tail tick now (the interval calls this; tests call it directly). */
  tickNow(): void
  /** Post one health beat now (tests). */
  healthNow(): void
  /** Stop timers + close the DB (the shutdown path; also used by tests). */
  stop(): void
}

export function createTranscriptsWorker(
  host: TranscriptsWorkerHostTransport,
  fsImpl?: TranscriptsWorkerFs,
): TranscriptsWorker {
  const fsi: TranscriptsWorkerFs = fsImpl ?? nodeFs
  let db: TranscriptsDb | undefined
  let dbPath: string | undefined
  /** Messages ingested since THIS worker instance started (resets on restart;
   *  NOT the cumulative DB total). Surfaced as the health beat's messagesTotal. */
  let messagesTotal = 0
  /** sessionId -> LATEST runId (run-start overwrites; run-end deletes). */
  const sessionToRun = new Map<string, number>()
  /** transcriptId -> live tail state. */
  const tails = new Map<number, TailState>()
  /** transcriptIds that have already emitted the "shrank below cursor" warn (once each). */
  const shrinkWarned = new Set<number>()
  let tailTimer: ReturnType<typeof setInterval> | null = null
  let healthTimer: ReturnType<typeof setInterval> | null = null
  let ticking = false

  const post = (m: FromTranscriptsWorker): void => host.post(m)
  const log = (level: 'info' | 'warn' | 'error', message: string): void =>
    post({ type: 'log', entry: { level, message } })

  // -------------------------------------------------------------------------
  // Tail mechanics
  // -------------------------------------------------------------------------

  /** Commit a batch (rows + cursor, one transaction) and post new-messages. */
  function flushBatch(tail: TailState, msgs: NewMessage[], newCursor: number): void {
    db!.appendBatch(tail.runId, tail.transcriptId, msgs, newCursor)
    tail.cursor = newCursor
    if (msgs.length > 0) {
      messagesTotal += msgs.length
      post({ type: 'new-messages', sessionId: tail.sessionId, configId: tail.configId, count: msgs.length })
    }
  }

  /**
   * Drain appended bytes for one tailed transcript. Synchronous (bounded by
   * MAX_TICK_BYTES). Returns:
   *  - 'ok'      — drained (or nothing new); keep tailing.
   *  - 'missing' — the file is gone; caller marks failed + drops the tail.
   *  - 'shrank'  — the file shrank below the cursor (unexpected: Claude transcripts
   *    are APPEND-ONLY, and rotation is a NEW file handled by re-bind). This drain
   *    already marked the transcript 'failed' + dropped it; caller just stops.
   */
  function drainTail(tail: TailState): 'ok' | 'missing' | 'shrank' {
    let size: number
    try {
      size = fsi.statSync(tail.path).size
    } catch {
      return 'missing' // missing file
    }
    // Append-only assumption: the file only ever grows; a strict shrink means an
    // unexpected in-place truncation. Rather than silently stalling forever (the
    // cursor would never catch up), warn ONCE and fail the tail.
    if (size < tail.cursor) {
      if (!shrinkWarned.has(tail.transcriptId)) {
        shrinkWarned.add(tail.transcriptId)
        log('warn', `[tail] transcript shrank below cursor — unexpected for append-only transcripts; halting tail: ${tail.path}`)
      }
      try {
        db!.setTranscriptStatus(tail.transcriptId, 'failed')
      } catch {
        /* db gone mid-shutdown */
      }
      tails.delete(tail.transcriptId)
      return 'shrank'
    }
    if (size === tail.cursor) return 'ok' // normal no-op: nothing new appended

    const end = Math.min(size, tail.cursor + MAX_TICK_BYTES)
    const fd = fsi.openSync(tail.path, 'r')
    try {
      let pos = tail.cursor
      /** Bytes read but not yet line-terminated (partial line carry). */
      let carry: Buffer = Buffer.alloc(0)
      let batch: NewMessage[] = []
      /** Consumed bytes in the CURRENT batch (transaction size bound). */
      let batchBytes = 0
      /** File offset just past the last consumed '\n' (what the batch commits). */
      let consumedCursor = tail.cursor
      const buf = Buffer.alloc(READ_BUF_SIZE)

      while (pos < end) {
        const n = fsi.readSync(fd, buf, 0, Math.min(READ_BUF_SIZE, end - pos), pos)
        if (n <= 0) break
        pos += n
        // Buffer.concat copies, so `chunk` owns its memory; `buf` is reused next read.
        const chunk = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n))
        let lineStart = 0
        for (;;) {
          const nl = chunk.indexOf(0x0a, lineStart)
          if (nl === -1) break
          let lineBuf = chunk.subarray(lineStart, nl)
          // CRLF: strip the trailing '\r' from the decoded line but count its byte.
          if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
            lineBuf = lineBuf.subarray(0, lineBuf.length - 1)
          }
          const consumed = nl - lineStart + 1 // line bytes incl. '\r', plus the '\n'
          batch.push(...tail.normalizer.push(lineBuf.toString('utf8')))
          batchBytes += consumed
          consumedCursor += consumed
          lineStart = nl + 1
          if (batch.length >= MAX_BATCH_MSGS || batchBytes >= MAX_BATCH_BYTES) {
            flushBatch(tail, batch, consumedCursor)
            batch = []
            batchBytes = 0
          }
        }
        carry = Buffer.from(chunk.subarray(lineStart))
      }

      // Final flush: commit any remaining rows AND/OR a cursor-only advance for
      // consumed lines that produced no messages (meta/blank lines).
      if (batch.length > 0 || consumedCursor > tail.cursor) {
        flushBatch(tail, batch, consumedCursor)
      }
      // The partial trailing line (carry) is intentionally NOT consumed: the
      // cursor stays at the last '\n', so the completed line is read next tick.
      return 'ok'
    } finally {
      try {
        fsi.closeSync(fd)
      } catch {
        /* best-effort */
      }
    }
  }

  /** One pass over every tailed transcript. Re-entrancy-guarded. */
  function tickNow(): void {
    if (ticking || !db) return
    ticking = true
    try {
      for (const tail of [...tails.values()]) {
        try {
          const res = drainTail(tail)
          if (res === 'missing') {
            // Missing file: mark failed, KEEP its messages, stop tailing it.
            log('warn', `[tail] transcript file missing, marking failed: ${tail.path}`)
            try {
              db.setTranscriptStatus(tail.transcriptId, 'failed')
            } catch {
              /* db gone mid-shutdown */
            }
            tails.delete(tail.transcriptId)
          }
          // 'shrank' already marked failed + dropped the tail inside drainTail.
        } catch (err) {
          // A DB/read error on this transcript must never kill the loop. Mark it
          // failed (a deterministic error would otherwise re-fire every tick).
          log('error', `[tail] ingest failed for ${tail.path}: ${err instanceof Error ? err.message : String(err)}`)
          try {
            db.setTranscriptStatus(tail.transcriptId, 'failed')
          } catch {
            /* best-effort */
          }
          tails.delete(tail.transcriptId)
        }
      }
    } finally {
      ticking = false
    }
  }

  /** Final-drain + mark + stop every tail belonging to runId. */
  function stopTailsForRun(runId: number, status: 'complete' | 'failed', exceptTranscriptId?: number): void {
    for (const tail of [...tails.values()]) {
      if (tail.runId !== runId || tail.transcriptId === exceptTranscriptId) continue
      try {
        drainTail(tail) // pick up any lines written just before the run ended
      } catch {
        /* best-effort final drain */
      }
      try {
        db!.setTranscriptStatus(tail.transcriptId, status)
      } catch {
        /* best-effort */
      }
      tails.delete(tail.transcriptId)
    }
  }

  function startTail(meta: {
    transcriptId: number
    runId: number
    sessionId: string
    configId: string | null
    path: string
    cursor: number
  }): void {
    tails.set(meta.transcriptId, {
      ...meta,
      // Seed idx/ts continuity from what the run already stored.
      normalizer: makeNormalizer({
        startIdx: db!.nextIdx(meta.runId),
        startTs: db!.lastMessageTs(meta.runId) ?? 0,
      }),
    })
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  function healthNow(): void {
    let dbBytes = 0
    if (dbPath && dbPath !== ':memory:') {
      try {
        dbBytes = fsi.statSync(dbPath).size
      } catch {
        /* not flushed yet */
      }
    }
    post({ type: 'health', inFlight: 0, tailing: tails.size, messagesTotal, dbBytes })
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function open(path: string): void {
    db = openTranscriptsDb(path)
    dbPath = path

    // 1. Close dangling runs (previous app session died with runs open).
    const closed = db.closeDanglingRuns()
    if (closed > 0) log('info', `[open] closed ${closed} dangling run(s) as crashed`)

    // 2. Resume tails left 'tailing' by the previous worker instance.
    //    Step 1 just marked every dangling run 'crashed'. A run with a resumable
    //    transcript is actually still live (worker-only restart while Claude keeps
    //    appending), so REOPEN it to 'running' before tailing — otherwise we would
    //    keep appending into a 'crashed' run with a frozen endedAt. A dangling run
    //    with NO resumable transcript correctly stays 'crashed'.
    //    NOTE: sessionToRun is intentionally NOT repopulated here. Resumed tails are
    //    keyed by transcriptId in `tails`, so the tick loop drains them fine. But a
    //    run-account / run-end / transcript-bind that arrives for a resumed-but-not-
    //    yet-respawned session looks up sessionToRun and would miss — the supervisor's
    //    ordered while-down buffer must replay run-start FIRST so the map is seeded
    //    before any such message is processed.
    for (const r of db.listResumableTranscripts()) {
      const scope = db.getRunScope(r.runId)
      if (!scope) continue
      db.reopenRun(r.runId)
      startTail({
        transcriptId: r.transcriptId,
        runId: r.runId,
        sessionId: scope.sessionId,
        configId: scope.configId,
        path: r.path,
        cursor: r.ingestCursor,
      })
    }

    // 3. Timers (unref'd so they never keep a dying process alive).
    tailTimer = setInterval(tickNow, TAIL_INTERVAL_MS)
    ;(tailTimer as { unref?: () => void }).unref?.()
    healthTimer = setInterval(healthNow, HEALTH_INTERVAL_MS)
    ;(healthTimer as { unref?: () => void }).unref?.()

    post({ type: 'ready' })
  }

  function stop(): void {
    if (tailTimer) {
      clearInterval(tailTimer)
      tailTimer = null
    }
    if (healthTimer) {
      clearInterval(healthTimer)
      healthTimer = null
    }
    try {
      db?.close()
    } catch {
      /* already closed */
    }
    db = undefined
    dbPath = undefined
    tails.clear()
    sessionToRun.clear()
    shrinkWarned.clear()
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  function scopeFromArgs(args: Record<string, unknown>): TranscriptScope {
    if (typeof args.configId === 'string') return { configId: args.configId }
    if (typeof args.sessionId === 'string') return { sessionId: args.sessionId }
    throw new Error('query args must include configId or sessionId')
  }

  function handleQuery(id: number, kind: string, args: Record<string, unknown>): void {
    let rows: unknown[]
    switch (kind) {
      case 'list-slots':
        rows = db!.listSlots()
        break
      case 'read-messages': {
        const scope = scopeFromArgs(args)
        const a = args.anchor
        const anchor =
          a !== null && typeof a === 'object' &&
          typeof (a as Record<string, unknown>).runId === 'number' &&
          typeof (a as Record<string, unknown>).idx === 'number'
            ? { runId: (a as { runId: number }).runId, idx: (a as { idx: number }).idx }
            : ('tail' as const)
        const dir = args.dir === 'newer' ? ('newer' as const) : ('older' as const)
        const limit = typeof args.limit === 'number' ? args.limit : 200
        rows = db!.readMessagesPage(scope, { anchor, dir, limit })
        break
      }
      case 'turn-summary':
        rows = db!.turnSummary(scopeFromArgs(args))
        break
      case 'search': {
        const query = typeof args.query === 'string' ? args.query : ''
        const limit = typeof args.limit === 'number' ? args.limit : undefined
        rows = db!.searchMessages(query, limit)
        break
      }
      case 'ingest-stats': {
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
        const res = db!.ingestStats(sessionId)
        rows = res ? [res] : []
        break
      }
      case 'delete-slot': {
        const res = db!.deleteSlot(scopeFromArgs(args))
        db!.checkpoint() // honest dbBytes after a delete
        rows = [res]
        break
      }
      case 'clear-all': {
        const res = db!.clearAll()
        db!.checkpoint()
        rows = [res]
        break
      }
      case 'recent-sessions': {
        const projectDir = typeof args.projectDir === 'string' ? args.projectDir : ''
        const limit = typeof args.limit === 'number' ? args.limit : 5
        rows = db!.sessionActivity()
          .filter((r) => r.projectCwd !== null && mangleCwdToProjectDir(r.projectCwd) === projectDir)
          .slice(0, limit)
          .map((r) => ({ sessionId: r.sessionId, lastActive: r.lastActive }))
        break
      }
      case 'session-config': {
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
        const res = db!.sessionConfig(sessionId)
        rows = res ? [res] : []
        break
      }
      default:
        // Poison guard: an unknown kind answers with a correlated error, never a crash.
        post({ type: 'error', id, message: `unknown query kind: ${kind}` })
        return
    }
    post({ type: 'query-result', id, rows })
  }

  // -------------------------------------------------------------------------
  // Message dispatch
  // -------------------------------------------------------------------------

  function handle(msg: ToTranscriptsWorker): void {
    switch (msg.type) {
      case 'open':
        try {
          open(msg.dbPath)
        } catch (err) {
          post({ type: 'error', message: `failed to open DB: ${err instanceof Error ? err.message : String(err)}` })
        }
        return

      case 'shutdown':
        stop()
        // Let the process exit naturally; the supervisor awaits/kills it.
        return
    }

    // Everything else requires an open DB.
    if (!db) {
      post({
        type: 'error',
        id: msg.type === 'query' ? msg.id : undefined,
        message: `worker received ${msg.type} before open`,
      })
      return
    }

    switch (msg.type) {
      case 'run-start': {
        const runId = db.insertRun(msg.meta)
        sessionToRun.set(msg.meta.sessionId, runId)
        return
      }

      case 'run-end': {
        const runId = sessionToRun.get(msg.sessionId)
        // Final-drain + complete this run's tails BEFORE closing the run so
        // endedAt-adjacent lines are ingested and the transcripts retire cleanly.
        if (runId !== undefined) {
          stopTailsForRun(runId, 'complete')
          sessionToRun.delete(msg.sessionId)
        }
        db.closeRun(msg.sessionId, msg.ts, msg.status)
        return
      }

      case 'run-account':
        db.setRunAccount(msg.sessionId, msg.accountEmail)
        return

      case 'transcript-bind': {
        const runId = sessionToRun.get(msg.sessionId)
        if (runId === undefined) {
          log('warn', `[bind] dropped transcript-bind for unknown session ${msg.sessionId}`)
          return
        }
        const bound = db.bindTranscript(runId, msg.path, {
          confidence: msg.confidence,
          sourceVersion: msg.sourceVersion,
          parserVersion: PARSER_VERSION,
        })
        if (bound.isNew && bound.ord > 0) {
          // Rotation within a run (e.g. /clear): retire the previous tails FIRST
          // (final drain) so the divider and the new tail's normalizer allocate
          // idx strictly after everything already ingested — two live normalizers
          // on one run would otherwise collide on idx.
          stopTailsForRun(runId, 'complete', bound.transcriptId)
          db.appendMessages(runId, [
            { idx: db.nextIdx(runId), ts: Date.now(), role: 'system', kind: 'clear', content: '' },
          ])
        }
        db.setTranscriptStatus(bound.transcriptId, 'tailing')
        if (!tails.has(bound.transcriptId)) {
          const scope = db.getRunScope(runId)
          startTail({
            transcriptId: bound.transcriptId,
            runId,
            sessionId: msg.sessionId,
            configId: scope?.configId ?? null,
            path: msg.path,
            cursor: bound.cursor,
          })
        }
        return
      }

      case 'query':
        handleQuery(msg.id, msg.kind, msg.args)
        return

      default: {
        const _exhaustive: never = msg
        void _exhaustive
        return
      }
    }
  }

  // Defense-in-depth: NOTHING escaping handle() may crash the worker process —
  // a deterministic poison message would drive the supervisor's restart loop
  // straight to permanent degrade. Correlate query errors by id.
  host.onMessage((msg) => {
    const queryId = msg?.type === 'query' ? msg.id : undefined
    try {
      handle(msg)
    } catch (err) {
      try {
        post({
          type: 'error',
          id: queryId,
          message: `worker message handling failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      } catch {
        /* transport gone */
      }
    }
  })

  return { tickNow, healthNow, stop }
}

// ---------------------------------------------------------------------------
// Guarded utilityProcess bootstrap.
//
// `process.parentPort` is only defined inside a utilityProcess child (Electron).
// In tests it is undefined and this block is skipped — safe to import freely.
// ---------------------------------------------------------------------------

const parentPort = (process as unknown as {
  parentPort?: {
    on(event: 'message', handler: (e: { data: unknown }) => void): void
    postMessage(msg: FromTranscriptsWorker): void
  }
}).parentPort

if (parentPort) {
  const host: TranscriptsWorkerHostTransport = {
    post: (m) => parentPort.postMessage(m),
    onMessage: (h) => parentPort.on('message', (e) => h(e.data as ToTranscriptsWorker)),
  }
  createTranscriptsWorker(host)
}
