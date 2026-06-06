import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LogSupervisor } from '../../../src/main/logging/log-supervisor'
import type { ForkedTranscriptsWorker } from '../../../src/main/logging/fork-transcripts-worker'
import { FakeTranscriptsWorkerTransport } from '../../../src/main/logging/log-worker-transport'
import type { ToTranscriptsWorker, FromTranscriptsWorker } from '../../../src/main/logging/log-worker-transport'
import { IPC } from '../../../src/shared/ipc-channels'
import type { DiagnosticsSnapshot } from '../../../src/shared/service-health'

/** A fake ForkedTranscriptsWorker whose transport the test drives directly:
 *  - `transport` records main->worker posts (workerMessages) and lets the test
 *    emit worker->main messages (emitToMain).
 *  - `triggerExit()` fires the registered onExit callback (simulates a crash).
 *  - `killed` reflects transport.kill(). */
function makeFakeWorker(): {
  worker: ForkedTranscriptsWorker
  transport: FakeTranscriptsWorkerTransport
  emit: (m: FromTranscriptsWorker) => void
  posts: ToTranscriptsWorker[]
  triggerExit: () => void
} {
  const transport = new FakeTranscriptsWorkerTransport()
  let exitCb: (() => void) | null = null
  const worker: ForkedTranscriptsWorker = {
    transport,
    kill: () => transport.kill(),
    onExit: (cb: () => void) => { exitCb = cb },
  }
  return {
    worker,
    transport,
    emit: (m) => transport.emitToMain(m),
    posts: transport.workerMessages,
    triggerExit: () => exitCb?.(),
  }
}

interface Harness {
  sup: LogSupervisor
  forkSpy: ReturnType<typeof vi.fn>
  emitted: Array<{ channel: string; payload: unknown }>
  /** The fake worker created by the MOST RECENT fork. */
  current: () => ReturnType<typeof makeFakeWorker>
  /** Advance the injected clock (does NOT advance timers — use vi.advanceTimersByTime for that). */
  tick: (ms: number) => void
}

function makeHarness(opts?: { maxRestarts?: number; bufferCapBytes?: number }): Harness {
  let clock = 1000
  const workers: Array<ReturnType<typeof makeFakeWorker>> = []
  const forkSpy = vi.fn(() => {
    const w = makeFakeWorker()
    workers.push(w)
    return w.worker
  })
  const emitted: Array<{ channel: string; payload: unknown }> = []
  const sup = new LogSupervisor({
    forkChild: forkSpy as unknown as () => ForkedTranscriptsWorker,
    dbPath: '/tmp/fake-transcripts.db',
    emit: (channel, payload) => emitted.push({ channel, payload }),
    now: () => clock,
    maxRestarts: opts?.maxRestarts,
    bufferCapBytes: opts?.bufferCapBytes,
  })
  return {
    sup,
    forkSpy,
    emitted,
    current: () => workers[workers.length - 1],
    tick: (ms) => { clock += ms },
  }
}

function lastSnapshot(emitted: Array<{ channel: string; payload: unknown }>): DiagnosticsSnapshot | undefined {
  for (let i = emitted.length - 1; i >= 0; i--) {
    if (emitted[i].channel === IPC.SERVICE_HEALTH_UPDATE) return emitted[i].payload as DiagnosticsSnapshot
  }
  return undefined
}

/** Minimal run-start meta for a session. */
function meta(sessionId: string) {
  return { sessionId, configLabel: 'C', provider: 'claude', startedAt: 1 }
}

