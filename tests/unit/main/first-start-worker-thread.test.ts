// [host] ADR-025: how the main process starts the first-start worker thread
// and hears from it. The Worker class is a stand-in that records what it was
// given (the test isolation guard refuses a real eval worker thread); the
// worker's own body runs for real in first-start-worker.test.ts. Nothing is
// started.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ made: [] as Array<{ source: unknown; options: Record<string, unknown>; posted: unknown[]; emit: (ev: string, a?: unknown) => void; unrefd: boolean }> }))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class Worker extends Emitter {
    posted: unknown[] = []
    unrefd = false
    constructor(source: unknown, options: Record<string, unknown>) {
      super()
      const rec = { source, options, posted: this.posted, emit: (ev: string, a?: unknown) => { this.emit(ev, a) }, unrefd: false }
      h.made.push(rec)
      this.unref = () => { rec.unrefd = true }
    }
    postMessage(m: unknown) { this.posted.push(m) }
    unref = () => {}
  }
  return { Worker }
})

const { startFirstStartWorker, FIRST_START_WORKER_SOURCE } = await import('../../../src/main/first-start-warmup')
import type { FirstStartRequest } from '../../../src/main/first-start-warmup'

const REQ: FirstStartRequest = {
  file: 'C:\\Users\\A\\.local\\bin\\claude.exe', args: ['--version'], env: { SystemRoot: 'C:\\Windows' },
  cwd: 'C:\\Users\\A\\.local\\bin', timeoutMs: 10_000, killGraceMs: 2_000, maxOutput: 4_096,
}

beforeEach(() => { h.made.length = 0 })

describe('the first-start worker thread (ADR-025)', () => {
  it('runs the worker text as an eval worker with an empty environment of its own and only the request', () => {
    startFirstStartWorker(REQ)
    expect(h.made).toHaveLength(1)
    const w = h.made[0]
    expect(w.source).toBe(FIRST_START_WORKER_SOURCE)
    expect(w.options.eval).toBe(true)
    expect(w.options.env).toEqual({})
    const data = w.options.workerData as { request: unknown; state?: unknown }
    expect(data.request).toEqual(REQ)
    expect(data.state).toBeInstanceOf(Int32Array)
    expect(Object.keys(w.options).sort()).toEqual(['env', 'eval', 'workerData'])
    expect(w.unrefd).toBe(true)
  })

  it('answers with the worker\'s message, keeping only the fields it knows, and never rejects', async () => {
    const a = startFirstStartWorker(REQ)
    h.made[0].emit('message', { exitCode: 0, timedOut: false, startMs: 12.5, stdout: '2.1.296 (Claude Code)\n', extra: 'dropped' })
    expect(await a.result).toEqual({ exitCode: 0, timedOut: false, startMs: 12.5, stdout: '2.1.296 (Claude Code)\n' })
    const b = startFirstStartWorker(REQ)
    h.made[1].emit('message', { exitCode: 'x', timedOut: 'yes', spawnError: 7 })
    expect(await b.result).toEqual({ exitCode: null, timedOut: false })
    const c = startFirstStartWorker(REQ)
    h.made[2].emit('error', new Error('boom'))
    expect(await c.result).toEqual({ exitCode: null, timedOut: false, spawnError: 'worker-failed' })
    const d = startFirstStartWorker(REQ)
    h.made[3].emit('exit', 1)
    expect(await d.result).toEqual({ exitCode: null, timedOut: false, spawnError: 'worker-ended' })
  })

  it('a stop before the program started marks it never to start and sends nothing; once started it asks the worker to end it, bounded', () => {
    const a = startFirstStartWorker(REQ)
    const state = (h.made[0].options.workerData as { state: Int32Array }).state
    a.stop()
    expect(Atomics.load(state, 0)).toBe(3)
    expect(h.made[0].posted).toEqual([])

    const b = startFirstStartWorker(REQ)
    const running = (h.made[1].options.workerData as { state: Int32Array }).state
    Atomics.store(running, 0, 1)
    const t0 = Date.now()
    b.stop()
    const waited = Date.now() - t0
    expect(h.made[1].posted).toEqual(['stop'])
    // Nothing ends it here, so the wait runs to its bound and no further.
    expect(waited).toBeGreaterThanOrEqual(400)
    expect(waited).toBeLessThan(2_000)

    const c = startFirstStartWorker(REQ)
    const done = (h.made[2].options.workerData as { state: Int32Array }).state
    Atomics.store(done, 0, 2)
    const t1 = Date.now()
    c.stop()
    expect(h.made[2].posted).toEqual(['stop'])
    expect(Date.now() - t1).toBeLessThan(200)
  })
})
