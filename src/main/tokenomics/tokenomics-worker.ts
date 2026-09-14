import * as nodeFs from 'fs'
import * as path from 'path'
import { openTkDb, type TkDb, type TkFileCursor } from './tk-db'
import { parseClaudeUsageLine, extractCwdFromLine, codexEventsFromRollout, type CodexRolloutSeed } from './tk-parse'
import { findConfigForCwd, isJunkCwd } from './tk-config-match'
import type { TkConfigDim, TkEvent, TkPricing } from './tk-types'
import type { ToTkWorker, FromTkWorker, TkWorkerHostTransport } from './tk-worker-transport'

export interface TkWorkerDeps { fs?: typeof nodeFs; watchDebounceMs?: number; configs?: TkConfigDim[]; maxTickBytes?: number }
export interface TokenomicsWorker { tickNow(): void; healthNow(): void; stop(): void }

const READ_BUF = 256 * 1024
/**
 * How much of a Codex rollout's head to scan for its identity lines.
 *
 * 64 KB was too small twice over on a real tree: `session_meta` alone reached
 * 47 KB, and the first `turn_context` (the line that names the model, and so
 * decides what every turn costs) was measured at 36-116 KB into the file, past
 * the window in 12 of 14 sampled rollouts. This is read at most once per file -
 * the identity is persisted on the cursor afterwards - so the window can afford
 * to be generous.
 */
const CODEX_HEAD_BYTES = 1024 * 1024
const CODEX_MARK_TOKEN = Buffer.from('"token_count"')
const CODEX_MARK_META = Buffer.from('"session_meta"')
const CODEX_MARK_TURN = Buffer.from('"turn_context"')
/**
 * The longest line the Codex parser can possibly want. Everything past this is
 * tool output, and skipping it undecoded is the whole point of the pre-filter.
 *
 * This was 64 KB, which was not a safety margin at all: a rollout's
 * `session_meta` line carries the instruction blob AND the serialised tool
 * schemas, so it grows with the user's AGENTS.md and with every MCP server
 * they add. Measured across a real 320-rollout tree it reached 47 KB — 72 % of
 * that bound, and climbing every month. Crossing it did not degrade
 * gracefully: without `session_meta` the parser has no session id and returns
 * NOTHING, while the cursor still advanced, so the rollout's entire spend
 * disappeared silently and permanently. 1 MB is ~21x the observed maximum; a
 * `token_count` line is under 1 KB.
 */
const CODEX_MAX_LINE = 1024 * 1024
const MAX_TICK_BYTES = 16 * 1024 * 1024
/** Codex rollouts get a bigger tick: nearly every byte is skipped by the
 *  byte-level pre-filter without being decoded, so a tick is I/O, not CPU.
 *  16 MB on a 2.5 GB rollout meant ~160 sweeps to finish one file; 64 MB is
 *  ~40, and a sweep over an 80 GB tree stays under a minute. */
const CODEX_TICK_BYTES = 64 * 1024 * 1024
const YIELD_EVERY = 16 // files between event-loop yields during a sweep

/** What one bounded pass over a file's byte range saw. */
export interface StreamResult {
  /** Byte position reached (== `to`, or less on a short read). */
  pos: number
  /** Bytes of a trailing line that never got its newline in this range. */
  pendingLen: number
  /** That trailing run is already too long to be a line anyone wants, so its
   *  bytes were counted but never retained — the caller can safely skip it
   *  rather than re-reading it on every future sweep. */
  pendingDropped: boolean
}

/**
 * Read `[from, to)` from an open fd and hand back COMPLETE lines, each with the
 * exact number of bytes it consumed (its own length plus its newline) so the
 * caller's cursor stays byte-exact.
 *
 * Why this exists rather than the obvious `Buffer.concat([carry, chunk])` per
 * read: that rebuilds the entire accumulated run on EVERY 256 KB read, which is
 * quadratic in the length of a single line. Real Codex rollouts hold tool-output
 * lines of 34 MB, and at a 64 MB tick that measured 5.5 s of pure memcpy per
 * line — freezing this worker's event loop, and in aggregate accounting for
 * essentially all of a sweep's wall clock. Here every byte is scanned once and
 * copied at most once, and only for lines short enough to want.
 *
 * A run longer than `maxLineBytes` cannot be wanted by any caller, so its bytes
 * are counted but never retained. Peak memory is therefore about
 * READ_BUF + maxLineBytes however long the file's longest line is.
 *
 * NOTE: the Buffer handed to `onLine` may be a view into a reused read buffer.
 * Decode or test it inside the callback; do not retain it.
 */
