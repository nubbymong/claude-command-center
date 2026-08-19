import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { createTokenomicsWorker, streamLines } from '../../../src/main/tokenomics/tokenomics-worker'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'
import type { FromTkWorker } from '../../../src/main/tokenomics/tk-worker-transport'

// Regression tests for the defects an adversarial pass found in the Codex
// streaming ingester. Each one FAILED against the code as first written; the
// comment on each says what it is holding down.

const CODEX_PRICING = { 'gpt-5.5': { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 } }

interface RolloutOpts {
  /** Bytes of filler in the `session_meta` line. Real rollouts carry the whole
   *  instruction blob and the serialised tool schemas here — measured at 47 KB
   *  and growing on a real tree. */
  metaPad?: number
  /** Filler bytes on each tool-output line between turns. */
  padBytes?: number
  /** Bytes of tool output on ONE line, written BEFORE the `turn_context` that
   *  names the model — so the model line lands beyond any bounded read of the
   *  file's head, and only state carried on the cursor can supply it. */
  hugeLineBytes?: number
  /** Append this many bytes of tool output as a final line with NO newline —
   *  a Codex process killed mid-write. Large on purpose: the cost of getting
   *  this wrong is re-reading that tail on every sweep, forever. */
  tailBytes?: number
  sessionId?: string
}

/**
 * A rollout shaped like the real thing: `session_meta` carries NO model (0 of
 * 320 real rollouts do), so the model can only come from a `turn_context` line
 * — which is what makes model attribution across ticks worth testing.
 */
function writeRollout(dir: string, name: string, turns: number, opts: RolloutOpts = {}): string {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  const parts: string[] = []
  parts.push(JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-08-01T00:00:00Z',
    payload: { id: opts.sessionId ?? 'cx-1', cwd: 'F:\\proj', instructions: 'i'.repeat(opts.metaPad ?? 0) },
  }))
  if (opts.hugeLineBytes) {
    parts.push(JSON.stringify({ type: 'event_msg', payload: { type: 'tool_output', output: 'x'.repeat(opts.hugeLineBytes) } }))
  }
  parts.push(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }))
  const pad = 'x'.repeat(opts.padBytes ?? 0)
  for (let i = 0; i < turns; i++) {
    if (opts.padBytes) parts.push(JSON.stringify({ type: 'event_msg', payload: { type: 'tool_output', output: pad } }))
    parts.push(JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-01T00:00:0' + (i % 10) + 'Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 10 }, last_token_usage: { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 } } },
    }))
  }
  let body = parts.join('\n') + '\n'
  if (opts.tailBytes) body += JSON.stringify({ type: 'event_msg', payload: { type: 'tool_output', output: 'x'.repeat(opts.tailBytes) } })
  fs.writeFileSync(p, body)
  return p
}

