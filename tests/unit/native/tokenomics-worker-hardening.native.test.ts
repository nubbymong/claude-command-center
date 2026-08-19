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

  const completions = (msgs: FromTkWorker[]) => msgs.filter((m) => m.type === 'index-complete') as Array<{ firstIndex: boolean; drained: boolean; filesFailed: number; eventsTotal: number }>

  /** Reduce a DB to the pre-migration `tk_files` shape, keeping its rows. */
  function downgradeCursors(dbPath: string): void {
    const raw = new Database(dbPath)
    raw.exec('ALTER TABLE tk_files RENAME TO tk_files_new')
    raw.exec('CREATE TABLE tk_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL, lastOffset INTEGER NOT NULL DEFAULT 0, lastIngestedAt INTEGER NOT NULL DEFAULT 0)')
    raw.exec('INSERT INTO tk_files SELECT path,size,mtime,lastOffset,lastIngestedAt FROM tk_files_new')
    raw.exec('DROP TABLE tk_files_new')
    raw.close()
  }

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

  it('prices each turn at the model that turn actually ran on', async () => {
    // One mutable model was stamped onto every turn in a parsed slice, so a
    // session that switched models was billed entirely at whichever model the
    // slice ended on — and because the slice boundary moves with the tick size,
    // identical bytes priced differently on different machines. Here: 2 turns at
    // $1/M then 2 at $0.1/M, 1M input each = $2.20, not $0.40.
    const codexDir = path.join(tmp, 'codex')
    const dir = path.join(codexDir, '2026', '08', '01')
    fs.mkdirSync(dir, { recursive: true })
    const turn = (i: number) => JSON.stringify({
      type: 'event_msg', timestamp: '2026-08-01T00:00:0' + i + 'Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 0 }, last_token_usage: { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 } } },
    })
    fs.writeFileSync(path.join(dir, 'rollout-2026-08-01T00-00-00-sw.jsonl'), [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-08-01T00:00:00Z', payload: { id: 'cx-sw', cwd: 'F:\\proj' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      turn(1), turn(2),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5-mini' } }),
      turn(3), turn(4),
    ].join('\n') + '\n')

    const fake = new FakeTkWorkerTransport()
    const msgs: FromTkWorker[] = []
    fake.onMessage((m) => msgs.push(m))
    track(createTokenomicsWorker(fake.asWorkerSide(), {}))
    fake.post({
      type: 'open', dbPath: ':memory:', configs: [],
      pricing: { 'gpt-5.5': { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 }, 'gpt-5-mini': { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 } },
      claudeProjectsDir: path.join(tmp, 'claude'), codexSessionsDir: codexDir,
    })
    expect(await drain(fake, msgs)).toBe(4)
    fake.post({ type: 'query', id: 9, kind: 'summary', args: {} })
    await new Promise((r) => setTimeout(r, 30))
    const res = msgs.find((m) => m.type === 'query-result' && (m as unknown as { id: number }).id === 9) as unknown as { rows: Array<{ kpis: { lifeToDateCostUsd: number } }> }
    expect(res.rows[0].kpis.lifeToDateCostUsd).toBeCloseTo(2.2, 5)
  })

  it('prices per turn when the switch lands in a LATER tick, not the first', async () => {
    // The per-turn fix above is defeated if the parse is seeded with the last
    // model named in the slice: every turn before the slice's first
    // turn_context then takes the model the slice ENDS on. That only shows up
    // once a tick starts mid-file, which is where real rollouts spend most of
    // their life. 4 turns at $1/M, then 4 at $0.1/M = $4.40, not $0.80.
    const codexDir = path.join(tmp, 'codex')
    const dir = path.join(codexDir, '2026', '08', '01')
    fs.mkdirSync(dir, { recursive: true })
    const pad = 'x'.repeat(60 * 1024)
    const lines: string[] = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-08-01T00:00:00Z', payload: { id: 'cx-late', cwd: 'F:\\proj' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    ]
    const turn = (i: number) => JSON.stringify({
      type: 'event_msg', timestamp: '2026-08-01T00:00:0' + (i % 10) + 'Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 0 }, last_token_usage: { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 } } },
    })
    const filler = () => JSON.stringify({ type: 'event_msg', payload: { type: 'tool_output', output: pad } })
    for (let i = 0; i < 4; i++) { lines.push(filler(), turn(i)) }
    lines.push(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5-mini' } }))
    for (let i = 4; i < 8; i++) { lines.push(filler(), turn(i)) }
    fs.writeFileSync(path.join(dir, 'rollout-2026-08-01T00-00-00-late.jsonl'), lines.join('\n') + '\n')

    const fake = new FakeTkWorkerTransport()
    const msgs: FromTkWorker[] = []
    fake.onMessage((m) => msgs.push(m))
    track(createTokenomicsWorker(fake.asWorkerSide(), { maxTickBytes: 128 * 1024 }))
    fake.post({
      type: 'open', dbPath: ':memory:', configs: [],
      pricing: { 'gpt-5.5': { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 }, 'gpt-5-mini': { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 } },
      claudeProjectsDir: path.join(tmp, 'claude'), codexSessionsDir: codexDir,
    })
    expect(await drain(fake, msgs)).toBe(8)
    fake.post({ type: 'query', id: 12, kind: 'summary', args: {} })
    await new Promise((r) => setTimeout(r, 30))
    const res = msgs.find((m) => m.type === 'query-result' && (m as unknown as { id: number }).id === 12) as unknown as { rows: Array<{ kpis: { lifeToDateCostUsd: number } }> }
    expect(res.rows[0].kpis.lifeToDateCostUsd).toBeCloseTo(4.4, 5)
  })

  it('keeps the good turns of a rollout whose header timestamp is unparseable', async () => {
    // A turn with no timestamp of its own falls back to the header's, and an
    // unparseable header makes that NaN. NaN binds as NULL against a NOT NULL
    // column, and `INSERT OR IGNORE` reports the rejection as changes === 0 —
    // indistinguishable from a dedup hit. The whole insert batch is one
    // statement per row, so the undated turn must be dropped where it can be
    // seen, without taking the dated ones with it.
    const codexDir = path.join(tmp, 'codex')
    const dir = path.join(codexDir, '2026', '08', '01')
    fs.mkdirSync(dir, { recursive: true })
    const usage = { total_token_usage: { input_tokens: 1000, output_tokens: 0 }, last_token_usage: { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 } }
    fs.writeFileSync(path.join(dir, 'rollout-2026-08-01T00-00-00-nan.jsonl'), [
      JSON.stringify({ type: 'session_meta', timestamp: 'not-a-date', payload: { id: 'cx-nan', cwd: 'F:\\proj' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: usage } }),                                  // undated -> NaN
      JSON.stringify({ type: 'event_msg', timestamp: '2026-08-01T00:00:05Z', payload: { type: 'token_count', info: usage } }), // dated
    ].join('\n') + '\n')
    const { fake, msgs } = start({ codexDir })
    expect(await drain(fake, msgs)).toBe(1)
    // The dated turn survives...
    fake.post({ type: 'query', id: 11, kind: 'summary', args: {} })
    await new Promise((r) => setTimeout(r, 30))
    const res = msgs.find((m) => m.type === 'query-result' && (m as unknown as { id: number }).id === 11) as unknown as { rows: Array<{ kpis: { lifeToDateCostUsd: number } }> }
    expect(res.rows[0].kpis.lifeToDateCostUsd).toBeCloseTo(1, 5)
    // ...and the one that could not be stored is REPORTED, rather than being
    // swallowed by INSERT OR IGNORE as if it had simply been counted already.
    const logs = msgs.filter((m) => m.type === 'log') as Array<{ entry: { level: string; message: string } }>
    expect(logs.some((l) => /unusable timestamp/.test(l.entry.message))).toBe(true)
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

  it('upgrading a database indexed by the previous build loses no turns', async () => {
    // The upgrade is the one event every existing user is guaranteed to hit.
    // Per-file ordinals arrive as 0 on a migrated cursor while its lastOffset is
    // deep into the file, so numbering the next turns from zero collided with
    // the rows already stored and INSERT OR IGNORE dropped them — turning the
    // over-count this work fixed into an equally silent under-count.
    const codexDir = path.join(tmp, 'codex')
    const dbPath = path.join(tmp, 'tk.db')
    const dir = path.join(codexDir, '2026', '08', '01')
    const name = 'rollout-2026-08-01T00-00-00-upg.jsonl'
    writeRollout(dir, name, 10, {})
    const a = start({ codexDir, dbPath })
    expect(await drain(a.fake, a.msgs)).toBe(10)
    a.w.stop()
    await new Promise((r) => setTimeout(r, 30))

    downgradeCursors(dbPath)                 // now it is a pre-migration database
    writeRollout(dir, name, 40, {})          // ...and the session kept going

    const b = start({ codexDir, dbPath })
    expect(await drain(b.fake, b.msgs)).toBe(40)   // not 30
  })

  it('a database migrated mid-drain still finds every turn', async () => {
    // The normal state of a multi-GB rollout at quit is part-indexed, which is
    // where the migration did the most damage: it lost every turn the previous
    // build had already stored for that file.
    const codexDir = path.join(tmp, 'codex')
    const dbPath = path.join(tmp, 'tk.db')
    writeRollout(path.join(codexDir, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-mid.jsonl', 20, { padBytes: 100 * 1024 })
    const a = start({ codexDir, dbPath, maxTickBytes: 256 * 1024 })
    await waitForCompletions(a.msgs, 2)      // stop part-way, as a quit would
    const partial = completions(a.msgs)[1].eventsTotal
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(20)
    a.w.stop()
    await new Promise((r) => setTimeout(r, 30))

    downgradeCursors(dbPath)
    const b = start({ codexDir, dbPath, maxTickBytes: 256 * 1024 })
    expect(await drain(b.fake, b.msgs)).toBe(20)
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

  it('a file deleted while part-scanned does not block completion forever', async () => {
    // `tk_files` is never pruned. Judging completeness by a query over that
    // table let a row for a file that no longer exists veto the first index for
    // good — a real 221 MB database already holds nine such rows, all for
    // missing files. Completeness is now judged by what the SWEEP saw.
    const codexDir = path.join(tmp, 'codex')
    const dir = path.join(codexDir, '2026', '08', '01')
    const doomed = writeRollout(dir, 'rollout-2026-08-01T00-00-00-gone.jsonl', 20, { padBytes: 100 * 1024 })
    writeRollout(dir, 'rollout-2026-08-01T00-00-00-keep.jsonl', 3, { sessionId: 'cx-keep' })
    const { fake, msgs } = start({ codexDir, maxTickBytes: 256 * 1024 })
    await waitForCompletions(msgs, 1)
    expect(completions(msgs)[0].drained).toBe(false)   // genuinely part-scanned
    fs.rmSync(doomed)
    for (let i = 0; i < 6; i++) { fake.post({ type: 'reindex' }); await waitForCompletions(msgs, i + 2) }
    expect(completions(msgs).some((c) => c.drained)).toBe(true)
  })

  it('a file that cannot be opened is reported, not allowed to block the index', async () => {
    // A file that cannot be read may never become readable, so blocking on it
    // left a first index unfinished for the life of the install — a spinner,
    // no error, no way out. The bar is "everything we CAN read has been read";
    // what could not be read is counted and surfaced instead of hidden.
    const codexDir = path.join(tmp, 'codex')
    const dir = path.join(codexDir, '2026', '08', '01')
    const bad = writeRollout(dir, 'rollout-2026-08-01T00-00-00-aaa.jsonl', 4, {})
    writeRollout(dir, 'rollout-2026-08-01T00-00-00-zzz.jsonl', 5, { sessionId: 'cx-2' })
    const failing = new Proxy(fs, {
      get(t, k) {
        if (k === 'openSync') return (p: string, ...rest: unknown[]) => {
          if (p === bad) { const e: NodeJS.ErrnoException = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e }
          return (fs.openSync as unknown as (...a: unknown[]) => number)(p, ...rest)
        }
        return (t as unknown as Record<PropertyKey, unknown>)[k]
      },
    })
    const { fake, msgs } = start({ codexDir, fsImpl: failing as unknown as typeof fs })
    // The healthy rollout is indexed, the index reaches completion, and the
    // unreadable one is counted rather than silently absent.
    expect(await drain(fake, msgs)).toBe(5)
    const last = completions(msgs)[completions(msgs).length - 1]
    expect(last.drained).toBe(true)
    expect(last.filesFailed).toBe(1)
    expect(completions(msgs).some((c) => c.firstIndex)).toBe(true)
  })

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
