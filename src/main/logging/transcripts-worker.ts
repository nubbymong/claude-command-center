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
import { createHash, type Hash } from 'crypto'
import { basename as pathBasename, dirname as pathDirname } from 'path'
import { claudeFolderKey, claudeProjectsRootKey } from './claude-folder-key'
import { CODEX_FOLDER_KEY_PREFIX, codexFolderKey, codexSessionMetaCwd } from './codex-folder-key'
import { readBoundedFirstLine } from './bounded-first-line'
import { openTranscriptsDb } from './transcripts-db'
import type { TranscriptsDb, NewMessage, TranscriptScope } from './transcripts-db'
import { makeNormalizer, PARSER_VERSION } from './transcript-normalizer'
import { makeCodexRolloutNormalizer, CODEX_PARSER_VERSION } from './codex-rollout-normalizer'
import { mangleCwdToProjectDir } from '../../shared/project-key'
import { codexConversationKey } from '../../shared/codex-conversation-key'
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
  /** P3.12 round 1: an open file's identity, for a Codex tail. */
  fstatSync?(fd: number, opts: { bigint: true }): { dev: bigint; ino: bigint }
}

/** P3.12 round 1 (V2): the most of a carried copy compared with the rollout
 *  it came from, to continue where that was read. */
const CONTINUE_COMPARE_MAX_BYTES = 64 * 1024 * 1024

/** P3.12 round 2 (W4): the divider where a conversation's indexing resumes
 *  after a stretch it was not indexed; that stretch is never indexed. */
