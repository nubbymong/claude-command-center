import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LogSupervisor } from '../../../src/main/logging/log-supervisor'
import type { ForkedLogWorker } from '../../../src/main/logging/fork-log-worker'
import { FakeWorkerTransport } from '../../../src/main/logging/log-worker-transport'
import type { ToWorker, FromWorker } from '../../../src/main/logging/log-worker-transport'
import { IPC } from '../../../src/shared/ipc-channels'
import type { DiagnosticsSnapshot } from '../../../src/shared/service-health'

/** A fake ForkedLogWorker whose transport the test drives directly:
 *  - `transport` records main->worker posts (workerMessages) and lets the test
 *    emit worker->main messages (emitToMain).
 *  - `triggerExit()` fires the registered onExit callback (simulates a crash).
 *  - `killed` reflects transport.kill(). */
function makeFakeWorker(): {
  worker: ForkedLogWorker
  transport: FakeWorkerTransport
  emit: (m: FromWorker) => void
  posts: ToWorker[]
  triggerExit: () => void
} {
  const transport = new FakeWorkerTransport()
  let exitCb: (() => void) | null = null
  const worker: ForkedLogWorker = {
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
    forkChild: forkSpy as unknown as () => ForkedLogWorker,
    dbPath: '/tmp/fake-logs.db',
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

/** A minimal one-session batch with a single data chunk of `bytes` raw bytes. */
function batchOf(sessionId: string, bytes: number): { sessions: { sessionId: string; chunks: { ts: number; type: 'data'; raw: Uint8Array }[] }[] } {
  return { sessions: [{ sessionId, chunks: [{ ts: 1, type: 'data', raw: new Uint8Array(bytes) }] }] }
}

describe('LogSupervisor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('start() forks the worker and sends open with the dbPath; state is starting', () => {
    const h = makeHarness()
    h.sup.start()
    expect(h.forkSpy).toHaveBeenCalledTimes(1)
    expect(h.current().posts).toContainEqual({ type: 'open', dbPath: '/tmp/fake-logs.db' })
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

  it('sends reconcile exactly once on first ready', () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    const reconciles = h.current().posts.filter((m) => m.type === 'reconcile')
    expect(reconciles).toHaveLength(1)
  })

  it('a health beat maps inFlight/eventsTotal/dropsTotal/dbBytes onto the pill + emits', () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    h.tick(500)
    h.current().emit({ type: 'health', inFlight: 3, eventsTotal: 42, dropsTotal: 7, dbBytes: 99999 })
    const svc = h.sup.getDiagnosticsSnapshot().services[0]
    expect(svc.inFlight).toBe(3)
    expect(svc.eventsTotal).toBe(42)
    expect(svc.dropsTotal).toBe(7)
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

  it('query() resolves with rows on a matching query-result', async () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    const p = h.sup.query('listSessions', { limit: 10 })
    const q = h.current().posts.find((m) => m.type === 'query') as Extract<ToWorker, { type: 'query' }>
    expect(q).toBeDefined()
    expect(q.kind).toBe('listSessions')
    h.current().emit({ type: 'query-result', id: q.id, rows: [{ sessionId: 'a' }] })
    await expect(p).resolves.toEqual([{ sessionId: 'a' }])
  })

  it('query() rejects when an error message carries the matching id', async () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    const p = h.sup.query('search', { query: 'x' })
    const q = h.current().posts.find((m) => m.type === 'query') as Extract<ToWorker, { type: 'query' }>
    h.current().emit({ type: 'error', id: q.id, message: 'bad query' })
    await expect(p).rejects.toThrow(/bad query/)
  })

  it('an error WITHOUT an id appends an error log + sets lastError (does not reject queries)', async () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    const p = h.sup.query('listSessions', {})
    const q = h.current().posts.find((m) => m.type === 'query') as Extract<ToWorker, { type: 'query' }>
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
    const p1 = h.sup.query('listSessions', {})
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
    await expect(h.sup.query('listSessions', {})).rejects.toThrow()
  })

  it('query() that never gets a response rejects on the safety timeout', async () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    const p = h.sup.query('listSessions', {})
    const rejected = expect(p).rejects.toThrow(/timeout|timed out/i)
    await vi.advanceTimersByTimeAsync(20_000)
    await rejected
  })

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
    // the fresh worker is told to re-open the DB
    expect(h.current().posts).toContainEqual({ type: 'open', dbPath: '/tmp/fake-logs.db' })
  })

  it('reaches degraded permanently after maxRestarts (no in-process fallback / no further forks)', () => {
    const h = makeHarness({ maxRestarts: 2 })
    h.sup.start()
    for (let i = 0; i < 3; i++) { h.current().triggerExit(); vi.advanceTimersByTime(5000) }
    const svc = h.sup.getDiagnosticsSnapshot().services[0]
    expect(svc.state).toBe('degraded')
    expect(svc.host).toBe('in-process-fallback')   // never flips to utility-process; no fallback engine
    const forksAtDegrade = h.forkSpy.mock.calls.length
    vi.advanceTimersByTime(60_000)   // no resurrection after permanent degrade
    expect(h.forkSpy).toHaveBeenCalledTimes(forksAtDegrade)
  })

  it('postBatch while not-ready buffers, then flushes in order on ready', () => {
    const h = makeHarness()
    h.sup.start()
    // not ready yet
    h.sup.postBatch(batchOf('s1', 10))
    h.sup.startSession({ sessionId: 's1', configLabel: 'C', provider: 'claude', startedAt: 1 })
    h.sup.postBatch(batchOf('s1', 20))
    // nothing forwarded to the worker yet (only the open)
    expect(h.current().posts.some((m) => m.type === 'batch')).toBe(false)
    h.current().emit({ type: 'ready' })
    const forwarded = h.current().posts.filter((m) => m.type === 'batch' || m.type === 'session-start')
    // order preserved: batch(s1,10) -> session-start -> batch(s1,20)
    expect(forwarded.map((m) => m.type)).toEqual(['batch', 'session-start', 'batch'])
  })

  it('postBatch when listening forwards straight to the worker', () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    h.sup.postBatch(batchOf('s1', 10))
    expect(h.current().posts.some((m) => m.type === 'batch')).toBe(true)
  })

  it('exceeding the buffer cap drops the oldest batch, bumps dropsTotal, and goes degraded (visible)', () => {
    // cap = 150 bytes holds two 60-byte batches but not three: the third enqueue
    // drops the OLDEST ('a') and keeps the rest ('b','c'), proving drop-oldest
    // (not drop-everything).
    const h = makeHarness({ bufferCapBytes: 150 })
    h.sup.start()   // starting, not ready -> everything buffers
    h.sup.postBatch(batchOf('a', 60))
    h.sup.postBatch(batchOf('b', 60))
    h.sup.postBatch(batchOf('c', 60))
    const svc = h.sup.getDiagnosticsSnapshot().services[0]
    expect(svc.state).toBe('degraded')
    expect(svc.dropsTotal).toBeGreaterThanOrEqual(1)
    expect(h.sup.getDiagnosticsSnapshot().log.some((l) => l.level !== 'info')).toBe(true)
    // flush: the oldest ('a') was dropped, so only b + c reach the worker
    h.current().emit({ type: 'ready' })
    const batches = h.current().posts.filter((m) => m.type === 'batch') as Extract<ToWorker, { type: 'batch' }>[]
    const sessionIds = batches.map((b) => b.sessions[0].sessionId)
    expect(sessionIds).toEqual(['b', 'c'])
  })

  it('shutdown() posts shutdown, kills the worker, rejects pending queries, and does not restart', async () => {
    const h = makeHarness()
    h.sup.start()
    h.current().emit({ type: 'ready' })
    const p = h.sup.query('listSessions', {})
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
})
