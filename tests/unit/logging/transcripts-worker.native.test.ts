/**
 * Native test for src/main/logging/transcripts-worker.ts — must run under
 * Electron-as-Node (npm run test:unit:native) because transcripts-db loads
 * better-sqlite3 (Electron ABI).
 *
 * Drives the worker through FakeTranscriptsWorkerTransport.asWorkerSide() and
 * the test handle's tickNow() — fully deterministic, no fake timers. Fresh tmp
 * dir per test (mkdtempSync) — NEVER touches real paths.
 */
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTranscriptsWorker } from '../../../src/main/logging/transcripts-worker'
import type { TranscriptsWorker } from '../../../src/main/logging/transcripts-worker'
import { FakeTranscriptsWorkerTransport } from '../../../src/main/logging/log-worker-transport'
import type { FromTranscriptsWorker, ToTranscriptsWorker } from '../../../src/main/logging/log-worker-transport'
import { openTranscriptsDb } from '../../../src/main/logging/transcripts-db'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One Claude-transcript JSONL conversation line. */
function jl(role: 'user' | 'assistant', text: string, ts = '2026-06-06T10:00:00.000Z'): string {
  return JSON.stringify({ type: role, timestamp: ts, message: { role, content: text } }) + '\n'
}

interface Harness {
  fake: FakeTranscriptsWorkerTransport
  worker: TranscriptsWorker
  out: FromTranscriptsWorker[]
  send: (m: ToTranscriptsWorker) => void
  /** All new-messages posts so far. */
  newMessages: () => Extract<FromTranscriptsWorker, { type: 'new-messages' }>[]
}