export function streamLines(
  fsx: typeof nodeFs,
  fd: number,
  from: number,
  to: number,
  maxLineBytes: number,
  onLine: (line: Buffer | null, byteLen: number) => void,
): StreamResult {
  const buf = Buffer.alloc(READ_BUF)
  let pos = from
  let parts: Buffer[] = []  // pieces of the line currently being assembled
  let runLen = 0            // its length so far, INCLUDING any dropped pieces
  let dropped = false       // run passed maxLineBytes -> stop retaining it
  while (pos < to) {
    const n = fsx.readSync(fd, buf, 0, Math.min(READ_BUF, to - pos), pos)
    if (n <= 0) break
    pos += n
    let ls = 0
    for (;;) {
      const nl = buf.indexOf(0x0a, ls)
      if (nl === -1 || nl >= n) break
      const seg = buf.subarray(ls, nl)
      const byteLen = runLen + seg.length + 1
      if (dropped) onLine(null, byteLen)
      else if (parts.length === 0) onLine(seg, byteLen)
      else { parts.push(Buffer.from(seg)); onLine(Buffer.concat(parts), byteLen) }
      parts = []; runLen = 0; dropped = false
      ls = nl + 1
    }
    const tail = n - ls
    if (tail > 0) {
      runLen += tail
      if (dropped) { /* already counting only */ }
      else if (runLen > maxLineBytes) { parts = []; dropped = true }
      else parts.push(Buffer.from(buf.subarray(ls, n)))
    }
  }
  return { pos, pendingLen: runLen, pendingDropped: dropped }
}

/**
 * Nothing new to look at: the file has not changed since the last tick, and we
 * already scanned to its end.
 *
 * Asking this of `lastOffset` instead of `scannedTo` is wrong for any file
 * whose final line has no newline — the cursor legitimately parks in front of
 * that partial line, so `lastOffset < size` forever, and the file is re-read in
 * full on every five-second sweep for the life of the process.
 */
function unchangedAndFullyScanned(cursor: TkFileCursor | null, st: nodeFs.Stats, offset: number): boolean {
  if (!cursor) return false
  if (st.size !== cursor.size || st.mtimeMs !== cursor.mtime) return false
  if (offset !== cursor.lastOffset) return false // we reset the offset (truncation) -> re-read
  return (cursor.scannedTo ?? cursor.lastOffset) >= st.size
}

