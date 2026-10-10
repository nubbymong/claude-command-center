// [host] ADR-025: the body of the first-start worker, run for real. The
// program it starts here is a harmless stand-in, this Node itself running a
// one-line script (`node -e`), in a fresh temp folder; it is never Claude Code
// or Codex, and it gets only the variables each case names (never this
// process's environment).
//
// The text is the one the app runs (src/main/first-start-worker.cjs, read
// through first-start-warmup.ts). The test isolation guard refuses an eval
// worker thread (a worker gets builtins the guard has not wrapped), so the
// body runs on this thread here, with the guarded child_process and a stand-in
// for its worker_threads port; the thread itself, the message plumbing and the
// quit's stop are first-start-worker-thread.test.ts's.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FIRST_START_WORKER_SOURCE } from '../../../src/main/first-start-warmup'
import type { FirstStartRequest, FirstStartRun } from '../../../src/main/first-start-warmup'

const nodeRequire = createRequire(import.meta.url)

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ccc-first-start-')) })
afterEach(() => {
  delete process.env.FIRST_START_TEST_LEAK
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Runs the worker's text as the worker would, on this thread: `workerData`
 *  and `parentPort` are the stand-in's, everything else is the real module. */
function runBody(request: unknown, state?: Int32Array) {
  const listeners: Array<(m: unknown) => void> = []
  let resolveAnswer!: (r: FirstStartRun) => void
  const answer = new Promise<FirstStartRun>((r) => { resolveAnswer = r })
  const answers: unknown[] = []
  let closed = false
  const parentPort = {
    on: (ev: string, fn: (m: unknown) => void) => { if (ev === 'message') listeners.push(fn) },
    postMessage: (m: unknown) => { answers.push(m); resolveAnswer(m as FirstStartRun) },
    close: () => { closed = true },
  }
  const fakeRequire = (id: string) => (id === 'node:worker_threads' ? { workerData: { request, ...(state ? { state } : {}) }, parentPort } : nodeRequire(id))
  new Function('require', FIRST_START_WORKER_SOURCE)(fakeRequire)
  return { answer, answers, send: (m: unknown) => { for (const l of listeners) l(m) }, closed: () => closed }
}

/** The stand-in: this Node with a script; only SystemRoot (Windows needs it to start) and what the case adds. */
const request = (script: string, over: Partial<FirstStartRequest> = {}): FirstStartRequest => ({
  file: process.execPath,
  args: ['-e', script],
  env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
  cwd: dir,
  timeoutMs: 10_000,
  killGraceMs: 2_000,
  maxOutput: 4_096,
  ...over,
})
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const pidFile = () => join(dir, 'pid')
const HANG = "require('fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000)"

describe('the first-start worker (ADR-025)', () => {
  it('is the text of src/main/first-start-worker.cjs', () => {
    expect(FIRST_START_WORKER_SOURCE).toBe(readFileSync(resolve(__dirname, '..', '..', '..', 'src', 'main', 'first-start-worker.cjs'), 'utf8'))
  })

  it('starts the program with the arguments, folder and only the variables it was given, and answers once with its exit code', async () => {
    process.env.FIRST_START_TEST_LEAK = 'this process only'
    const script = "process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), mark: process.env.FIRST_START_MARK ?? null, leak: process.env.FIRST_START_TEST_LEAK ?? null }), () => process.exit(7))"
    const run = runBody(request(script, { args: ['-e', script, 'one'], env: { ...request('').env, FIRST_START_MARK: 'given' } }))
    const r = await run.answer
    expect(r).toMatchObject({ exitCode: 7, timedOut: false })
    expect(r.spawnError).toBeUndefined()
    expect(typeof r.startMs).toBe('number')
    const seen = JSON.parse(r.stdout ?? '') as { argv: string[]; cwd: string; mark: string | null; leak: string | null }
    const { cwd, ...rest } = seen
    expect(rest).toEqual({ argv: ['one'], mark: 'given', leak: null })
    // The folder it was given, named as given or as the OS resolves it: on
    // macOS the temp folder's /var/... is a link the child reports as
    // /private/var/..., and on Windows an 8.3 short name may come back long.
    expect([dir, realpathSync.native(dir)].map((p) => p.toLowerCase())).toContain(cwd.toLowerCase())
    await new Promise((res) => setTimeout(res, 700))
    expect(run.answers).toHaveLength(1)
    expect(run.closed()).toBe(true)
  })

  it('keeps no more output than the cap', async () => {
    const r = await runBody(request("process.stdout.write('x'.repeat(100000))", { maxOutput: 1000 })).answer
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('x'.repeat(1000))
  })

  it('ends a program that runs past its time limit and answers timedOut', async () => {
    const r = await runBody(request(HANG, { timeoutMs: 1_500 })).answer
    expect(r).toMatchObject({ exitCode: null, timedOut: true })
    const pid = Number(readFileSync(pidFile(), 'utf8'))
    expect(pid).toBeGreaterThan(0)
    await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false)
  })

  it('answers a program that cannot be started with its error code, never throwing', async () => {
    const r = await runBody(request('', { file: join(dir, 'missing.exe'), args: ['--version'] })).answer
    expect(r).toMatchObject({ exitCode: null, timedOut: false, spawnError: 'ENOENT' })
  })

  it('refuses a request it cannot read, starting nothing', async () => {
    for (const bad of [request(HANG, { timeoutMs: 0 }), { ...request(HANG), args: 'x' }, { ...request(HANG), file: '' }, null]) {
      expect(await runBody(bad).answer, JSON.stringify(bad)).toMatchObject({ exitCode: null, spawnError: 'invalid-request' })
    }
    expect(existsSync(pidFile())).toBe(false)
  })

  it('a stop at quit ends a program that is running, and one stopped before it started is never started', async () => {
    const state = new Int32Array(new SharedArrayBuffer(4))
    const run = runBody(request(HANG), state)
    expect(Atomics.load(state, 0)).toBe(1)
    await expect.poll(() => existsSync(pidFile()), { timeout: 10_000 }).toBe(true)
    const pid = Number(readFileSync(pidFile(), 'utf8'))
    run.send('stop')
    expect(Atomics.load(state, 0)).toBe(2)
    await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false)
    expect((await run.answer).exitCode).toBeNull()

    rmSync(pidFile(), { force: true })
    const stopped = new Int32Array(new SharedArrayBuffer(4))
    Atomics.store(stopped, 0, 3)
    expect(await runBody(request(HANG), stopped).answer).toMatchObject({ spawnError: 'stopped' })
    await new Promise((res) => setTimeout(res, 300))
    expect(existsSync(pidFile())).toBe(false)
  })
})