describe('transcripts-worker', () => {
  let dir: string
  let dbPath: string
  const liveWorkers: TranscriptsWorker[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'transcripts-worker-'))
    dbPath = join(dir, 'transcripts.db')
  })

  afterEach(() => {
    for (const w of liveWorkers.splice(0)) w.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeWorker(): Harness {
    const fake = new FakeTranscriptsWorkerTransport()
    const out: FromTranscriptsWorker[] = []
    fake.onMessage((m) => out.push(m))
    const worker = createTranscriptsWorker(fake.asWorkerSide())
    liveWorkers.push(worker)
    return {
      fake,
      worker,
      out,
      send: (m) => fake.post(m),
      newMessages: () =>
        out.filter((m): m is Extract<FromTranscriptsWorker, { type: 'new-messages' }> => m.type === 'new-messages'),
    }
  }

  /** Boot a worker with an opened DB + one running session 's1' (configId cfg1). */
  function bootWithRun(h: Harness, sessionId = 's1'): void {
    h.send({ type: 'open', dbPath })
    expect(h.out.some((m) => m.type === 'ready')).toBe(true)
    h.send({
      type: 'run-start',
      meta: { sessionId, configId: 'cfg1', configLabel: 'APP', provider: 'claude', startedAt: 100 },
    })
  }

  const inspect = <T>(fn: (raw: InstanceType<typeof Database>) => T): T => {
    const raw = new Database(dbPath)
    try {
      return fn(raw)
    } finally {
      raw.close()
    }
  }

  // -------------------------------------------------------------------------
  // open
  // -------------------------------------------------------------------------

  it('open posts ready', () => {
    const h = makeWorker()
    h.send({ type: 'open', dbPath })
    expect(h.out[h.out.length - 1]).toEqual({ type: 'ready' })
  })

  it('open closes dangling runs as crashed (endedAt = last message ts, else startedAt)', () => {
    // Pre-seed: a previous app session died with two runs still 'running'.
    const seed = openTranscriptsDb(dbPath)
    const withMsgs = seed.insertRun({ sessionId: 'dangling-a', configLabel: 'A', provider: 'claude', startedAt: 50 })
    seed.appendMessages(withMsgs, [{ idx: 0, ts: 70, role: 'user', kind: 'message', content: 'x' }])
    seed.insertRun({ sessionId: 'dangling-b', configLabel: 'B', provider: 'claude', startedAt: 60 })
    seed.close()

    const h = makeWorker()
    h.send({ type: 'open', dbPath })
    expect(h.out.some((m) => m.type === 'ready')).toBe(true)

    const rows = inspect((raw) =>
      raw.prepare('SELECT sessionId, status, endedAt FROM runs ORDER BY runId').all(),
    ) as { sessionId: string; status: string; endedAt: number }[]
    expect(rows[0]).toMatchObject({ sessionId: 'dangling-a', status: 'crashed', endedAt: 70 })
    expect(rows[1]).toMatchObject({ sessionId: 'dangling-b', status: 'crashed', endedAt: 60 })
  })

  it('query before open posts a correlated error (never crashes)', () => {
    const h = makeWorker()
    h.send({ type: 'query', id: 9, kind: 'list-slots', args: {} })
    const err = h.out.find((m) => m.type === 'error')
    expect(err).toMatchObject({ type: 'error', id: 9 })
    expect((err as { message: string }).message).toMatch(/before open/)
  })

  // -------------------------------------------------------------------------
  // ingest: bind -> tick -> rows + new-messages + cursor
  // -------------------------------------------------------------------------

  it('run-start + bind + tick ingests appended lines, posts new-messages, advances the cursor', () => {
    const h = makeWorker()
    bootWithRun(h)
    const tPath = join(dir, 't1.jsonl')
    writeFileSync(tPath, jl('user', 'hello') + jl('assistant', 'world'))
    h.send({ type: 'transcript-bind', sessionId: 's1', path: tPath, confidence: 'exact' })

    h.worker.tickNow()

    // new-messages carries the session + config attribution and the row count.
    expect(h.newMessages()).toEqual([{ type: 'new-messages', sessionId: 's1', configId: 'cfg1', count: 2 }])

    // Rows reached the DB in order.
    h.send({
      type: 'query', id: 1, kind: 'read-messages',
      args: { sessionId: 's1', anchor: 'tail', dir: 'older', limit: 10 },
    })
    const res = h.out.find((m) => m.type === 'query-result' && m.id === 1) as { rows: { content: string }[] }
    expect(res.rows.map((r) => r.content)).toEqual(['hello', 'world'])

    // Cursor == full file byte length (everything consumed).
    const cur = inspect((raw) => raw.prepare('SELECT ingestCursor, status FROM transcripts').get()) as {
      ingestCursor: number
      status: string
    }
    expect(cur.ingestCursor).toBe(Buffer.byteLength(jl('user', 'hello') + jl('assistant', 'world')))
    expect(cur.status).toBe('tailing')
  })

  it('subsequent appends are picked up incrementally without duplicates', () => {
    const h = makeWorker()
    bootWithRun(h)
    const tPath = join(dir, 't1.jsonl')
    writeFileSync(tPath, jl('user', 'one'))
    h.send({ type: 'transcript-bind', sessionId: 's1', path: tPath, confidence: 'exact' })
    h.worker.tickNow()
    appendFileSync(tPath, jl('assistant', 'two'))
    h.worker.tickNow()
    h.worker.tickNow() // an extra tick with no new bytes must add nothing

    const idxRows = inspect((raw) => raw.prepare('SELECT idx, content FROM messages ORDER BY idx').all()) as {
      idx: number
      content: string
    }[]
    expect(idxRows).toEqual([
      { idx: 0, content: 'one' },
      { idx: 1, content: 'two' },
    ])
    expect(h.newMessages().map((m) => m.count)).toEqual([1, 1])
  })

  // -------------------------------------------------------------------------
  // partial trailing line
  // -------------------------------------------------------------------------

  it('a partial trailing line is not consumed until its newline arrives (exactly one message)', () => {
    const h = makeWorker()
    bootWithRun(h)
    const tPath = join(dir, 't1.jsonl')
    const full = jl('user', 'complete-me')
    const half = full.slice(0, 25) // no trailing newline
    writeFileSync(tPath, half)
    h.send({ type: 'transcript-bind', sessionId: 's1', path: tPath, confidence: 'exact' })

    h.worker.tickNow()
    expect(h.newMessages()).toHaveLength(0)
    let cur = inspect((raw) => raw.prepare('SELECT ingestCursor FROM transcripts').get()) as { ingestCursor: number }
    expect(cur.ingestCursor).toBe(0) // nothing consumed

    appendFileSync(tPath, full.slice(25))
    h.worker.tickNow()
    expect(h.newMessages()).toEqual([{ type: 'new-messages', sessionId: 's1', configId: 'cfg1', count: 1 }])
    cur = inspect((raw) => raw.prepare('SELECT ingestCursor FROM transcripts').get()) as { ingestCursor: number }
    expect(cur.ingestCursor).toBe(Buffer.byteLength(full))
  })

  // -------------------------------------------------------------------------
  // rotation
  // -------------------------------------------------------------------------

  it('a second bind for the same session (new path) gets ord 1 and appends a clear divider row', () => {
    const h = makeWorker()
    bootWithRun(h)
    const p1 = join(dir, 'a.jsonl')
    const p2 = join(dir, 'b.jsonl')
    writeFileSync(p1, jl('user', 'before-clear'))
    h.send({ type: 'transcript-bind', sessionId: 's1', path: p1, confidence: 'exact' })
    h.worker.tickNow()

    writeFileSync(p2, jl('user', 'after-clear'))
    h.send({ type: 'transcript-bind', sessionId: 's1', path: p2, confidence: 'exact' })
    h.worker.tickNow()

    const tRows = inspect((raw) => raw.prepare('SELECT path, ord, status FROM transcripts ORDER BY ord').all()) as {
      path: string
      ord: number
      status: string
    }[]
    expect(tRows.map((r) => r.ord)).toEqual([0, 1])
    // The rotated-away transcript is retired; the new one tails.
    expect(tRows[0].status).toBe('complete')
    expect(tRows[1].status).toBe('tailing')

    const msgs = inspect((raw) => raw.prepare('SELECT idx, kind, content FROM messages ORDER BY idx').all()) as {
      idx: number
      kind: string
      content: string
    }[]
    expect(msgs.map((m) => m.kind)).toEqual(['message', 'clear', 'message'])
    expect(msgs[2].content).toBe('after-clear')
  })

  // -------------------------------------------------------------------------
  // resume after worker death
  // -------------------------------------------------------------------------

  it('a fresh worker on the same db resumes tailing from the cursor with no duplicate idx', () => {
    const h1 = makeWorker()
    bootWithRun(h1)
    const tPath = join(dir, 't1.jsonl')
    writeFileSync(tPath, jl('user', 'first') + jl('assistant', 'second'))
    h1.send({ type: 'transcript-bind', sessionId: 's1', path: tPath, confidence: 'exact' })
    h1.worker.tickNow()
    h1.worker.stop() // simulate worker death (no run-end, no shutdown handshake)

    // The app keeps writing while the worker is down.
    appendFileSync(tPath, jl('user', 'third'))

    const h2 = makeWorker()
    h2.send({ type: 'open', dbPath })
    expect(h2.out.some((m) => m.type === 'ready')).toBe(true)
    h2.worker.tickNow()

    const rows = inspect((raw) => raw.prepare('SELECT idx, content FROM messages ORDER BY idx').all()) as {
      idx: number
      content: string
    }[]
    expect(rows).toEqual([
      { idx: 0, content: 'first' },
      { idx: 1, content: 'second' },
      { idx: 2, content: 'third' },
    ])
    // Resumed tail attributes new-messages to the right session/config.
    expect(h2.newMessages()).toEqual([{ type: 'new-messages', sessionId: 's1', configId: 'cfg1', count: 1 }])
  })

  it('resume re-opens a dangling run to running (worker-only restart) and keeps ingesting into the same run', () => {
    // Worker 1: a live session 's1' with a tailing transcript + some messages.
    const h1 = makeWorker()
    bootWithRun(h1)
    const tPath = join(dir, 't1.jsonl')
    writeFileSync(tPath, jl('user', 'alpha') + jl('assistant', 'beta'))
    h1.send({ type: 'transcript-bind', sessionId: 's1', path: tPath, confidence: 'exact' })
    h1.worker.tickNow()
    const runId = inspect((raw) => raw.prepare('SELECT runId FROM runs').get()) as { runId: number }
    h1.worker.stop() // worker-only death — Claude is still alive, no run-end

    // Worker 2 opens the same db: (a) closeDanglingRuns first marks the run crashed.
    // We can't observe the intermediate state directly, but the resume loop reopens
    // it — verify the END state is 'running' with endedAt NULL.
    const h2 = makeWorker()
    h2.send({ type: 'open', dbPath })
    expect(h2.out.some((m) => m.type === 'ready')).toBe(true)

    let run = inspect((raw) => raw.prepare('SELECT status, endedAt FROM runs').get()) as {
      status: string
      endedAt: number | null
    }
    expect(run).toEqual({ status: 'running', endedAt: null })

    // (c) Claude appends a new line; a tick ingests it into the SAME run, no dup idx.
    appendFileSync(tPath, jl('user', 'gamma'))
    h2.worker.tickNow()

    const rows = inspect((raw) => raw.prepare('SELECT runId, idx, content FROM messages ORDER BY idx').all()) as {
      runId: number
      idx: number
      content: string
    }[]
    expect(rows).toEqual([
      { runId: runId.runId, idx: 0, content: 'alpha' },
      { runId: runId.runId, idx: 1, content: 'beta' },
      { runId: runId.runId, idx: 2, content: 'gamma' },
    ])
    run = inspect((raw) => raw.prepare('SELECT status FROM runs').get()) as { status: string }
    expect(run.status).toBe('running') // still running, NOT crashed
  })

  it('a dangling run with NO tailing transcript stays crashed on resume', () => {
    // Pre-seed a run that died 'running' but its transcript was already 'complete'
    // (no resumable tail) — closeDanglingRuns crashes it and resume must NOT reopen it.
    const seed = openTranscriptsDb(dbPath)
    const r = seed.insertRun({ sessionId: 'dead', configLabel: 'D', provider: 'claude', startedAt: 100 })
    const t = seed.bindTranscript(r, join(dir, 'done.jsonl'), { confidence: 'exact', parserVersion: 1 })
    seed.setTranscriptStatus(t.transcriptId, 'complete') // not 'tailing' → not resumable
    seed.appendMessages(r, [{ idx: 0, ts: 120, role: 'user', kind: 'message', content: 'x' }])
    seed.close()

    const h = makeWorker()
    h.send({ type: 'open', dbPath })
    expect(h.out.some((m) => m.type === 'ready')).toBe(true)

    const run = inspect((raw) => raw.prepare('SELECT status, endedAt FROM runs').get()) as {
      status: string
      endedAt: number
    }
    expect(run).toMatchObject({ status: 'crashed', endedAt: 120 })
  })

  // -------------------------------------------------------------------------
  // failure modes
  // -------------------------------------------------------------------------

  it('a missing transcript file marks the binding failed (messages kept), warns once, never crashes', () => {
    const h = makeWorker()
    bootWithRun(h)
    const tPath = join(dir, 'gone.jsonl')
    writeFileSync(tPath, jl('user', 'kept'))
    h.send({ type: 'transcript-bind', sessionId: 's1', path: tPath, confidence: 'exact' })
    h.worker.tickNow()
    rmSync(tPath)

    h.worker.tickNow()
    h.worker.tickNow() // further ticks are no-ops, no repeated warns / crashes

    const t = inspect((raw) => raw.prepare('SELECT status FROM transcripts').get()) as { status: string }
    expect(t.status).toBe('failed')
    const kept = inspect((raw) => raw.prepare('SELECT COUNT(*) AS c FROM messages').get()) as { c: number }
    expect(kept.c).toBe(1) // ingested messages survive the failure
    const warns = h.out.filter((m) => m.type === 'log' && m.entry.level === 'warn' && /missing/.test(m.entry.message))
    expect(warns).toHaveLength(1)
  })

  it('malformed lines are skipped (counted, not fatal); valid lines around them still ingest', () => {
    const h = makeWorker()
    bootWithRun(h)
    const tPath = join(dir, 't1.jsonl')
    writeFileSync(tPath, jl('user', 'good-1') + '{{{not json\n' + 'also-not-json\n' + jl('assistant', 'good-2'))
    h.send({ type: 'transcript-bind', sessionId: 's1', path: tPath, confidence: 'exact' })
    h.worker.tickNow()

    const rows = inspect((raw) => raw.prepare('SELECT content FROM messages ORDER BY idx').all()) as {
      content: string
    }[]
    expect(rows.map((r) => r.content)).toEqual(['good-1', 'good-2'])
    // The malformed bytes were still consumed (cursor passes them).
    const cur = inspect((raw) => raw.prepare('SELECT ingestCursor, status FROM transcripts').get()) as {
      ingestCursor: number
      status: string
    }
    expect(cur.status).toBe('tailing')
    expect(cur.ingestCursor).toBeGreaterThan(0)
  })

  it('a transcript that shrinks below the cursor is marked failed with a single warn (no crash)', () => {
    const h = makeWorker()
    bootWithRun(h)
    const tPath = join(dir, 't1.jsonl')
    writeFileSync(tPath, jl('user', 'line-one') + jl('assistant', 'line-two'))
    h.send({ type: 'transcript-bind', sessionId: 's1', path: tPath, confidence: 'exact' })
    h.worker.tickNow() // cursor advances past both lines

    const before = inspect((raw) => raw.prepare('SELECT ingestCursor, status FROM transcripts').get()) as {
      ingestCursor: number
      status: string
    }
    expect(before.ingestCursor).toBeGreaterThan(0)
    expect(before.status).toBe('tailing')

    // Truncate the file shorter than the cursor (in-place truncation — unexpected
    // for append-only transcripts).
    writeFileSync(tPath, jl('user', 'x'))
    h.worker.tickNow()
    h.worker.tickNow() // a further tick must not re-warn / crash (tail already dropped)

    const after = inspect((raw) => raw.prepare('SELECT status FROM transcripts').get()) as { status: string }
    expect(after.status).toBe('failed')
    const warns = h.out.filter(
      (m) => m.type === 'log' && m.entry.level === 'warn' && /shrank below cursor/.test(m.entry.message),
    )
    expect(warns).toHaveLength(1)
  })

  it('a transcript-bind for an unknown session is dropped with a warn', () => {
    const h = makeWorker()
    h.send({ type: 'open', dbPath })
    h.send({ type: 'transcript-bind', sessionId: 'nobody', path: join(dir, 'x.jsonl'), confidence: 'exact' })
    const warn = h.out.find((m) => m.type === 'log' && m.entry.level === 'warn')
    expect(warn).toBeDefined()
    const count = inspect((raw) => raw.prepare('SELECT COUNT(*) AS c FROM transcripts').get()) as { c: number }
    expect(count.c).toBe(0)
  })

  // -------------------------------------------------------------------------
  // run lifecycle
  // -------------------------------------------------------------------------

  it('run-end final-drains pending lines, marks transcripts complete, and closes the run', () => {
    const h = makeWorker()
    bootWithRun(h)
    const tPath = join(dir, 't1.jsonl')
    writeFileSync(tPath, jl('user', 'written-just-before-exit'))
    h.send({ type: 'transcript-bind', sessionId: 's1', path: tPath, confidence: 'exact' })
    // NO tick before the run ends — run-end must drain it.
    h.send({ type: 'run-end', sessionId: 's1', ts: 999, status: 'exited' })

    const run = inspect((raw) => raw.prepare('SELECT status, endedAt FROM runs').get()) as {
      status: string
      endedAt: number
    }
    expect(run).toEqual({ status: 'exited', endedAt: 999 })
    const t = inspect((raw) => raw.prepare('SELECT status FROM transcripts').get()) as { status: string }
    expect(t.status).toBe('complete')
    const msg = inspect((raw) => raw.prepare('SELECT content FROM messages').get()) as { content: string }
    expect(msg.content).toBe('written-just-before-exit')
  })

  it('R-002: a second run-start for one session AUTHORITATIVELY closes the prior open run (no double-tail)', () => {
    // In-session Restart / Switch-account reuses the sessionId: the respawn's
    // run-start can land before the old PTY's async exit delivers run-end. The
    // new run-start must retire the prior run (status='exited') so its transcript
    // does not stay 'tailing' and get ingested a second time.
    const h = makeWorker()
    h.send({ type: 'open', dbPath })
    expect(h.out.some((m) => m.type === 'ready')).toBe(true)

    // First run-start for 's1' (runId A) + bind a live transcript that is tailing.
    h.send({
      type: 'run-start',
      meta: { sessionId: 's1', configId: 'cfg1', configLabel: 'APP', provider: 'claude', startedAt: 100 },
    })
    const tPath = join(dir, 't1.jsonl')
    writeFileSync(tPath, jl('user', 'on-run-a'))
    h.send({ type: 'transcript-bind', sessionId: 's1', path: tPath, confidence: 'exact' })
    h.worker.tickNow()

    // Second run-start for the SAME session, NO run-end between (the race, runId B).
    h.send({
      type: 'run-start',
      meta: { sessionId: 's1', configId: 'cfg1', configLabel: 'APP', provider: 'claude', startedAt: 200 },
    })

    const runIds = inspect((raw) =>
      raw.prepare('SELECT runId, startedAt FROM runs ORDER BY runId').all(),
    ) as { runId: number; startedAt: number }[]
    expect(runIds).toHaveLength(2)
    const runA = runIds[0].runId
    const runB = runIds[1].runId

    // Prior run A is now CLOSED ('exited'), not left 'running'.
    const aStatus = inspect((raw) => raw.prepare('SELECT status FROM runs WHERE runId = ?').get(runA)) as {
      status: string
    }
    expect(aStatus.status).toBe('exited')
    // Run A's transcript is retired ('complete'), so the worker no longer tails it.
    const aTranscript = inspect((raw) =>
      raw.prepare('SELECT status FROM transcripts WHERE runId = ?').get(runA),
    ) as { status: string }
    expect(aTranscript.status).toBe('complete')

    // The respawn binds the SAME file to run B; further appends ingest ONCE (run B
    // only), not twice. Before the fix, run A's stale tail would also ingest them.
    appendFileSync(tPath, jl('assistant', 'after-restart'))
    h.send({ type: 'transcript-bind', sessionId: 's1', path: tPath, confidence: 'exact' })
    h.worker.tickNow()

    const afterRows = inspect((raw) =>
      raw.prepare("SELECT runId FROM messages WHERE content = 'after-restart'").all(),
    ) as { runId: number }[]
    expect(afterRows).toHaveLength(1)
    expect(afterRows[0].runId).toBe(runB)
  })

  it('R-003: the shutdown MESSAGE finalizes still-open runs as exited and retires their tails (clean quit)', () => {
    // On a clean app quit the worker receives the `shutdown` message. Any run
    // whose PTY exit never delivered a run-end (async before-quit ordering) must
    // be closed here, not left 'running' to be resurrected + double-tailed next
    // boot. (A worker-only kill does NOT send shutdown — see the resume tests.)
    const h = makeWorker()
    bootWithRun(h) // opens DB + run-start for s1
    const tPath = join(dir, 't1.jsonl')
    writeFileSync(tPath, jl('user', 'live-at-quit'))
    h.send({ type: 'transcript-bind', sessionId: 's1', path: tPath, confidence: 'exact' })
    h.worker.tickNow()

    // Clean app quit.
    h.send({ type: 'shutdown' })

    const run = inspect((raw) => raw.prepare('SELECT status, endedAt FROM runs').get()) as {
      status: string
      endedAt: number | null
    }
    expect(run.status).toBe('exited')
    expect(run.endedAt).not.toBeNull()
    const t = inspect((raw) => raw.prepare('SELECT status FROM transcripts').get()) as { status: string }
    expect(t.status).toBe('complete')
  })

  it('R-003: a worker-only kill (stop(), no shutdown message) leaves open runs RUNNING for resume', () => {
    // Guards the app-quit vs worker-restart distinction: stop() alone must NOT
    // finalize runs, or a worker crash/restart would wrongly mark live runs
    // exited (and the resume loop would not reopen them).
    const h = makeWorker()
    bootWithRun(h)
    const tPath = join(dir, 't1.jsonl')
    writeFileSync(tPath, jl('user', 'still-live'))
    h.send({ type: 'transcript-bind', sessionId: 's1', path: tPath, confidence: 'exact' })
    h.worker.tickNow()

    h.worker.stop() // worker-only death — NO shutdown message

    const run = inspect((raw) => raw.prepare('SELECT status, endedAt FROM runs').get()) as {
      status: string
      endedAt: number | null
    }
    expect(run).toEqual({ status: 'running', endedAt: null })
  })

  it('R-003: a boot-resurrected orphan (resumed tail, no sessionToRun entry) is closed by the next run-start', () => {
    // closeDanglingRuns marks a crashed run, then the resume loop reopens it to
    // 'running' + re-tails — but sessionToRun is intentionally NOT repopulated.
    // The next run-start for that session must STILL close the orphan (DB lookup),
    // or the resumed orphan and the new run both tail the same file.
    const seed = openTranscriptsDb(dbPath)
    const orphan = seed.insertRun({ sessionId: 's1', configId: 'cfg1', configLabel: 'APP', provider: 'claude', startedAt: 50 })
    const tPath = join(dir, 't1.jsonl')
    writeFileSync(tPath, jl('user', 'pre-crash'))
    const bound = seed.bindTranscript(orphan, tPath, { confidence: 'exact', parserVersion: 1 })
    seed.setTranscriptStatus(bound.transcriptId, 'tailing') // resumable on next open
    seed.close()

    const h = makeWorker()
    h.send({ type: 'open', dbPath }) // closeDanglingRuns -> reopenRun resurrects the orphan tail
    expect(h.out.some((m) => m.type === 'ready')).toBe(true)

    // The respawn's run-start arrives (sessionToRun is empty for s1 here).
    h.send({
      type: 'run-start',
      meta: { sessionId: 's1', configId: 'cfg1', configLabel: 'APP', provider: 'claude', startedAt: 200 },
    })

    const rows = inspect((raw) => raw.prepare('SELECT runId, status FROM runs ORDER BY runId').all()) as {
      runId: number
      status: string
    }[]
    expect(rows).toHaveLength(2)
    // The orphan (runId = orphan) is closed; only the new run stays running.
    expect(rows.find((r) => r.runId === orphan)!.status).toBe('exited')
    expect(rows.find((r) => r.runId !== orphan)!.status).toBe('running')
    // Its transcript is retired so the worker stops double-tailing it.
    const t = inspect((raw) => raw.prepare('SELECT status FROM transcripts WHERE runId = ?').get(orphan)) as {
      status: string
    }
    expect(t.status).toBe('complete')
  })

  it('run-account sets accountEmail on the open run', () => {
    const h = makeWorker()
    bootWithRun(h)
    h.send({ type: 'run-account', sessionId: 's1', accountEmail: 'user@example.com' })
    const run = inspect((raw) => raw.prepare('SELECT accountEmail FROM runs').get()) as { accountEmail: string }
    expect(run.accountEmail).toBe('user@example.com')
  })

  // -------------------------------------------------------------------------
  // queries
  // -------------------------------------------------------------------------

  it('serves list-slots / ingest-stats / search round-trips', () => {
    const h = makeWorker()
    bootWithRun(h)
    const tPath = join(dir, 't1.jsonl')
    writeFileSync(tPath, jl('user', 'uniqueXYZneedle'))
    h.send({ type: 'transcript-bind', sessionId: 's1', path: tPath, confidence: 'exact' })
    h.worker.tickNow()

    h.send({ type: 'query', id: 1, kind: 'list-slots', args: {} })
    const slots = h.out.find((m) => m.type === 'query-result' && m.id === 1) as { rows: { slotKey: string }[] }
    expect(slots.rows).toHaveLength(1)
    expect(slots.rows[0].slotKey).toBe('cfg1')

    h.send({ type: 'query', id: 2, kind: 'ingest-stats', args: { sessionId: 's1' } })
    const stats = h.out.find((m) => m.type === 'query-result' && m.id === 2) as {
      rows: { messageCount: number }[]
    }
    expect(stats.rows[0].messageCount).toBe(1)

    h.send({ type: 'query', id: 3, kind: 'search', args: { query: 'uniqueXYZneedle' } })
    const hits = h.out.find((m) => m.type === 'query-result' && m.id === 3) as { rows: unknown[] }
    expect(hits.rows).toHaveLength(1)
  })

  it('the re-entrancy guard clears in finally even when a drain throws (next tick still runs)', () => {
    // fsImpl that throws on the FIRST readSync only, then delegates to real fs.
    // The throw escapes drainTail -> tickNow's per-tail catch marks that tail
    // failed and the outer finally clears `ticking`, so the NEXT tick is not wedged.
    let firstRead = true
    const fsImpl = {
      statSync: (p: string) => statSync(p),
      openSync: (p: string, flags: string) => openSync(p, flags),
      readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
        if (firstRead) {
          firstRead = false
          throw new Error('synthetic read failure')
        }
        return readSync(fd, buffer, offset, length, position)
      },
      closeSync: (fd: number) => closeSync(fd),
    }
    const fake = new FakeTranscriptsWorkerTransport()
    const out: FromTranscriptsWorker[] = []
    fake.onMessage((m) => out.push(m))
    const worker = createTranscriptsWorker(fake.asWorkerSide(), fsImpl)
    liveWorkers.push(worker)
    const send = (m: ToTranscriptsWorker) => fake.post(m)

    send({ type: 'open', dbPath })
    send({
      type: 'run-start',
      meta: { sessionId: 'bad', configId: 'cfgBad', configLabel: 'BAD', provider: 'claude', startedAt: 100 },
    })
    send({
      type: 'run-start',
      meta: { sessionId: 'good', configId: 'cfgGood', configLabel: 'GOOD', provider: 'claude', startedAt: 100 },
    })
    const pBad = join(dir, 'bad.jsonl')
    const pGood = join(dir, 'good.jsonl')
    writeFileSync(pBad, jl('user', 'will-fail'))
    writeFileSync(pGood, jl('user', 'healthy'))
    send({ type: 'transcript-bind', sessionId: 'bad', path: pBad, confidence: 'exact' })

    // First tick: the bad tail's read throws -> caught, marked failed, ticking cleared.
    worker.tickNow()
    const badStatus = inspect((raw) =>
      raw.prepare("SELECT status FROM transcripts WHERE path = ?").get(pBad),
    ) as { status: string }
    expect(badStatus.status).toBe('failed')
    expect(out.some((m) => m.type === 'error')).toBe(false) // never crashes the worker

    // Bind a healthy transcript and tick again: if `ticking` were stuck true this
    // would be a silent no-op. It ingests, proving the guard cleared in finally.
    send({ type: 'transcript-bind', sessionId: 'good', path: pGood, confidence: 'exact' })
    worker.tickNow()
    const goodMsg = inspect((raw) =>
      raw.prepare("SELECT content FROM messages m JOIN runs r ON r.runId = m.runId WHERE r.sessionId = 'good'").get(),
    ) as { content: string } | undefined
    expect(goodMsg?.content).toBe('healthy')
  })

  it('an unknown query kind posts a correlated error, not a crash (poison guard)', () => {
    const h = makeWorker()
    bootWithRun(h)
    h.send({ type: 'query', id: 42, kind: 'bogus-kind', args: {} })
    const err = h.out.find((m) => m.type === 'error')
    expect(err).toMatchObject({ type: 'error', id: 42 })
    expect((err as { message: string }).message).toMatch(/unknown query kind/)
    // The worker is still alive and serving.
    h.send({ type: 'query', id: 43, kind: 'list-slots', args: {} })
    expect(h.out.some((m) => m.type === 'query-result' && m.id === 43)).toBe(true)
  })

  it('a query whose args throw posts a correlated error (read-messages without scope)', () => {
    const h = makeWorker()
    bootWithRun(h)
    h.send({ type: 'query', id: 5, kind: 'read-messages', args: {} })
    const err = h.out.find((m) => m.type === 'error' && m.id === 5)
    expect(err).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // health + shutdown
  // -------------------------------------------------------------------------

  it('healthNow reports tailing count, messagesTotal, and dbBytes', () => {
    const h = makeWorker()
    bootWithRun(h)
    const tPath = join(dir, 't1.jsonl')
    writeFileSync(tPath, jl('user', 'a') + jl('user', 'b'))
    h.send({ type: 'transcript-bind', sessionId: 's1', path: tPath, confidence: 'exact' })
    h.worker.tickNow()
    h.worker.healthNow()
    const health = h.out.find((m) => m.type === 'health') as Extract<FromTranscriptsWorker, { type: 'health' }>
    expect(health).toBeDefined()
    expect(health.tailing).toBe(1)
    expect(health.messagesTotal).toBe(2)
    expect(health.dbBytes).toBeGreaterThan(0)
  })

  it('shutdown stops the worker; subsequent messages answer "before open"', () => {
    const h = makeWorker()
    bootWithRun(h)
    h.send({ type: 'shutdown' })
    h.send({ type: 'query', id: 6, kind: 'list-slots', args: {} })
    const err = h.out.find((m) => m.type === 'error' && m.id === 6)
    expect((err as { message: string }).message).toMatch(/before open/)
  })

  // -------------------------------------------------------------------------
  // recent-sessions + session-config queries
  // -------------------------------------------------------------------------

  it('recent-sessions returns sessions matching projectDir, ordered by lastActive DESC, respects limit', () => {
    // seed directly via openTranscriptsDb so we can set projectCwd
    const seed = openTranscriptsDb(dbPath)
    // s1 in our project, closed at 1500
    seed.insertRun({
      sessionId: 's1', configId: 'cfg1', configLabel: 'APP', provider: 'claude',
      startedAt: 1000, projectCwd: 'F:\\MY_PROJECT',
    })
    seed.closeRun('s1', 1500, 'exited')
    // s2 in our project, open (startedAt=2000, no endedAt) — lastActive=2000
    seed.insertRun({
      sessionId: 's2', configId: 'cfg2', configLabel: 'APP', provider: 'claude',
      startedAt: 2000, projectCwd: 'F:\\MY_PROJECT',
    })
    // s3 in a DIFFERENT project — must be excluded
    seed.insertRun({
      sessionId: 's3', configId: 'cfg3', configLabel: 'OTHER', provider: 'claude',
      startedAt: 3000, projectCwd: 'C:\\OtherProject',
    })
    seed.close()

    const h = makeWorker()
    h.send({ type: 'open', dbPath })

    // mangleCwdToProjectDir('F:\\MY_PROJECT') = 'F--MY-PROJECT'
    h.send({ type: 'query', id: 10, kind: 'recent-sessions', args: { projectDir: 'F--MY-PROJECT', limit: 5 } })
    const res = h.out.find((m) => m.type === 'query-result' && m.id === 10) as { rows: { sessionId: string; lastActive: number }[] }
    expect(res).toBeDefined()
    // s2 (lastActive=2000) before s1 (lastActive=1500); s3 excluded
    expect(res.rows.map((r) => r.sessionId)).toEqual(['s2', 's1'])
    expect(res.rows[0].lastActive).toBe(2000)
    expect(res.rows[1].lastActive).toBe(1500)

    // limit=1 returns only the most recent
    h.send({ type: 'query', id: 11, kind: 'recent-sessions', args: { projectDir: 'F--MY-PROJECT', limit: 1 } })
    const res1 = h.out.find((m) => m.type === 'query-result' && m.id === 11) as { rows: { sessionId: string }[] }
    expect(res1.rows.map((r) => r.sessionId)).toEqual(['s2'])

    // wrong projectDir → empty
    h.send({ type: 'query', id: 12, kind: 'recent-sessions', args: { projectDir: 'X--NOPE', limit: 5 } })
    const resNone = h.out.find((m) => m.type === 'query-result' && m.id === 12) as { rows: unknown[] }
    expect(resNone.rows).toHaveLength(0)
  })

  it('session-config returns [{configId}] for known session and [] for unknown', () => {
    const seed = openTranscriptsDb(dbPath)
    seed.insertRun({
      sessionId: 'sA', configId: 'cfgA', configLabel: 'A', provider: 'claude', startedAt: 100,
    })
    // sB has no configId (orphan)
    seed.insertRun({
      sessionId: 'sB', configLabel: 'B', provider: 'claude', startedAt: 200,
    })
    seed.close()

    const h = makeWorker()
    h.send({ type: 'open', dbPath })

    h.send({ type: 'query', id: 20, kind: 'session-config', args: { sessionId: 'sA' } })
    const resA = h.out.find((m) => m.type === 'query-result' && m.id === 20) as { rows: { configId: string | null }[] }
    expect(resA.rows).toEqual([{ configId: 'cfgA' }])

    h.send({ type: 'query', id: 21, kind: 'session-config', args: { sessionId: 'sB' } })
    const resB = h.out.find((m) => m.type === 'query-result' && m.id === 21) as { rows: { configId: string | null }[] }
    expect(resB.rows).toEqual([{ configId: null }])

    h.send({ type: 'query', id: 22, kind: 'session-config', args: { sessionId: 'nobody' } })
    const resNone = h.out.find((m) => m.type === 'query-result' && m.id === 22) as { rows: unknown[] }
    expect(resNone.rows).toHaveLength(0)
  })
})