describe('tokenomics codex ingest hardening', () => {
  let tmp: string
  let workers: { stop: () => void }[]
  const track = <T extends { stop: () => void }>(w: T): T => { workers.push(w); return w }
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkh-')); workers = [] })
  afterEach(() => {
    for (const w of workers) { try { w.stop() } catch { /* already stopped */ } }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const completions = (msgs: FromTkWorker[]) => msgs.filter((m) => m.type === 'index-complete') as Array<{ firstIndex: boolean; eventsTotal: number }>

  async function waitForCompletions(msgs: FromTkWorker[], n: number): Promise<void> {
    for (let i = 0; i < 800; i++) {
      await new Promise((r) => setTimeout(r, 10))
      if (completions(msgs).length >= n) return
    }
    throw new Error(`sweep did not complete (${completions(msgs).length}/${n})`)
  }

  /**
   * Sweep until the event total has held steady for `stable` consecutive
   * sweeps, and return it.
   *
   * Requiring several quiet sweeps rather than one matters here: a rollout can
   * legitimately yield NOTHING for many ticks while the ingester works through
   * megabytes of tool output, so "the total did not move this time" is not the
   * same as "there is nothing left". Stopping at the first quiet sweep reads a
   * mid-drain total as the final answer.
   */
  async function drain(fake: FakeTkWorkerTransport, msgs: FromTkWorker[], stable = 12): Promise<number> {
    await waitForCompletions(msgs, 1)
    let last = completions(msgs)[0].eventsTotal
    let quiet = 0
    for (let round = 1; round < 120; round++) {
      fake.post({ type: 'reindex' })
      await waitForCompletions(msgs, round + 1)
      const now = completions(msgs)[round].eventsTotal
      quiet = now === last ? quiet + 1 : 0
      last = now
      if (quiet >= stable) return now
    }
    return last
  }

  function start(opts: { codexDir: string; dbPath?: string; maxTickBytes?: number; fsImpl?: typeof fs }) {
    const fake = new FakeTkWorkerTransport()
    const msgs: FromTkWorker[] = []
    fake.onMessage((m) => msgs.push(m))
    const w = track(createTokenomicsWorker(fake.asWorkerSide(), {
      ...(opts.maxTickBytes !== undefined ? { maxTickBytes: opts.maxTickBytes } : {}),
      ...(opts.fsImpl ? { fs: opts.fsImpl } : {}),
    }))
    fake.post({
      type: 'open', dbPath: opts.dbPath ?? ':memory:', pricing: CODEX_PRICING, configs: [],
      claudeProjectsDir: path.join(tmp, 'claude'), codexSessionsDir: opts.codexDir,
    })
    return { fake, msgs, w }
  }

  // --- The identity line -----------------------------------------------------

  it('ingests a rollout whose session_meta is far larger than the old 64 KB line cap', async () => {
    // The pre-filter dropped any line over 64 KB before testing it for markers,
    // so an oversized session_meta never reached the parser. Without a session
    // id the parser returns NOTHING — and the cursor advanced anyway, so the
    // rollout's entire spend vanished silently and permanently. The largest
    // session_meta on a real tree was already 72% of that bound.
    const codexDir = path.join(tmp, 'codex')
    writeRollout(path.join(codexDir, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-big.jsonl', 3, { metaPad: 200 * 1024 })
    const { fake, msgs } = start({ codexDir })
    expect(await drain(fake, msgs)).toBe(3)
  })

  it('prices every turn from the model even when the model line is past any head window', async () => {
    // Two defects met here. The model is announced by a `turn_context` line, and
    // a tick starting past it left the model as 'unknown' — which matches no
    // pricing row, so those turns cost $0 (a fifth of all turns on real large
    // rollouts). The fallback was to re-read the file's head every tick, which
    // silently produced NOTHING whenever the header was not inside that bounded
    // window. Here 1.5 MB of tool output puts the model line beyond any such
    // window, so only identity carried on the file's own cursor can supply it.
    // Each turn bills 1M input tokens at $1/M, so 10 turns is exactly $10.
    const codexDir = path.join(tmp, 'codex')
    writeRollout(path.join(codexDir, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-mdl.jsonl', 10, { hugeLineBytes: 1536 * 1024, padBytes: 90 * 1024 })
    const { fake, msgs } = start({ codexDir, maxTickBytes: 256 * 1024 })
    expect(await drain(fake, msgs)).toBe(10)
    fake.post({ type: 'query', id: 7, kind: 'summary', args: {} })
    await new Promise((r) => setTimeout(r, 30))
    const res = msgs.find((m) => m.type === 'query-result' && (m as unknown as { id: number }).id === 7) as unknown as { rows: Array<{ kpis: { lifeToDateCostUsd: number } }> }
    expect(res.rows[0].kpis.lifeToDateCostUsd).toBeCloseTo(10, 5)
  })

  // --- Money: replay must not duplicate --------------------------------------

  it('does not double-count when a byte range is replayed after a lost cursor write', async () => {
    // Rows and cursor were written in SEPARATE transactions, and the supervisor
    // hard-kills the worker on app quit — so the window where rows are stored
    // and the cursor is not is hit in normal use. Replaying that range then
    // renumbered the same turns from a moved base, minting fresh dedup keys and
    // inflating the user's spend permanently. Rolling the cursor back here is
    // exactly that post-kill state.
    const codexDir = path.join(tmp, 'codex')
    const dbPath = path.join(tmp, 'tk.db')
    writeRollout(path.join(codexDir, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-dup.jsonl', 12, { padBytes: 100 * 1024 })
    const a = start({ codexDir, dbPath, maxTickBytes: 256 * 1024 })
    const drained = await drain(a.fake, a.msgs)
    expect(drained).toBe(12)
    a.w.stop()
    await new Promise((r) => setTimeout(r, 30))

    // Roll the cursor back to the start of the file, leaving every row in place.
    const raw = new Database(dbPath)
    const before = (raw.prepare('SELECT COUNT(*) AS n FROM tk_events').get() as { n: number }).n
    raw.prepare('UPDATE tk_files SET lastOffset = 0, scannedTo = 0, codexTurns = 0').run()
    raw.close()
    expect(before).toBe(12)

    const b = start({ codexDir, dbPath, maxTickBytes: 256 * 1024 })
    expect(await drain(b.fake, b.msgs)).toBe(12)
  })

  it('does not double-count when the same rollout is re-read from the top', async () => {
    // The truncation/rotation path resets the offset to 0 with rows already
    // stored. Re-deriving ordinals from a live per-SESSION row count made those
    // rows collide with themselves at a shifted base; keyed by position in the
    // file, a re-read is idempotent by construction.
    const codexDir = path.join(tmp, 'codex')
    const dbPath = path.join(tmp, 'tk.db')
    const file = writeRollout(path.join(codexDir, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-rr.jsonl', 6, {})
    const a = start({ codexDir, dbPath })
    expect(await drain(a.fake, a.msgs)).toBe(6)
    a.w.stop()
    await new Promise((r) => setTimeout(r, 30))

    // Report the file as bigger than the cursor thinks, forcing a full re-read.
    const raw = new Database(dbPath)
    raw.prepare('UPDATE tk_files SET lastOffset = ?, size = 0, mtime = 0 WHERE path = ?').run(fs.statSync(file).size + 1, file)
    raw.close()

    const b = start({ codexDir, dbPath })
    expect(await drain(b.fake, b.msgs)).toBe(6)
  })

  // --- Liveness --------------------------------------------------------------

  it('one unreadable rollout does not abort the sweep or block later files', async () => {
    // The streaming rewrite dropped the per-file `catch` the readFileSync path
    // had. A single EIO then unwound the whole sweep: every later rollout went
    // unread, the index never reported complete, and the five-second retry hit
    // the same file forever — the very wedge this ingester was written to fix.
    const codexDir = path.join(tmp, 'codex')
    const dir = path.join(codexDir, '2026', '08', '01')
    const bad = writeRollout(dir, 'rollout-2026-08-01T00-00-00-aaa.jsonl', 4, {})
    writeRollout(dir, 'rollout-2026-08-01T00-00-00-zzz.jsonl', 5, { sessionId: 'cx-2' })
    const badFds = new Set<number>()
    const failing = new Proxy(fs, {
      get(t, k) {
        if (k === 'openSync') return (p: string, ...rest: unknown[]) => {
          const fd = (fs.openSync as unknown as (...a: unknown[]) => number)(p, ...rest)
          if (p === bad) badFds.add(fd)
          return fd
        }
        if (k === 'readSync') return (fd: number, ...rest: unknown[]) => {
          if (badFds.has(fd)) { const e: NodeJS.ErrnoException = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e }
          return (fs.readSync as unknown as (...a: unknown[]) => number)(fd, ...rest)
        }
        // Descriptor numbers are recycled the moment they are closed, so a
        // stale entry here would poison whichever file opened next.
        if (k === 'closeSync') return (fd: number) => { badFds.delete(fd); return fs.closeSync(fd) }
        return (t as unknown as Record<PropertyKey, unknown>)[k]
      },
    })
    const { fake, msgs } = start({ codexDir, fsImpl: failing as unknown as typeof fs })
    // The healthy rollout, enumerated AFTER the failing one, is still ingested.
    expect(await drain(fake, msgs)).toBe(5)
  })

  it('does not re-read an unterminated tail on every later sweep', async () => {
    // A rollout whose last line has no newline legitimately parks the cursor in
    // front of it. Deciding "have we seen all of this file" from that cursor
    // meant the tail was re-read on every sweep for the life of the process.
    const codexDir = path.join(tmp, 'codex')
    writeRollout(path.join(codexDir, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-cut.jsonl', 4, { padBytes: 50 * 1024, tailBytes: 400 * 1024 })
    let bytesRead = 0
    const tracing = new Proxy(fs, {
      get(t, k) {
        if (k === 'readSync') return (fd: number, buf: Buffer, off: number, len: number, pos: number) => {
          const n = fs.readSync(fd, buf, off, len, pos); bytesRead += n; return n
        }
        return (t as unknown as Record<PropertyKey, unknown>)[k]
      },
    })
    const { fake, msgs } = start({ codexDir, fsImpl: tracing as unknown as typeof fs })
    await waitForCompletions(msgs, 1)
    const afterFirst = bytesRead
    for (let i = 0; i < 4; i++) { fake.post({ type: 'reindex' }); await waitForCompletions(msgs, i + 2) }
    // Four further sweeps over an unchanged file must cost almost nothing.
    expect(bytesRead - afterFirst).toBeLessThan(afterFirst / 2)
    // And parking in front of that partial line must not hold the index short
    // of complete forever: "have we seen all of this file" is not "did we parse
    // to the last byte".
    expect(completions(msgs).some((c) => c.firstIndex)).toBe(true)
  })

  // --- The reader itself -----------------------------------------------------
  //
  // Timing is deliberately NOT asserted here. The old loop's cost came from
  // rebuilding the whole accumulated run on every 256 KB read — quadratic in the
  // length of one line, measured at 5.5 s for a single 64 MB line. What removes
  // that cost is refusing to accumulate a run past the longest line anyone could
  // want, and THAT is a property with a deterministic test. A wall-clock
  // assertion over this much fixed worker overhead could not be made to fail.

  it('refuses to accumulate a run longer than the largest wanted line', () => {
    const p = path.join(tmp, 'huge.txt')
    const cap = 64 * 1024
    fs.writeFileSync(p, 'x'.repeat(cap * 8) + '\n' + 'small\n')
    const fd = fs.openSync(p, 'r')
    try {
      const seen: Array<{ len: number | null; byteLen: number }> = []
      const res = streamLines(fs, fd, 0, fs.statSync(p).size, cap, (lb, byteLen) => seen.push({ len: lb ? lb.length : null, byteLen }))
      // The over-cap line is reported — its bytes are accounted for, so the
      // cursor still advances past it — but it was never retained.
      expect(seen[0]).toEqual({ len: null, byteLen: cap * 8 + 1 })
      expect(seen[1]).toEqual({ len: 5, byteLen: 6 })
      expect(res.pendingLen).toBe(0)
    } finally { fs.closeSync(fd) }
  })

  it('accounts for every byte exactly, including lines spanning read buffers', () => {
    const p = path.join(tmp, 'spanning.txt')
    // 300 KB per line crosses the 256 KB internal read buffer; the last line is
    // deliberately left unterminated.
    const lines = [ 'a'.repeat(300 * 1024), 'b'.repeat(10), '', 'c'.repeat(300 * 1024) ]
    fs.writeFileSync(p, lines.join('\n') + '\n' + 'tail-with-no-newline')
    const size = fs.statSync(p).size
    const fd = fs.openSync(p, 'r')
    try {
      const got: string[] = []
      let consumed = 0
      const res = streamLines(fs, fd, 0, size, 1024 * 1024, (lb, byteLen) => { consumed += byteLen; got.push(lb ? lb.toString('utf8') : '<dropped>') })
      expect(got).toEqual(lines)                       // reassembled across buffers
      expect(consumed).toBe(size - 'tail-with-no-newline'.length)
      expect(res.pendingLen).toBe('tail-with-no-newline'.length)
      expect(res.pendingDropped).toBe(false)           // a short tail is kept, not skipped
      expect(res.pos).toBe(size)
    } finally { fs.closeSync(fd) }
  })

  it('drains a rollout built from lines far larger than any wanted line', async () => {
    // End-to-end: 4 MB of single-line tool output must not stop the turns after
    // it from being found.
    const codexDir = path.join(tmp, 'codex')
    writeRollout(path.join(codexDir, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-fat.jsonl', 5, { hugeLineBytes: 4 * 1024 * 1024 })
    const { fake, msgs } = start({ codexDir })
    expect(await drain(fake, msgs)).toBe(5)
  })

  // --- Honest completion -----------------------------------------------------

  it('does not report the first index complete while a file is still draining', async () => {
    // A per-tick byte budget means one sweep no longer drains a large rollout,
    // but completion was still declared at the end of the first sweep — putting
    // a confidently wrong spend figure in front of the user with no sign it was
    // still climbing.
    const codexDir = path.join(tmp, 'codex')
    writeRollout(path.join(codexDir, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-drn.jsonl', 20, { padBytes: 100 * 1024 })
    const { fake, msgs } = start({ codexDir, maxTickBytes: 256 * 1024 })
    await waitForCompletions(msgs, 1)
    const first = completions(msgs)[0]
    expect(first.eventsTotal).toBeLessThan(20)      // genuinely not finished
    expect(first.firstIndex).toBe(false)            // ...and it does not claim to be
    expect(await drain(fake, msgs)).toBe(20)
    expect(completions(msgs).some((c) => c.firstIndex)).toBe(true)  // ...but eventually does
  })
})