describe('LogSupervisor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('start() forks the worker and sends open with the dbPath; state is starting', () => {
    const h = makeHarness()
    h.sup.start()
    expect(h.forkSpy).toHaveBeenCalledTimes(1)
    expect(h.current().posts).toContainEqual({ type: 'open', dbPath: '/tmp/fake-transcripts.db' })
    expect(h.sup.getDiagnosticsSnapshot().services[0].state).toBe('starting')
  })

  it('on ready -> state listening, host utility-process, startedAt set, health emitted', () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    const svc = h.sup.getDiagnosticsSnapshot().services[0]
    expect(svc.state).toBe('listening')
    expect(svc.host).toBe('utility-process')
    expect(svc.startedAt).not.toBeNull()
    const snap = lastSnapshot(h.emitted)
    expect(snap?.services[0].state).toBe('listening')
  })

  it('a health beat maps inFlight/messagesTotal->eventsTotal/dbBytes onto the pill + emits', () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    h.tick(500)
    h.current().emit({ type: 'health', inFlight: 3, tailing: 2, messagesTotal: 42, dbBytes: 99999 })
    const svc = h.sup.getDiagnosticsSnapshot().services[0]
    expect(svc.inFlight).toBe(3)
    expect(svc.eventsTotal).toBe(42)   // v2: messagesTotal occupies the eventsTotal slot
    expect(svc.dbBytes).toBe(99999)
    expect(svc.lastHeartbeatAt).toBe(1500)
    expect(svc.lastFlushAt).toBe(1500)
    expect(lastSnapshot(h.emitted)?.services[0].dbBytes).toBe(99999)
  })

  it('a log message appends to the diagnostics ring (capped) with serviceId logging', () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'log', entry: { level: 'warn', message: 'disk slow' } })
    const log = h.sup.getDiagnosticsSnapshot().log
    const found = log.find((l) => l.message === 'disk slow')
    expect(found).toBeDefined()
    expect(found?.serviceId).toBe('logging')
    expect(found?.level).toBe('warn')
  })

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  it('query() resolves with rows on a matching query-result', async () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    const p = h.sup.query('list-slots', { limit: 10 })
    const q = h.current().posts.find((m) => m.type === 'query') as Extract<ToTranscriptsWorker, { type: 'query' }>
    expect(q).toBeDefined()
    expect(q.kind).toBe('list-slots')
    h.current().emit({ type: 'query-result', id: q.id, rows: [{ slotKey: 'cfg1' }] })
    await expect(p).resolves.toEqual([{ slotKey: 'cfg1' }])
  })

  it('query() rejects when an error message carries the matching id', async () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    const p = h.sup.query('search', { query: 'x' })
    const q = h.current().posts.find((m) => m.type === 'query') as Extract<ToTranscriptsWorker, { type: 'query' }>
    h.current().emit({ type: 'error', id: q.id, message: 'bad query' })
    await expect(p).rejects.toThrow(/bad query/)
  })

  it('an error WITHOUT an id appends an error log + sets lastError (does not reject queries)', async () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    const p = h.sup.query('list-slots', {})
    const q = h.current().posts.find((m) => m.type === 'query') as Extract<ToTranscriptsWorker, { type: 'query' }>
    h.current().emit({ type: 'error', message: 'worker hiccup' })
    const svc = h.sup.getDiagnosticsSnapshot().services[0]
    expect(svc.lastError?.message).toContain('worker hiccup')
    expect(h.sup.getDiagnosticsSnapshot().log.some((l) => l.message.includes('worker hiccup'))).toBe(true)
    // the unrelated pending query is still resolvable (was not rejected)
    h.current().emit({ type: 'query-result', id: q.id, rows: [] })
    await expect(p).resolves.toEqual([])
  })

  it('pending queries reject on worker exit (no hung promises)', async () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    const p1 = h.sup.query('list-slots', {})
    const p2 = h.sup.query('search', { query: 'y' })
    const rejected1 = expect(p1).rejects.toThrow()
    const rejected2 = expect(p2).rejects.toThrow()
    h.current().triggerExit()
    await rejected1
    await rejected2
  })

  it('query() while down rejects quickly rather than hanging', async () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    h.current().triggerExit()   // worker gone, supervisor in restarting/crashed
    await expect(h.sup.query('list-slots', {})).rejects.toThrow()
  })

  it('query() that never gets a response rejects on the safety timeout', async () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    const p = h.sup.query('list-slots', {})
    const rejected = expect(p).rejects.toThrow(/timeout|timed out/i)
    await vi.advanceTimersByTimeAsync(20_000)
    await rejected
  })

  // ---------------------------------------------------------------------------
  // Restart / degrade
  // ---------------------------------------------------------------------------

  it('restarts the worker on unexpected exit after the first backoff, re-sending open', () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    expect(h.forkSpy).toHaveBeenCalledTimes(1)
    h.current().triggerExit()
    expect(h.sup.getDiagnosticsSnapshot().services[0].state).toBe('crashed')
    vi.advanceTimersByTime(300)   // first backoff = 250ms
    expect(h.forkSpy).toHaveBeenCalledTimes(2)
    expect(h.sup.getDiagnosticsSnapshot().services[0].restartCount).toBe(1)
    // the fresh worker is told to re-open the DB (it re-reconciles itself)
    expect(h.current().posts).toContainEqual({ type: 'open', dbPath: '/tmp/fake-transcripts.db' })
  })

  it('reaches degraded permanently after maxRestarts (no in-process fallback / no further forks)', () => {
    const h = makeHarness({ maxRestarts: 2 })
    h.sup.start()
    for (let i = 0; i < 3; i++) { h.current().triggerExit(); vi.advanceTimersByTime(5000) }
    const svc = h.sup.getDiagnosticsSnapshot().services[0]
    expect(svc.state).toBe('degraded')
    // host stays utility-process (not in-process-fallback): no fallback engine exists, so
    // the pill correctly shows "Degraded" rather than the misleading "Fallback".
    expect(svc.host).toBe('utility-process')
    const forksAtDegrade = h.forkSpy.mock.calls.length
    vi.advanceTimersByTime(60_000)   // no resurrection after permanent degrade
    expect(h.forkSpy).toHaveBeenCalledTimes(forksAtDegrade)
  })

  // ---------------------------------------------------------------------------
  // While-down buffer (run lifecycle + binds)
  // ---------------------------------------------------------------------------

  it('runStart/bindTranscript/runEnd while not-ready buffer, then replay in order on ready', () => {
    const h = makeHarness()
    h.sup.start()
    // not ready yet — everything buffers
    h.sup.runStart(meta('s1'))
    h.sup.bindTranscript('s1', 'C:/t/a.jsonl', 'exact')
    h.sup.runAccount('s1', 'a@b.c')
    h.sup.runEnd('s1', 9, 'exited')
    // nothing forwarded to the worker yet (only the open)
    expect(h.current().posts.some((m) => m.type === 'run-start')).toBe(false)
    h.current().emit({ type: 'ready' })
    const forwarded = h.current().posts.filter((m) => m.type !== 'open')
    // order preserved: run-start -> transcript-bind -> run-account -> run-end
    expect(forwarded.map((m) => m.type)).toEqual(['run-start', 'transcript-bind', 'run-account', 'run-end'])
  })

  it('runStart when listening forwards straight to the worker', () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    h.sup.runStart(meta('s1'))
    expect(h.current().posts.some((m) => m.type === 'run-start')).toBe(true)
  })

  it('a runStart during a crash window is replayed to the NEXT worker on its ready', () => {
    const h = makeHarness({ maxRestarts: 5 })
    h.sup.start()
    h.current().emit({ type: 'ready' })
    h.current().triggerExit()                     // crash -> while-down window opens
    h.sup.runStart(meta('s-during-crash'))        // arrives while down -> buffered
    vi.advanceTimersByTime(300)                   // past the first 250ms backoff
    const fresh = h.current()
    expect(fresh.posts.some((m) => m.type === 'run-start')).toBe(false)
    fresh.emit({ type: 'ready' })
    const replayed = fresh.posts.find((m) => m.type === 'run-start') as Extract<ToTranscriptsWorker, { type: 'run-start' }>
    expect(replayed).toBeDefined()
    expect(replayed.meta.sessionId).toBe('s-during-crash')
  })

  it('exceeding the buffer cap drops the oldest message, bumps dropsTotal, and goes degraded (visible)', () => {
    // Each buffered lifecycle message is estimated at 256B; a 600B cap holds two
    // messages but not three: the third enqueue drops the OLDEST ('a') and keeps
    // the rest ('b','c'), proving drop-oldest (not drop-everything).
    const h = makeHarness({ bufferCapBytes: 600 })
    h.sup.start()   // starting, not ready -> everything buffers
    h.sup.runStart(meta('a'))
    h.sup.runStart(meta('b'))
    h.sup.runStart(meta('c'))
    const svc = h.sup.getDiagnosticsSnapshot().services[0]
    expect(svc.state).toBe('degraded')
    expect(svc.dropsTotal).toBeGreaterThanOrEqual(1)
    expect(h.sup.getDiagnosticsSnapshot().log.some((l) => l.level !== 'info')).toBe(true)
    // flush: the oldest ('a') was dropped, so only b + c reach the worker
    h.current().emit({ type: 'ready' })
    const starts = h.current().posts.filter((m) => m.type === 'run-start') as Extract<ToTranscriptsWorker, { type: 'run-start' }>[]
    expect(starts.map((s) => s.meta.sessionId)).toEqual(['b', 'c'])
  })

  // ---------------------------------------------------------------------------
  // new-messages fan-out
  // ---------------------------------------------------------------------------

  it('onNewMessages fans out new-messages events; unsubscribe stops delivery; a throwing cb is isolated', () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    const seen: Array<{ sessionId: string; configId: string | null; count: number }> = []
    const unsub = h.sup.onNewMessages((e) => seen.push(e))
    h.sup.onNewMessages(() => { throw new Error('bad subscriber') })

    expect(() => h.current().emit({ type: 'new-messages', sessionId: 's1', configId: 'cfg1', count: 3 })).not.toThrow()
    expect(seen).toEqual([{ type: 'new-messages', sessionId: 's1', configId: 'cfg1', count: 3 }])

    unsub()
    h.current().emit({ type: 'new-messages', sessionId: 's1', configId: 'cfg1', count: 1 })
    expect(seen).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------
  // Transitional migrateDir stub
  // ---------------------------------------------------------------------------

  it('migrateDir rejects (legacy migration unavailable during the v2 transition)', async () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    await expect(h.sup.migrateDir('C:/legacy/logs')).rejects.toThrow(/unavailable/i)
  })

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  it('shutdown() posts shutdown, kills the worker, rejects pending queries, and does not restart', async () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    const p = h.sup.query('list-slots', {})
    const rejected = expect(p).rejects.toThrow()
    const w = h.current()
    h.sup.shutdown()
    expect(w.posts).toContainEqual({ type: 'shutdown' })
    expect(w.transport.killed).toBe(true)
    await rejected
    // a worker exit after shutdown must NOT trigger a restart
    const forks = h.forkSpy.mock.calls.length
    w.triggerExit()
    vi.advanceTimersByTime(5000)
    expect(h.forkSpy).toHaveBeenCalledTimes(forks)
  })

  // ---------------------------------------------------------------------------
  // Concurrency regression tests (lock in the load-bearing async paths)
  // ---------------------------------------------------------------------------

  describe('query double-settle safety', () => {
    it('timeout-then-late-result: a late query-result after the timeout is a no-op (no throw, no second settle)', async () => {
      const h = makeHarness({ maxRestarts: 5 })
      h.sup.start()
      h.current().emit({ type: 'ready' })
      const p = h.sup.query('list-slots', {})
      const q = h.current().posts.find((m) => m.type === 'query') as Extract<ToTranscriptsWorker, { type: 'query' }>
      expect(q).toBeDefined()

      // Advance past the timeout so the query rejects.
      const rejected = expect(p).rejects.toThrow(/timed out/i)
      await vi.advanceTimersByTimeAsync(20_000)
      await rejected

      // Now emit a late result for the same id — must be silently ignored (no unhandled rejection).
      expect(() => {
        h.current().emit({ type: 'query-result', id: q.id, rows: [{ late: true }] })
      }).not.toThrow()
      // Supervisor remains healthy — the stale result didn't corrupt state.
      expect(h.sup.getDiagnosticsSnapshot().services[0].state).toBe('listening')
    })

    it('result-then-timeout: resolving a query clears its timer so the timeout never fires as a second settle', async () => {
      const h = makeHarness()
      h.sup.start()
      h.current().emit({ type: 'ready' })
      const p = h.sup.query('list-slots', {})
      const q = h.current().posts.find((m) => m.type === 'query') as Extract<ToTranscriptsWorker, { type: 'query' }>

      // Resolve before the timeout.
      h.current().emit({ type: 'query-result', id: q.id, rows: [{ ok: true }] })
      await expect(p).resolves.toEqual([{ ok: true }])

      // Advance well past the timeout — the timer must have been cleared; no unhandled rejection.
      await vi.advanceTimersByTimeAsync(20_000)
      // If the timer were NOT cleared, the pending.delete(id) guard would have fired but
      // the id is already gone — so this just asserts no crash occurred.
      expect(h.sup.getDiagnosticsSnapshot().services[0].state).toBe('listening')
    })
  })

  describe('stale-child exit guard', () => {
    it('a second triggerExit from the OLD worker after a restart does not spawn a third worker or reject queries on the new worker', async () => {
      const h = makeHarness({ maxRestarts: 5 })
      h.sup.start()
      // Bring the first worker up and capture it as "old".
      const old = h.current()
      old.emit({ type: 'ready' })
      expect(h.forkSpy).toHaveBeenCalledTimes(1)

      // Crash the first worker -> backoff -> new worker spawns.
      old.triggerExit()
      await vi.advanceTimersByTimeAsync(500)   // past 250 ms first backoff
      expect(h.forkSpy).toHaveBeenCalledTimes(2)

      // Bring the new worker up and start a query on it.
      const neo = h.current()
      neo.emit({ type: 'ready' })
      const p = h.sup.query('list-slots', {})
      const q = neo.posts.find((m) => m.type === 'query') as Extract<ToTranscriptsWorker, { type: 'query' }>
      expect(q).toBeDefined()

      // Fire the OLD worker's exit a SECOND time (stale callback that somehow fires again).
      old.triggerExit()
      await vi.advanceTimersByTimeAsync(500)

      // Must NOT have spawned a third worker.
      expect(h.forkSpy).toHaveBeenCalledTimes(2)

      // The query on the NEW worker must still be resolvable (stale exit didn't reject it).
      neo.emit({ type: 'query-result', id: q.id, rows: [{ stale: false }] })
      await expect(p).resolves.toEqual([{ stale: false }])
    })
  })

  describe('permanent-degrade stickiness', () => {
    it('stale ready and health from a worker after maxRestarts do not flip state back to listening', () => {
      const h = makeHarness({ maxRestarts: 1 })
      h.sup.start()
      // Exhaust restarts: 2 exits -> permanent degrade.
      for (let i = 0; i < 2; i++) { h.current().triggerExit(); vi.advanceTimersByTime(5000) }
      expect(h.sup.getDiagnosticsSnapshot().services[0].state).toBe('degraded')

      // Now emit a stale `ready` from the dead worker — the guard must block it.
      h.current().emit({ type: 'ready' })
      expect(h.sup.getDiagnosticsSnapshot().services[0].state).toBe('degraded')
      expect(h.sup.getDiagnosticsSnapshot().services[0].host).toBe('utility-process')

      // Emit a stale `health` — must also be ignored.
      h.current().emit({ type: 'health', inFlight: 0, tailing: 0, messagesTotal: 0, dbBytes: 0 })
      expect(h.sup.getDiagnosticsSnapshot().services[0].state).toBe('degraded')
    })
  })

  describe('manualRestart — recovery from permanent degrade', () => {
    it('revives a permanently-degraded worker: respawns, resets counters, and goes listening on ready', () => {
      const h = makeHarness({ maxRestarts: 1 })
      h.sup.start()
      // Exhaust restarts -> permanent degrade (there is NO in-process fallback).
      for (let i = 0; i < 2; i++) { h.current().triggerExit(); vi.advanceTimersByTime(5000) }
      expect(h.sup.getDiagnosticsSnapshot().services[0].state).toBe('degraded')
      const forksAtDegrade = h.forkSpy.mock.calls.length

      // Manual restart is the ONLY way back. It must respawn + reset counters.
      const res = h.sup.manualRestart('logging')
      expect(res).toEqual({ ok: true })
      expect(h.forkSpy.mock.calls.length).toBe(forksAtDegrade + 1)
      expect(h.current().posts).toContainEqual({ type: 'open', dbPath: '/tmp/fake-transcripts.db' })
      expect(h.sup.getDiagnosticsSnapshot().services[0].restartCount).toBe(0)

      // Crucially the terminal degraded flag was cleared: a fresh `ready` now flips
      // back to listening (the permanent-degrade stickiness guard would otherwise
      // swallow it).
      h.current().emit({ type: 'ready' })
      expect(h.sup.getDiagnosticsSnapshot().services[0].state).toBe('listening')
    })

    it('declines an unknown service id', () => {
      const h = makeHarness()
      h.sup.start()
      expect(h.sup.manualRestart('hooks')).toEqual({ ok: false, reason: 'unknown-service' })
    })

    it('declines once shutting down', () => {
      const h = makeHarness()
      h.sup.start()
      h.sup.shutdown()
      expect(h.sup.manualRestart('logging')).toEqual({ ok: false, reason: 'shutting-down' })
    })
  })
})