export function createTokenomicsWorker(host: TkWorkerHostTransport, deps: TkWorkerDeps = {}): TokenomicsWorker {
  const fs = deps.fs ?? nodeFs
  const maxTickBytes = deps.maxTickBytes ?? MAX_TICK_BYTES
  const watchDebounceMs = deps.watchDebounceMs ?? 750
  let db: TkDb | undefined
  let pricing: Record<string, TkPricing> = {}
  let priceKeys: string[] = []
  let configs: TkConfigDim[] = deps.configs ?? []
  let claudeDir = ''
  let codexDir = ''
  let sweeping = false
  /**
   * Did anything in THIS sweep leave work behind — a file not read to its end,
   * or one that could not be read at all?
   *
   * Deliberately in memory and per-sweep, rather than a query over the cursor
   * table. `tk_files` is never pruned, so it accumulates rows for files that no
   * longer exist — 92% of the rows in a real 221 MB database, nine of them
   * parked mid-file. Asking the TABLE "is anything unscanned" lets a rollout
   * deleted years ago veto completion forever, which is the same "Indexing
   * usage data" wedge this code exists to remove, only now persisted. Asking
   * the SWEEP counts only files that still exist and were actually visited.
   */
  let sweepPending = false
  /**
   * Files this sweep could not open or read at all.
   *
   * Counted SEPARATELY from `sweepPending`, and deliberately not allowed to
   * block completion. Those are two different states: "there are more bytes to
   * read, come back" is temporary and will resolve on its own, while "this file
   * cannot be read" may never resolve — and blocking on it meant a single
   * unreadable transcript left a first index unfinished for the life of the
   * install, showing a spinner with no error and no way out. Reading everything
   * that CAN be read is the honest definition of done; what could not be read
   * is reported alongside it rather than hidden behind a spinner.
   */
  let sweepFailed = 0
  /** Note how far a file was read, so the sweep knows whether work remains. */
  const noteScanned = (scannedTo: number, size: number): void => { if (scannedTo < size) sweepPending = true }
  let firstSweepDone = false
  let lastProgress = { filesDone: 0, filesTotal: 0, eventsIngested: 0 }
  const watchers: Array<{ close(): void }> = []
  let watchTimer: ReturnType<typeof setTimeout> | null = null
  let tailTimer: ReturnType<typeof setInterval> | null = null

  const post = (m: FromTkWorker): void => host.post(m)
  const logw = (level: 'info' | 'warn' | 'error', message: string): void => post({ type: 'log', entry: { level, message } })
  const setPricing = (p: Record<string, TkPricing>): void => { pricing = p; priceKeys = Object.keys(p) }

  function enumerateClaude(): string[] {
    // Recurse the whole tree (spec: `~/.claude/projects/**`). Session transcripts
    // live one level deep (`<proj>/<sid>.jsonl`) but subagent/sidechain transcripts
    // are nested (`<proj>/<sid>/subagents/agent-*.jsonl`) and carry real billed
    // usage — a one-level scan silently undercounts cost. Skip symlinks/junctions
    // so account-isolation reparse points can't introduce traversal cycles.
    const out: string[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 12) return
      let entries: nodeFs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, depth + 1)
        else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
      }
    }
    try { if (fs.existsSync(claudeDir)) walk(claudeDir, 0) }
    catch (err) { logw('warn', `enumerateClaude failed: ${String(err)}`) }
    return out
  }

  function enumerateCodex(): string[] {
    const out: string[] = []
    // Same guards as enumerateClaude, which this had been missing: `statSync`
    // follows links, so a reparse point or symlink inside the tree could yield
    // the SAME rollout under two paths. Two paths to one rollout means two
    // independent cursors over one session's ordinals, and that double-counts
    // the user's spend.
    const walk = (dir: string, depth: number): void => {
      if (depth > 12) return
      let entries: nodeFs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) { walk(full, depth + 1); continue }
        if (!e.isFile() || !e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue
        let st: nodeFs.Stats
        try { st = fs.statSync(full) } catch { continue }
        if (st.size > 0) out.push(full)
      }
    }
    try { if (fs.existsSync(codexDir)) walk(codexDir, 0) } catch (err) { logw('warn', `enumerateCodex failed: ${String(err)}`) }
    return out
  }

  function resolveConfigId(cwd: string): string | null {
    if (!cwd || isJunkCwd(cwd)) return null
    const c = findConfigForCwd(cwd, configs)
    return c ? c.configId : null
  }

  function ingestClaudeFile(file: string): number {
    let st: nodeFs.Stats
    try { st = fs.statSync(file) } catch { return 0 }
    const cursor = db!.getFileCursor(file)
    let offset = cursor ? cursor.lastOffset : 0
    if (cursor && st.size < cursor.lastOffset) offset = 0 // truncated/rotated -> re-read
    if (unchangedAndFullyScanned(cursor, st, offset)) return 0
    if (st.size <= offset) { db!.setFileCursor({ path: file, size: st.size, mtime: st.mtimeMs, lastOffset: offset, lastIngestedAt: Date.now(), scannedTo: st.size }); return 0 }

    const end = Math.min(st.size, offset + maxTickBytes)
    let fd: number
    // A file we could not read is work still outstanding, not work done. It
    // writes no cursor row, so nothing else can notice it — and an index that
    // declares itself complete while a file's spend is missing is worse than
    // one that admits it is still going.
    try { fd = fs.openSync(file, 'r') } catch (err) { sweepFailed++; logw('warn', `open failed for ${file}: ${String(err)}`); return 0 }
    let inserted = 0
    let fileCwd = ''
    try {
      let batch: Array<TkEvent & { configId?: string | null }> = []
      let consumed = offset
      const flush = (): void => { if (batch.length) { inserted += db!.insertEvents(batch); batch = [] } }
      let res: StreamResult
      try {
        // A line that cannot fit in one tick can never be assembled, so it is
        // capped rather than carried: without that the cursor parks in front of
        // it and the same bytes are re-read on every sweep, forever.
        res = streamLines(fs, fd, offset, end, maxTickBytes, (lb, byteLen) => {
          consumed += byteLen
          if (!lb || !lb.length) return
          const trimmed = lb[lb.length - 1] === 0x0d ? lb.subarray(0, lb.length - 1) : lb
          const line = trimmed.toString('utf8')
          if (!line) return
          const lineCwd = extractCwdFromLine(line)
          if (lineCwd) fileCwd = lineCwd
          const ev = parseClaudeUsageLine(line, priceKeys)
          if (!ev) return
          const cwd = ev.cwd || fileCwd || db!.getSessionCwd(ev.sessionId) || ''
          batch.push({ ...ev, cwd, configId: resolveConfigId(cwd) })
          if (batch.length >= 500) flush()
        })
      } catch (err) {
        // Per-FILE containment. Letting this escape aborts the whole sweep, so
        // one locked or flaky transcript stops every later file from being read
        // and leaves the index reporting itself incomplete forever.
        sweepFailed++
        logw('warn', `read failed for ${file}: ${String(err)}`)
        flush()
        return inserted
      }
      // As on the Codex path: a run at least a whole tick long can never be
      // assembled, so skip it. Merely reaching the end of the file does not
      // qualify — that is a file being appended to, and its partial last line
      // must survive until the writer finishes it.
      if (res.pendingDropped) consumed += res.pendingLen
      else if (res.pendingLen > 0 && consumed === offset && res.pos - offset >= maxTickBytes) consumed = res.pos
      flush()
      noteScanned(res.pos, st.size)
      db!.setFileCursor({ path: file, size: st.size, mtime: st.mtimeMs, lastOffset: consumed, lastIngestedAt: Date.now(), scannedTo: res.pos })
    } finally { try { fs.closeSync(fd) } catch { /* ignore */ } }
    return inserted
  }

  /**
   * Codex rollouts are STREAMED, exactly like Claude transcripts, and for the
   * same reason the Claude path never read a whole file: they can be enormous.
   * A real ~/.codex/sessions held 80 GB across 320 files, several of them
   * 1.8-2.5 GB each. The old `readFileSync(file, 'utf8')` on those either took
   * tens of seconds and hundreds of MB per file, or threw Node's hard string
   * ceiling ("Cannot create a string longer than 0x1fffffe8 characters") -
   * which the catch swallowed WITHOUT writing a cursor, so every sweep re-read
   * the same unreadable file and never got past the Codex tail. On the user's
   * machine that showed as Tokenomics stuck at "Indexing 1700/1997" for hours,
   * with a database that had in fact been complete since July.
   *
   * The parser only wants three event types (session_meta, turn_context,
   * token_count) - a tiny slice of a rollout's bytes - and it is line-oriented,
   * so it can be fed a chunk at a time. Each tick reads at most one tick budget;
   * the cursor advances to the last complete line consumed and the next sweep
   * carries on.
   *
   * The ordinal behind the dedup key (`x:<session>:<n>`) is the position of a
   * token_count line within THIS FILE, and its base is stored on the file's own
   * cursor, in the SAME transaction as the rows. It was previously derived from
   * a live count of the session's stored rows, which is not the same number:
   * replay a byte range (the worker is hard-killed on app quit, mid-sweep) and
   * that count has moved, so the same turns are re-inserted under fresh keys and
   * the user's spend inflates permanently.
   *
   * The rollout's identity (session id, cwd, model) is likewise carried on the
   * cursor rather than re-derived from a bounded read of the file's head. The
   * head read stays as the way to LEARN it, but a tick that cannot find it there
   * used to produce zero events while still advancing the cursor - silently
   * losing every turn in that range - and to price whatever it did produce as
   * 'unknown', which matches no pricing row and therefore costs nothing.
   */
  function ingestCodexFile(file: string): number {
    let st: nodeFs.Stats
    try { st = fs.statSync(file) } catch { return 0 }
    const cursor = db!.getFileCursor(file)
    let offset = cursor ? cursor.lastOffset : 0
    let turnBase = cursor?.codexTurns ?? 0
    let seed: CodexRolloutSeed = { sessionId: cursor?.codexSessionId || undefined, cwd: cursor?.codexCwd || undefined, model: cursor?.codexModel || undefined }
    if (cursor && st.size < cursor.lastOffset) {
      // Truncated or rotated: the file we counted is not this one. Re-read from
      // the top with the ordinal base back at zero, so the stored rows dedup
      // against their own keys instead of being re-inserted beside them.
      offset = 0
      turnBase = 0
      seed = { sessionId: undefined, cwd: undefined, model: undefined }
    }
    if (unchangedAndFullyScanned(cursor, st, offset)) return 0
    if (st.size <= offset) {
      db!.setFileCursor({ path: file, size: st.size, mtime: st.mtimeMs, lastOffset: offset, lastIngestedAt: Date.now(), scannedTo: st.size, codexSessionId: seed.sessionId ?? '', codexModel: seed.model ?? '', codexCwd: seed.cwd ?? '', codexTurns: turnBase })
      return 0
    }

    // `!== undefined`, not truthiness: a caller asking for a 0-byte tick meant
    // it, and silently handing back 64 MB instead is not a kindness.
    const tickBytes = deps.maxTickBytes !== undefined ? maxTickBytes : CODEX_TICK_BYTES
    const end = Math.min(st.size, offset + tickBytes)
    let fd: number
    try { fd = fs.openSync(file, 'r') } catch (err) { sweepFailed++; logw('warn', `open failed for ${file}: ${String(err)}`); return 0 }
    let inserted = 0
    try {
      let consumed = offset
      // The rollout header sits at the top of the file. On a resumed read we
      // start past it, so re-read the head for those lines - bounded and cheap.
      // Unlike before, this is a fallback rather than the only source: what it
      // finds is persisted on the cursor, so a head that does not hold the
      // identity is no longer silently fatal to the whole tick.
      const head = offset > 0 && !seed.sessionId ? codexHeadLines(fd) : null
      const kept: string[] = []
      let res: StreamResult
      try {
        res = streamLines(fs, fd, offset, end, CODEX_MAX_LINE, (lb, byteLen) => {
          consumed += byteLen
          // Cheap pre-filter: only lines that can carry what the parser wants
          // are decoded at all. A tool-output line of a few MB is skipped by a
          // byte scan instead of a UTF-8 decode plus JSON.parse. `null` is a
          // line already rejected for length by the reader.
          if (!lb || !lb.length || !codexLineOfInterest(lb)) return
          kept.push(lb.toString('utf8'))
        })
      } catch (err) {
        // Per-FILE containment, as the pre-streaming code had. Letting this
        // escape aborts the entire sweep: every later rollout goes unread, the
        // first index never reports complete, and the five-second retry hits the
        // same file forever - the exact "Indexing 1700/1997" wedge this ingester
        // was written to remove, reached through a different door.
        sweepFailed++
        logw('warn', `read failed for ${file}: ${String(err)}`)
        return 0
      }
      noteScanned(res.pos, st.size)
      // Skip past a run that can never become a line we want, rather than
      // re-reading it forever. Two ways to know that: it passed the largest line
      // any caller wants, or a WHOLE tick's worth of bytes went by without one
      // complete line, so the run is at least a tick long.
      //
      // The second test is on bytes actually read, NOT on reaching the end of
      // the file. A file that simply ends mid-line is the normal shape of one
      // being appended to right now, and its partial last line has to be left
      // alone until the writer finishes it. What stops THAT from being re-read
      // on every sweep is `scannedTo`, not skipping it.
      if (res.pendingDropped) consumed += res.pendingLen
      else if (res.pendingLen > 0 && consumed === offset && res.pos - offset >= tickBytes) consumed = res.pos

      let nextSeed = seed
      if (kept.length) {
        const headLines = head ? head.split('\n') : []
        const text = (head ? head + '\n' : '') + kept.join('\n')
        // Learn the identity from ANY line that carries it, and carry it forward
        // whether or not this tick also found turns. A tick holding only the
        // header used to teach the next tick nothing, so the identity had to be
        // rediscovered from the file's head every time — the thing that silently
        // produced no events when the head did not hold it.
        nextSeed = codexIdentityFrom([...headLines, ...kept], seed)
        // Parse with the identity carried IN, not the one just derived. What
        // `codexIdentityFrom` returns is the LAST model named anywhere in this
        // slice; seeding the parse with it stamps that model onto every turn
        // before the slice's first `turn_context` — which on a resumed tick is
        // the leading turns, and silently reprices them. The cursor's own seed
        // is the model actually in effect where this slice begins.
        const probe = codexEventsFromRollout(text, priceKeys, 0, seed)
        if (probe.length) {
          const sessionId = probe[0].sessionId
          const last = probe[probe.length - 1]
          // Persist what the identity scan found — it also sees a trailing
          // `turn_context` that no turn in this slice followed.
          nextSeed = {
            sessionId: nextSeed.sessionId || sessionId,
            cwd: nextSeed.cwd || last.cwd,
            model: nextSeed.model || (last.model && last.model !== 'unknown' ? last.model : undefined),
          }
          // A fresh read from the top re-derives ordinals the stored rows
          // already own, so their own keys dedup them; a resumed read holds only
          // turns after the cursor, so they continue from the file's base.
          const keyed = (offset === 0
            ? probe.map((ev, i) => ({ ...ev, dedupKey: `x:${sessionId}:${i}` }))
            : probe.map((ev, i) => ({ ...ev, dedupKey: `x:${sessionId}:${turnBase + i}` })))
            .map((ev) => ({ ...ev, configId: resolveConfigId(ev.cwd) }))
          // A turn with no usable timestamp cannot be stored: the column is NOT
          // NULL, and `INSERT OR IGNORE` reports the rejection as changes === 0
          // — identical to a dedup hit. That is the mechanism that makes a LOST
          // turn look exactly like an already-counted one, so drop it here and
          // say so. Keys are already assigned, so the survivors keep theirs.
          const fresh = keyed.filter((ev) => Number.isFinite(ev.ts))
          if (fresh.length !== keyed.length) {
            logw('warn', `codex rollout ${file}: dropped ${keyed.length - fresh.length} turn(s) with an unusable timestamp`)
          }
          turnBase = offset === 0 ? Math.max(turnBase, probe.length) : turnBase + probe.length
          inserted = db!.insertEventsWithCursor(fresh, { path: file, size: st.size, mtime: st.mtimeMs, lastOffset: consumed, lastIngestedAt: Date.now(), scannedTo: res.pos, codexSessionId: nextSeed.sessionId ?? '', codexModel: nextSeed.model ?? '', codexCwd: nextSeed.cwd ?? '', codexTurns: turnBase })
          return inserted
        }
        if (offset > 0 && !nextSeed.sessionId) {
          // Lines we wanted, but nothing to attribute them to. Advancing the
          // cursor here is how a rollout's whole spend used to vanish without a
          // trace, so say so.
          logw('warn', `codex rollout ${file}: no session identity for ${kept.length} line(s) at offset ${offset}`)
        }
      }
      db!.setFileCursor({ path: file, size: st.size, mtime: st.mtimeMs, lastOffset: consumed, lastIngestedAt: Date.now(), scannedTo: res.pos, codexSessionId: nextSeed.sessionId ?? '', codexModel: nextSeed.model ?? '', codexCwd: nextSeed.cwd ?? '', codexTurns: turnBase })
    } finally { try { fs.closeSync(fd) } catch { /* ignore */ } }
    return inserted
  }

  /**
   * What a rollout's header lines say about it, learned from whatever lines are
   * to hand. Kept separate from event parsing on purpose: a tick can hold the
   * header and no turns at all, and it still has to teach the next tick who
   * this file belongs to and what model it is billing.
   */
  function codexIdentityFrom(lines: string[], seed: CodexRolloutSeed): CodexRolloutSeed {
    let { sessionId, cwd, model } = seed
    // #307: first session_meta is the file's identity; a subagent rollout's
    // SECOND session_meta names its parent and must not steal the id (that
    // collapsed subagent turns onto the parent and dropped ~half of them). The
    // seed IS the header a prior read already learned, so a set seed id locks it.
    // Model still tracks the last one named (turn_context updates continue).
    let idLocked = !!sessionId
    for (const line of lines) {
      if (!line) continue
      let evt: { type?: string; payload?: Record<string, unknown> }
      try { evt = JSON.parse(line) } catch { continue }
      const p = evt?.payload ?? {}
      if (evt?.type === 'session_meta') {
        if (idLocked) continue
        if (p.id) { sessionId = String(p.id); idLocked = true }
        if (p.cwd) cwd = String(p.cwd)
        if (p.model) model = String(p.model)
      } else if (evt?.type === 'turn_context' && p.model) model = String(p.model)
    }
    return { sessionId, cwd, model }
  }

  /** Byte-level "could this line matter" test, run before any decode. */
  function codexLineOfInterest(lb: Buffer): boolean {
    // The giant lines are tool output. The bound has to clear the largest line
    // we actually WANT, which is `session_meta` - it carries the instruction
    // blob and the serialised tool schemas, so it grows with the user's setup.
    if (lb.length > CODEX_MAX_LINE) return false
    return lb.includes(CODEX_MARK_TOKEN) || lb.includes(CODEX_MARK_META) || lb.includes(CODEX_MARK_TURN)
  }

  /**
   * The identity lines of a rollout, read from the top of an open file. Used
   * only to LEARN the identity once; it is then carried on the file's cursor.
   * Returns them joined, or null when the head holds none.
   *
   * The window has to clear a whole `session_meta` line plus the first
   * `turn_context`, and `session_meta` was measured at 47 KB on a real tree and
   * growing - a 64 KB window left no margin, and running out of it produced
   * zero events rather than a degraded result.
   */
  function codexHeadLines(fd: number): string | null {
    const buf = Buffer.alloc(CODEX_HEAD_BYTES)
    let n = 0
    try { n = fs.readSync(fd, buf, 0, CODEX_HEAD_BYTES, 0) } catch { return null }
    if (n <= 0) return null
    // Look for the two DISTINCT things the head can tell us, not simply for the
    // first few matching lines: taking "the first 4 markers" meant a rollout
    // whose turn_context lines precede its session_meta yielded four models and
    // no session id at all - and without a session id the parser returns
    // nothing, so the whole tick was discarded.
    const lines: string[] = []
    let haveMeta = false
    let turns = 0
    let ls = 0
    for (;;) {
      const nl = buf.indexOf(0x0a, ls)
      if (nl === -1 || nl >= n) break
      const lb = buf.subarray(ls, nl)
      ls = nl + 1
      if (!haveMeta && lb.includes(CODEX_MARK_META)) { lines.push(lb.toString('utf8')); haveMeta = true }
      else if (turns < 3 && lb.includes(CODEX_MARK_TURN)) { lines.push(lb.toString('utf8')); turns++ }
      if (haveMeta && turns > 0) break
    }
    return lines.length ? lines.join(String.fromCharCode(10)) : null
  }

  async function ingestAll(phase: 'initial' | 'incremental'): Promise<void> {
    if (!db || sweeping) return
    sweeping = true
    sweepPending = false
    sweepFailed = 0
    try {
      const claude = enumerateClaude()
      const codex = enumerateCodex()
      const total = claude.length + codex.length
      let done = 0
      let events = 0
      // Yield to the worker event loop periodically so pending queries (summary /
      // index-status) are answered DURING a large first index instead of stalling
      // behind a synchronous multi-thousand-file sweep.
      const tick = (): void => {
        if (done % 50 === 0) { lastProgress = { filesDone: done, filesTotal: total, eventsIngested: events }; post({ type: 'index-progress', filesDone: done, filesTotal: total, eventsIngested: events, phase }) }
      }
      // After each yield, bail if stop() closed the db while we were suspended
      // (the resumed continuation would otherwise deref a now-undefined db).
      for (const f of claude) { events += ingestClaudeFile(f); done++; tick(); if (done % YIELD_EVERY === 0) { await new Promise<void>((r) => setImmediate(r)); if (!db) return } }
      for (const f of codex) { events += ingestCodexFile(f); done++; tick(); if (done % YIELD_EVERY === 0) { await new Promise<void>((r) => setImmediate(r)); if (!db) return } }
      if (!db) return
      lastProgress = { filesDone: done, filesTotal: total, eventsIngested: events }
      post({ type: 'index-progress', filesDone: done, filesTotal: total, eventsIngested: events, phase })
      db.setMeta('lastIndexAt', String(Date.now()))
      // "Complete" has to mean every tracked file has been read to its end, not
      // merely that one pass over the file LIST finished. A per-tick byte budget
      // means a multi-GB rollout needs tens of sweeps, and claiming completion
      // after the first one puts a confidently wrong spend figure in front of
      // the user with no indication it is still climbing.
      //
      // It is also no longer tied to the 'initial' phase: that phase runs once
      // per process, so a single failed first sweep left the flag unreachable
      // for the life of the process however many healthy sweeps followed.
      //
      // Files that could not be READ deliberately do not hold this back. A file
      // that is unreadable now may be unreadable forever, and gating on it left
      // a first index permanently unfinished — a spinner, no error, no way out.
      // "Everything we can read has been read" is the honest bar; `filesFailed`
      // rides alongside so the count that is missing can be shown rather than
      // hidden.
      const drained = !sweepPending
      if (drained && !firstSweepDone) {
        firstSweepDone = true
        db.setMeta('firstIndexComplete', '1')
        post({ type: 'index-complete', firstIndex: true, drained, filesFailed: sweepFailed, eventsTotal: db.eventCount() })
      } else {
        post({ type: 'index-complete', firstIndex: false, drained, filesFailed: sweepFailed, eventsTotal: db.eventCount() })
      }
    } catch (err) { logw('error', `ingestAll failed: ${String(err)}`) }
    finally { sweeping = false }
  }

  function indexStatus(): unknown {
    const lastAt = db!.getMeta('lastIndexAt')
    return {
      firstIndexComplete: db!.getMeta('firstIndexComplete') === '1',
      indexing: sweeping,
      filesDone: lastProgress.filesDone,
      filesTotal: lastProgress.filesTotal,
      eventsTotal: db!.eventCount(),
      filesFailed: sweepFailed,
      lastIndexAt: lastAt ? Number(lastAt) : null,
    }
  }

  function handleQuery(id: number, kind: string, args: Record<string, unknown>): void {
    try {
      let rows: unknown[]
      switch (kind) {
        case 'summary': rows = [db!.querySummary(pricing, args as any)]; break
        case 'sessions': rows = [db!.querySessions(pricing, args as any)]; break
        case 'session-detail': rows = [db!.querySessionDetail(pricing, String((args as any).sessionId))]; break
        case 'index-status': rows = [indexStatus()]; break
        default: post({ type: 'error', id, message: `unknown query kind: ${kind}` }); return
      }
      post({ type: 'query-result', id, rows })
    } catch (err) { post({ type: 'error', id, message: `query ${kind} failed: ${err instanceof Error ? err.message : String(err)}` }) }
  }

  function scheduleIncremental(): void {
    if (watchTimer) clearTimeout(watchTimer)
    watchTimer = setTimeout(() => { watchTimer = null; void ingestAll('incremental') }, watchDebounceMs)
    ;(watchTimer as unknown as { unref?: () => void }).unref?.()
  }

  function startWatching(): void {
    for (const dir of [claudeDir, codexDir]) {
      try {
        if (!fs.existsSync(dir)) continue
        const wch = fs.watch(dir, { recursive: true }, () => scheduleIncremental())
        // An FSWatcher 'error' with no listener throws -> uncaughtException -> the
        // worker dies and burns a restart toward permanent degrade. Log + close the
        // broken watcher; the 5s tailTimer sweep below keeps indexing alive.
        ;(wch as { on?: (ev: string, cb: (e: unknown) => void) => void }).on?.('error', (err) => {
          logw('warn', `fs.watch error for ${dir}; relying on periodic sweep: ${String(err)}`)
          try { wch.close() } catch { /* already closed */ }
        })
        watchers.push(wch)
      } catch (err) { logw('warn', `fs.watch failed for ${dir}: ${String(err)}`) }
    }
    // Safety tail: recursive watch can miss newly-created nested session files on
    // some platforms; a slow periodic incremental sweep guarantees eventual pickup.
    tailTimer = setInterval(() => { if (!sweeping) void ingestAll('incremental') }, 5000)
    ;(tailTimer as unknown as { unref?: () => void }).unref?.()
  }

  function open(msg: Extract<ToTkWorker, { type: 'open' }>): void {
    db = openTkDb(msg.dbPath)
    setPricing(msg.pricing)
    configs = msg.configs
    if (configs.length) db.upsertConfigs(configs)
    claudeDir = msg.claudeProjectsDir
    codexDir = msg.codexSessionsDir
    firstSweepDone = db.getMeta('firstIndexComplete') === '1'
    // Ready BEFORE the sweep so queries work during indexing - and it carries
    // what the DB already knows, so an index completed on a previous run reads
    // as complete now rather than after this run's sweep (or never, when the
    // sweep does not finish).
    post({ type: 'ready', firstIndexComplete: firstSweepDone, eventsTotal: db.eventCount() })
    setTimeout(() => { void ingestAll('initial') }, 0)
    startWatching()
  }

  function handle(msg: ToTkWorker): void {
    switch (msg.type) {
      case 'open': open(msg); return
      case 'shutdown': stop(); return
    }
    if (!db) { post({ type: 'error', id: msg.type === 'query' ? msg.id : undefined, message: `worker received ${msg.type} before open` }); return }
    switch (msg.type) {
      case 'set-pricing': setPricing(msg.pricing); return
      case 'set-configs': configs = msg.configs; db.upsertConfigs(configs); return
      case 'reindex': void ingestAll('incremental'); return
      case 'query': handleQuery(msg.id, msg.kind, msg.args); return
      default: { const _x: never = msg; void _x }
    }
  }

  host.onMessage((msg) => {
    const qid = msg?.type === 'query' ? msg.id : undefined
    try { handle(msg) } catch (err) {
      try { post({ type: 'error', id: qid, message: `worker handling failed: ${err instanceof Error ? err.message : String(err)}` }) } catch { /* ignore */ }
    }
  })

  function tickNow(): void { void ingestAll('incremental') }
  function healthNow(): void {
    if (!db) return
    const filesTracked = (db.raw.prepare('SELECT COUNT(*) AS n FROM tk_files').get() as { n: number }).n
    post({ type: 'health', eventsTotal: db.eventCount(), filesTracked, dbBytes: 0 })
  }
  function stop(): void {
    for (const wch of watchers) { try { wch.close() } catch { /* ignore */ } }
    watchers.length = 0
    if (watchTimer) { clearTimeout(watchTimer); watchTimer = null }
    if (tailTimer) { clearInterval(tailTimer); tailTimer = null }
    try { db?.close() } catch { /* ignore */ }
    db = undefined
  }

  return { tickNow, healthNow, stop }
}

// utilityProcess bootstrap (only defined inside a forked utilityProcess; undefined in tests)
const parentPort = (process as unknown as { parentPort?: { on(ev: 'message', h: (e: { data: unknown }) => void): void; postMessage(m: FromTkWorker): void } }).parentPort
if (parentPort) {
  const host: TkWorkerHostTransport = {
    post: (m) => parentPort.postMessage(m),
    onMessage: (h) => parentPort.on('message', (e) => h(e.data as ToTkWorker)),
  }
  createTokenomicsWorker(host)
}