export const NOT_INDEXED_DIVIDER = 'Not indexed while logging was off'



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
  /** P3.12 round 1 (A1): a Codex rollout's file identity (dev:ino) as its
   *  watcher claimed it; only that file is read at the path. */
  identity?: string
  /** P3.12 (X4): a Codex tail's running SHA-256 of every byte it consumed
   *  from the file's start (absent when it did not read from there). */
  digest?: Hash
  /** P3.12 (Y3): the stored digest of what was read up to `cursor`, checked
   *  (and the running digest built) only when the tail next reads. */
  digestStored?: string
  /** P3.16 (M1): whether this tail stores the digest of what it read with its
   *  cursor (a Codex tail with its claimed identity, and a Claude tail). */
  vouches?: boolean
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
  /** P3.12 (Y1): when each Codex conversation (its rollout id) was written
   *  while not indexed, from main: windows [start, end), end null while
   *  open; and `before`, every record stamped earlier. */
  const notIndexedWindows = new Map<string, Array<[number, number | null]>>()
  let notIndexedBefore: number | null = null
  /** PR-level ADR-009 round 1 (C1): the Codex launch folders main has windows
   *  for (codex-folder-key.ts), for a rollout whose folder cannot be read. */
  const codexFolderKeys = new Set<string>()
  /** Whether a record written at `ts` under any of `keys` (its conversation,
   *  and for a Claude transcript its projects folder, P3.16 round 1 N1; for a
   *  Codex rollout the folder it records, PR-level ADR-009 round 1 C1) is
   *  left out. A record with no time (none of its own, none before it in the
   *  read) is left out whenever any of them has such a rule. A record at a
   *  window's start is inside it; one at its end is not. */
  function notIndexedAt(keys: Iterable<string>, ts: number | null): boolean {
    const lists: Array<Array<[number, number | null]>> = []
    for (const k of keys) { const l = notIndexedWindows.get(k); if (l && l.length > 0) lists.push(l) }
    if (lists.length === 0 && notIndexedBefore === null) return false
    if (ts === null) return true
    if (notIndexedBefore !== null && ts < notIndexedBefore) return true
    return lists.some((list) => list.some(([start, end]) => ts >= start && (end === null || ts < end)))
  }
  /** PR-level ADR-009 round 1 (C1): the key of the folder a rollout's first
   *  line (its session_meta) records (round 2, K2: whichever realm the
   *  rollout lies in); null when that line cannot be read, or records no
   *  folder. Round 2 (K5): read with the rollout lookup's own reader and
   *  bound, through this worker's file port. */
  function codexFolderOf(path: string): string | null {
    const head = readBoundedFirstLine(path, fsi)
    if (!head || head.kind !== 'line') return null
    const cwd = codexSessionMetaCwd(head.line)
    return cwd ? codexFolderKey(cwd) : null
  }
  /** P3.12 (X4): the running digest of the first `cursor` bytes of `path`,
   *  when they are what a tail read (their SHA-256 is `stored`, the digest
   *  kept with that cursor); else none. A carried copy continues only where
   *  its own first bytes have that digest, whatever the earlier file holds now. */
  function digestIfRead(path: string, cursor: number, stored: string | null | undefined): Hash | undefined {
    if (!stored || cursor <= 0 || cursor > CONTINUE_COMPARE_MAX_BYTES) return undefined
    const hash = prefixHash(path, cursor)
    return hash && hash.copy().digest('hex') === stored ? hash : undefined
  }
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
    // P3.12, P3.16 (M1): a tail stores the digest of what it read with its
    // cursor (none when it cannot vouch for it), a Claude tail as a Codex one.
    const readDigest = !tail.vouches ? undefined : tail.digest ? tail.digest.copy().digest('hex') : null
    db!.appendBatch(tail.runId, tail.transcriptId, msgs, newCursor, readDigest)
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
   *  - 'replaced' - P3.12 round 1 (A1): a Codex tail's path now holds another
   *    file than the one its watcher claimed; nothing is read, and this drain
   *    already marked the transcript 'failed' and dropped it.
   */
  function drainTail(tail: TailState): 'ok' | 'missing' | 'shrank' | 'replaced' {
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
    // P3.12 (Y3): the running digest of what was read, built when the tail
    // next reads (never at the worker's start).
    if (tail.digestStored !== undefined) {
      tail.digest = digestIfRead(tail.path, tail.cursor, tail.digestStored)
      tail.digestStored = undefined
    }

    const end = Math.min(size, tail.cursor + MAX_TICK_BYTES)
    const fd = fsi.openSync(tail.path, 'r')
    try {
      if (tail.identity !== undefined && !sameFile(fd, tail.identity)) {
        log('warn', `[tail] another file is at a Codex rollout's path; not read, tail retired: ${tail.path}`)
        try {
          db!.setTranscriptStatus(tail.transcriptId, 'failed')
        } catch {
          /* db gone mid-shutdown */
        }
        tails.delete(tail.transcriptId)
        return 'replaced'
      }
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
          // P3.12 (X4): the digest of what a Codex tail consumed, line by line.
          tail.digest?.update(chunk.subarray(lineStart, nl + 1))
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
    } catch (err) {
      // A drain that failed part-way: its digest no longer matches the cursor.
      tail.digest = undefined
      throw err
    } finally {
      try {
        fsi.closeSync(fd)
      } catch {
        /* best-effort */
      }
    }
  }

  /** Whether the open file `fd` is the one with `identity` (dev:ino). A file
   *  system that cannot say is not the same file. */
  function sameFile(fd: number, identity: string): boolean {
    try {
      const st = (fsi.fstatSync ?? ((f: number) => nodeFs.fstatSync(f, { bigint: true })))(fd, { bigint: true })
      return `${st.dev}:${st.ino}` === identity
    } catch {
      return false
    }
  }

  /** P3.12 (X4): the running SHA-256 of the first `n` bytes of `path`, or
   *  null on any doubt. */
  function prefixHash(path: string, n: number): Hash | null {
    let fd: number | null = null
    try {
      if (fsi.statSync(path).size < n) return null
      fd = fsi.openSync(path, 'r')
      const hash = createHash('sha256')
      const buf = Buffer.alloc(READ_BUF_SIZE)
      for (let pos = 0; pos < n; ) {
        const want = Math.min(READ_BUF_SIZE, n - pos)
        const got = fsi.readSync(fd, buf, 0, want, pos)
        if (got !== want) return null
        hash.update(buf.subarray(0, want))
        pos += want
      }
      return hash
    } catch {
      return null
    } finally {
      if (fd !== null) { try { fsi.closeSync(fd) } catch { /* best-effort */ } }
    }
  }

  /**
   * P3.12: where a new run's binding of a Codex rollout starts (and the read
   * digest its tail goes on with), from the same session's earlier runs of
   * this file name (the latest first): the same file at the same path (the
   * same identity: a Restart, a relaunch) continues from what was read, and
   * another file at that path is read from its start; the copy Switch
   * Account made in another account's folder continues where its own first
   * bytes have the digest of what the earlier binding read. Anything else
   * starts at 0. Nothing is indexed twice. (What was written while the
   * conversation was not indexed is left out by record time on every read,
   * wherever it starts: notIndexedAt.)
   *
   * P3.16 (M1): a Claude transcript the same way (Claude's resume continues
   * from what was indexed, as Codex's does), its earlier bindings of the same
   * format. A Claude binding carries no file identity: at the same path the
   * digest of what was read vouches for the file (a file whose first bytes
   * are not what was read is read from its start); where it cannot (an
   * earlier binding that kept none, or more than the compare limit read),
   * the transcript continues from its cursor, as a Claude tail does across a
   * worker restart.
   */
  function continuationStart(runId: number, sessionId: string, path: string, format: 'claude-jsonl' | 'codex-rollout', identity?: string): { cursor: number; digest?: Hash } {
    let size: number
    try {
      size = fsi.statSync(path).size
    } catch {
      return { cursor: 0 }
    }
    for (const prior of db!.priorBindings(runId, pathBasename(path), sessionId, format)) {
      const at = prior.ingestCursor
      if (prior.path === path) {
        if (format === 'codex-rollout') {
          if (prior.sourceIdentity === identity && at > 0 && at <= size) return { cursor: at, digest: digestIfRead(path, at, prior.readDigest) }
          return { cursor: 0 }
        }
        if (at <= 0 || at > size) return { cursor: 0 }
        if (!prior.readDigest || at > CONTINUE_COMPARE_MAX_BYTES) return { cursor: at }
        const read = digestIfRead(path, at, prior.readDigest)
        return read ? { cursor: at, digest: read } : { cursor: 0 }
      }
      if (at > 0 && at <= size && at <= CONTINUE_COMPARE_MAX_BYTES) {
        const read = digestIfRead(path, at, prior.readDigest)
        if (read) return { cursor: at, digest: read }
      }
    }
    return { cursor: 0 }
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
          // 'shrank' and 'replaced' already marked failed + dropped the tail inside drainTail.
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
    /** P3.12: the binding's stored format picks its normalizer. */
    sourceFormat: string
    /** P3.12 round 1 (A1): a Codex rollout's claimed file identity. */
    identity?: string | null
    /** P3.12 (X4): the read digest a Codex tail goes on with. */
    digest?: Hash
    /** P3.12 (Y3): or the stored one, checked when the tail next reads. */
    digestStored?: string | null
  }): void {
    const { sourceFormat, identity, digest, digestStored, ...state } = meta
    // Seed idx/ts continuity from what the run already stored.
    const seed = {
      startIdx: db!.nextIdx(meta.runId),
      startTs: db!.lastMessageTs(meta.runId) ?? 0,
    }
    const codex = sourceFormat === 'codex-rollout'
    // P3.12 round 6 (Z4): the conversation's key, worked out once for this
    // tail. P3.16 (M1): a Claude transcript's too (its file name is the
    // conversation's id, as a rollout's ends with it).
    const conversation = codexConversationKey(meta.path)
    // P3.16 round 1 (N1): a Claude transcript is also left out where its
    // projects folder was marked (a session not indexed that named none).
    // Round 2 (Q2, Q3): and where the projects folders' root above that folder
    // was marked (a session past its cap that named another project's file).
    const folder = pathDirname(meta.path)
    // PR-level ADR-009 round 1 (C1): a Codex rollout is also left out where
    // the folder its session_meta records was marked (a session not indexed
    // launched there, from the moment it became not indexed until it ended;
    // round 2, K2: in any realm, so a Sign in again's copy is left out too),
    // as a Claude transcript is where its projects folder was;
    // worked out once, from the rollout's first line. One whose first line
    // records no folder is left out wherever any Codex folder window covers
    // the record's time. Round 2 (K5): the key list is built once per tail;
    // the folders main has windows for are read as they are at each record
    // (a window kept after the tail started counts too), not copied.
    const codexFolder = codex ? codexFolderOf(meta.path) : null
    const keys = codex ? (codexFolder ? [conversation, codexFolder] : [conversation]) : [conversation, claudeFolderKey(folder), claudeProjectsRootKey(pathDirname(folder))]
    const skip = codex && !codexFolder
      ? (ts: number | null): boolean => notIndexedAt(keys, ts) || notIndexedAt(codexFolderKeys, ts)
      : (ts: number | null): boolean => notIndexedAt(keys, ts)
    // P3.16 (M1): a Claude tail vouches for what it read, as a Codex tail
    // with its claimed identity does.
    const vouches = codex ? !!identity : true
    tails.set(meta.transcriptId, {
      ...state,
      // P3.12 (Y1), P3.16 (M1): a tail leaves out the records written while
      // its conversation was not indexed, by record time, whatever its offset.
      normalizer: codex
        ? makeCodexRolloutNormalizer({ ...seed, skip, skippedLabel: NOT_INDEXED_DIVIDER })
        : makeNormalizer({ ...seed, skip, skippedLabel: NOT_INDEXED_DIVIDER }),
      ...(codex && identity ? { identity } : {}),
      vouches,
      // P3.12 (X4): a tail from the file's start reads it all; one that goes
      // on from a cursor vouches for its bytes only with the digest of what
      // was read before it.
      ...(vouches && (digest || meta.cursor === 0) ? { digest: digest ?? createHash('sha256') } : {}),
      ...(vouches && !digest && meta.cursor > 0 && digestStored ? { digestStored } : {}),
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
      // P3.12 round 2 (W6): a Codex rollout without its claimed identity is
      // not read again.
      if (r.sourceFormat === 'codex-rollout' && !r.sourceIdentity) {
        db.setTranscriptStatus(r.transcriptId, 'complete')
        continue
      }

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
        sourceFormat: r.sourceFormat,
        identity: r.sourceIdentity,
        // P3.12 (Y3): a resumed tail goes on vouching for what it read, its
        // stored digest checked when it next reads (P3.16 M1: Claude's too).
        digestStored: r.readDigest,
      })
    }

    // 3. Timers (unref'd so they never keep a dying process alive).
    tailTimer = setInterval(tickNow, TAIL_INTERVAL_MS)
    ;(tailTimer as { unref?: () => void }).unref?.()
    healthTimer = setInterval(healthNow, HEALTH_INTERVAL_MS)
    ;(healthTimer as { unref?: () => void }).unref?.()

    post({ type: 'ready' })
  }

  /**
   * R-003: clean-shutdown finalization. Called ONLY from the 'shutdown' message
   * handler (a genuine app quit), NOT from stop() — a worker-only restart kills
   * the process WITHOUT a shutdown handshake, so those open runs must stay
   * 'running' to be reopened by the next open(). Here we close every still-open
   * run as 'exited' and final-drain + retire its tails, so PTY exits whose
   * run-end the async before-quit ordering never delivered don't leave
   * transcripts 'tailing' (which closeDanglingRuns→reopenRun would resurrect and
   * double-tail on every subsequent boot).
   */
  function finalizeOpenRunsForShutdown(): void {
    if (!db) return
    try {
      for (const runId of db.closeAllOpenRuns(Date.now(), 'exited')) {
        stopTailsForRun(runId, 'complete')
      }
    } catch {
      /* best-effort — never block shutdown */
    }
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
        // The Memory page's rail for a Claude memory project (P3.12): Claude
        // runs only, though a Codex session may share the folder.
        rows = db!.sessionActivity()
          .filter((r) => r.provider === 'claude' && r.projectCwd !== null && mangleCwdToProjectDir(r.projectCwd) === projectDir)
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
      case 'session-conversation': {
        // #480: durable session -> conversation lookup for restart resume.
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
        const res = sessionId ? db!.getSessionConversation(sessionId) : null
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
        // R-003: a genuine app quit (distinct from a worker-only kill, which
        // never sends 'shutdown') — finalize live runs BEFORE closing the DB so
        // they aren't left 'tailing' and resurrected next boot.
        finalizeOpenRunsForShutdown()
        stop()
        // Let the process exit naturally. The supervisor posts 'shutdown' and
        // kills WITHOUT awaiting, so this message can be dropped on a fast
        // quit — benign: boot-time closeDanglingRuns + the run-start retire
        // heal any runs left open (status shows 'crashed' instead of 'exited'
        // until then).
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
        // Authoritative run-start: a prior run for this sessionId that never got
        // a run-end (the in-session Restart / Switch-account race where the
        // respawn IPC beat the old PTY's async exit — R-002 — OR a boot-
        // resurrected orphan whose sessionToRun entry was intentionally not
        // repopulated — R-003) must be retired BEFORE the new run opens, or the
        // old transcript stays 'tailing' and the same file is ingested twice.
        // Look the prior run up in the in-memory map first (live restart), then
        // fall back to the DB (resurrected orphan). closeRun targets the latest
        // open run for the session, which is exactly this prior run (the new run
        // is not inserted yet).
        const priorRunId = sessionToRun.get(msg.meta.sessionId) ?? db.getOpenRunId(msg.meta.sessionId)
        if (priorRunId !== undefined && priorRunId !== null) {
          stopTailsForRun(priorRunId, 'complete')
          db.closeRun(msg.meta.sessionId, msg.meta.startedAt, 'exited')
          sessionToRun.delete(msg.meta.sessionId)
        }
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

      case 'run-rename':
        db.renameRun(msg.sessionId, msg.configLabel)
        return

      case 'transcript-bind': {
        const runId = sessionToRun.get(msg.sessionId)
        if (runId === undefined) {
          log('warn', `[bind] dropped transcript-bind for unknown session ${msg.sessionId}`)
          return
        }
        // P3.12: a Codex rollout is tailed with the Codex normalizer; any
        // other value is Claude's format, as before.
        const codex = msg.sourceFormat === 'codex-rollout'
        const identity = codex && typeof msg.sourceIdentity === 'string' && msg.sourceIdentity ? msg.sourceIdentity : undefined
        // P3.12 round 2 (W6): a Codex rollout is read only as the file its
        // watcher claimed; without that file's identity nothing is bound.
        if (codex && !identity) {
          log('warn', `[bind] a Codex rollout without its claimed identity is not indexed: ${msg.path}`)
          return
        }
        const bound = db.bindTranscript(runId, msg.path, {
          confidence: msg.confidence,
          sourceVersion: msg.sourceVersion,
          parserVersion: codex ? CODEX_PARSER_VERSION : PARSER_VERSION,
          sourceFormat: codex ? 'codex-rollout' : 'claude-jsonl',
          ...(identity ? { sourceIdentity: identity } : {}),
        })
        let cursor = bound.cursor
        // P3.12 round 1 (V2): where a new binding of a Codex rollout starts;
        // P3.16 (M1): a Claude transcript's too.
        let digest: Hash | undefined
        let digestStored: string | null = null
        // A rotation within a run: a new transcript (e.g. /clear), or (round 1,
        // Q2) going back to one the run held before (A, B, A), or another file
        // now at a Codex rollout's path. Retire the other tails FIRST (final
        // drain) so the divider and the tail's normalizer allocate idx strictly
        // after everything already ingested; two live normalizers on one run
        // would otherwise collide on idx.
        const backToEarlier = !bound.isNew && (bound.status === 'complete' || bound.status === 'failed' || bound.identityChanged)
        if (bound.isNew) {
          const start = continuationStart(runId, msg.sessionId, msg.path, codex ? 'codex-rollout' : 'claude-jsonl', identity)
          if (start.cursor > 0) {
            db.advanceCursor(bound.transcriptId, start.cursor, start.digest ? start.digest.copy().digest('hex') : null)
            cursor = start.cursor
          }
          digest = start.digest
        } else {
          // A re-bind that (re)starts the tail goes on from its cursor,
          // vouching for what it read (checked when it next reads).
          digestStored = bound.readDigest
        }
        const rotation = (bound.isNew && bound.ord > 0) || backToEarlier
        if (rotation) {
          stopTailsForRun(runId, 'complete', bound.transcriptId)
          if (backToEarlier) tails.delete(bound.transcriptId)
        }
        if (rotation) {
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
            cursor,
            sourceFormat: bound.sourceFormat,
            identity: identity ?? null,
            ...(digest ? { digest } : {}),
            digestStored,
          })
        }
        return
      }

      case 'not-indexed-windows': {
        // P3.12 (Y1): from main; each listed conversation's windows, whole.
        if (msg.replace === true) { notIndexedWindows.clear(); codexFolderKeys.clear() }
        const conversations = msg.conversations && typeof msg.conversations === 'object' ? msg.conversations : {}
        for (const [key, list] of Object.entries(conversations)) {
          if (!Array.isArray(list)) continue
          const kept = list.filter((w): w is [number, number | null] => Array.isArray(w) && typeof w[0] === 'number' && Number.isFinite(w[0]) && (w[1] === null || (typeof w[1] === 'number' && Number.isFinite(w[1]))))
          notIndexedWindows.set(key, kept.map((w) => [w[0], w[1]]))
          if (key.startsWith(CODEX_FOLDER_KEY_PREFIX)) codexFolderKeys.add(key)
        }
        if (typeof msg.before === 'number' && Number.isFinite(msg.before)) notIndexedBefore = notIndexedBefore === null ? msg.before : Math.max(notIndexedBefore, msg.before)
        return
      }

      case 'transcript-unbind': {
        // P3.12: the session let this transcript go (a Codex claim released).
        // Final-drain it, mark it complete and stop tailing it; its rows stay.
        // A later bind of the same path to the same run resumes at its cursor.
        const runId = sessionToRun.get(msg.sessionId)
        if (runId === undefined) return
        const found = db.findTranscript(runId, msg.path)
        if (!found) return
        const tail = tails.get(found.transcriptId)
        if (tail) {
          try {
            drainTail(tail)
          } catch {
            /* best-effort final drain */
          }
          tails.delete(found.transcriptId)
        }
        db.setTranscriptStatus(found.transcriptId, 'complete')
        return
      }

      case 'session-conversation-upsert':
        // #480: durable, run-independent session -> conversation record. Does NOT
        // require an open run (unlike transcript-bind), so it survives even when
        // the run row is missing — it is keyed by sessionId, not runId.
        db.upsertSessionConversation({
          sessionId: msg.sessionId,
          uuid: msg.uuid,
          path: msg.path,
          updatedAt: msg.updatedAt,
        })
        return

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
