/**
 * PR 4 (owner answers, the Sentinel chase): a Codex analysis run whose model
 * cannot be reached ends when Codex says it is waiting for the network,
 * instead of at its deadline. [host]
 *
 * The events are the ones Codex 0.153.4 and 0.155.1 printed on the Windows
 * test VM with every proxy a dead loopback port (2026-10-04): five reconnects
 * over WebSockets (to 15.5 s), a fallback to HTTPS (20.5 s), then "Reconnecting...
 * waiting for network" from 33.8 s, every 20 s or so, with no end; Sentinel
 * then waited out its 180 s deadline twice. A fake spawn replays them; no
 * process starts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createCodexReviewOperations } from '../../../src/main/providers/codex'
import { codexWaitingForNetwork, CODEX_UNREACHABLE_PREFIX } from '../../../src/main/providers/codex/review'
import { CODEX_KILL_SETTLE_MS } from '../../../src/main/providers/codex/cli-runner'
import { envelopeError } from '../../../src/main/sentinel/sentinel-analysis'
import { ANALYSIS_UNREACHABLE_WORDS } from '../../../src/shared/sentinel-analysis-contract'
import type { CodexRunDeps } from '../../../src/main/providers/codex'
import type { ReviewRunInput } from '../../../src/main/providers/core'

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { end: vi.fn(), on: vi.fn() }
}
function fakeDeps() {
  const spawned: FakeChild[] = []
  const killed: FakeChild[] = []
  const deps: CodexRunDeps = {
    platform: 'win32',
    spawn: (() => { const c = new FakeChild(); spawned.push(c); return c }) as never,
    killTree: (c) => { killed.push(c as unknown as FakeChild); queueMicrotask(() => c.emit('exit', null, 'SIGKILL')) },
  }
  return { deps, spawned, killed }
}
/** A tree kill still reading a slow process table past CODEX_KILL_SETTLE_MS:
 *  the root lives until `land` is called. */
function slowKillDeps() {
  const spawned: FakeChild[] = []
  let land: (() => void) | null = null
  let exited = false
  const deps: CodexRunDeps = {
    platform: 'win32',
    spawn: (() => { const c = new FakeChild(); spawned.push(c); return c }) as never,
    killTree: (c) => new Promise<void>((res) => { land = () => { exited = true; c.emit('exit', null, 'SIGKILL'); res() } }),
  }
  return { deps, spawned, land: () => land?.(), exited: () => exited }
}
const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'
const REFUSED = 'stream disconnected before completion: No connection could be made because the target machine actively refused it. (os error 10061)'
const BEFORE_FALLBACK = [
  { type: 'thread.started', thread_id: 't' },
  { type: 'item.completed', item: { id: 'e0', type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled.' } },
  { type: 'turn.started' },
  ...[2, 3, 4, 5].map((n) => ({ type: 'error', message: `Reconnecting... ${n}/5 (${REFUSED})` })),
  { type: 'item.completed', item: { id: 'e1', type: 'error', message: `Falling back from WebSockets to HTTPS transport. ${REFUSED}` } },
]
const WAITING = { type: 'error', message: 'Reconnecting... waiting for network (Connection failed: error sending request)' }
const input = (over: Partial<ReviewRunInput> = {}): ReviewRunInput => ({
  executable: 'C:\\Tools\\codex.exe', cwd: 'D:\\runs\\ccc-sentinel-codex-x', prompt: 'Analyse these notes.', timeoutMs: 180_000,
  env: { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\res\\codex-realms\\r1' }, purpose: 'analysis', ...over,
})
const settledYet = async (p: Promise<unknown>) => { let done = false; void p.then(() => { done = true }); for (let i = 0; i < 5; i++) await Promise.resolve(); return done }
const REPLY = [
  { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: '{"breakingChanges": []}' } },
  { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
]

afterEach(() => { vi.useRealTimers() })

describe("a Codex analysis that cannot reach its model (PR 4, the Sentinel chase)", () => {
  it('ends once Codex says it is waiting for the network: failed, said plainly, its tree stopped [host]', async () => {
    const { deps, spawned, killed } = fakeDeps()
    const p = createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run(input())
    spawned[0].stdout.emit('data', jsonl(...BEFORE_FALLBACK))
    expect(await settledYet(p)).toBe(false)
    expect(killed).toHaveLength(0)
    spawned[0].stdout.emit('data', jsonl(WAITING))
    const r = await p
    expect(r).toMatchObject({ ok: false, code: 'failed' })
    if (!r.ok) expect(r.message).toBe('Codex could not reach its model: Reconnecting... waiting for network (Connection failed: error sending request).')
    expect(killed).toEqual([spawned[0]])
  })

  it('a stop whose tree kill is still under way carries killSettled, so Sentinel holds the lease and the folder until it ends [host]', async () => {
    vi.useFakeTimers()
    const { deps, spawned, land, exited } = slowKillDeps()
    const p = createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run(input())
    spawned[0].stdout.emit('data', jsonl(WAITING))
    await vi.advanceTimersByTimeAsync(CODEX_KILL_SETTLE_MS + 10)
    const r = await p
    expect(r).toMatchObject({ ok: false, code: 'failed' })
    const settled = r.ok ? undefined : r.killSettled
    expect(settled).toBeInstanceOf(Promise)
    // Sentinel's Codex runner lets the lease and the folder go once every
    // carried kill has ended (sentinel/index.ts, codexAnalysisRunner end()).
    let released = false
    void Promise.all([settled]).then(() => { released = true })
    await Promise.resolve(); await Promise.resolve()
    expect(exited()).toBe(false)
    expect(released).toBe(false)
    land()
    await vi.advanceTimersByTimeAsync(1)
    expect(released).toBe(true)
  })

  it("the reviewer's own words reach Sentinel's check as unreachable, from one source [host]", async () => {
    expect(CODEX_UNREACHABLE_PREFIX).toContain(ANALYSIS_UNREACHABLE_WORDS)
    const { deps, spawned } = fakeDeps()
    const p = createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run(input())
    spawned[0].stdout.emit('data', jsonl(...BEFORE_FALLBACK, WAITING))
    const r = await p
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message.startsWith(CODEX_UNREACHABLE_PREFIX)).toBe(true)
    // Wrapped as Sentinel's Codex runner wraps a failed run (sentinel/index.ts).
    const env = envelopeError(JSON.stringify({ is_error: true, result: r.message }))
    expect(env).toMatchObject({ unreachable: true, rateLimited: false })
    // The shared words alone are what Sentinel reads, whatever Codex's own text says.
    expect(envelopeError(JSON.stringify({ is_error: true, result: `${CODEX_UNREACHABLE_PREFIX}: no detail.` }))?.unreachable).toBe(true)
  })

  it('a reply already completed is kept: a later waiting-for-the-network line does not end the run [host]', async () => {
    const { deps, spawned, killed } = fakeDeps()
    const p = createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run(input())
    spawned[0].stdout.emit('data', jsonl(...REPLY))
    spawned[0].stdout.emit('data', jsonl(WAITING))
    expect(await settledYet(p)).toBe(false)
    expect(killed).toHaveLength(0)
    spawned[0].emit('close', 0)
    expect(await p).toMatchObject({ ok: true, text: '{"breakingChanges": []}' })
    expect(killed).toHaveLength(0)
  })

  it('a waiting line read only after the run has ended (no final newline) does not undo a finished reply [host]', async () => {
    const { deps, spawned, killed } = fakeDeps()
    const p = createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run(input())
    spawned[0].stdout.emit('data', jsonl(REPLY[0]) + JSON.stringify(WAITING))
    spawned[0].emit('close', 0)
    expect(await p).toMatchObject({ ok: true, text: '{"breakingChanges": []}' })
    expect(killed).toHaveLength(0)
  })

  it('reconnects and the HTTPS fallback alone do not end it: a run that then answers is a reply [host]', async () => {
    const { deps, spawned, killed } = fakeDeps()
    const p = createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run(input())
    spawned[0].stdout.emit('data', jsonl(...BEFORE_FALLBACK, { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: '{"breakingChanges": []}' } }, { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }))
    spawned[0].emit('close', 0)
    expect(await p).toMatchObject({ ok: true, text: '{"breakingChanges": []}' })
    expect(killed).toHaveLength(0)
  })

  it('a review keeps its deadline: the same words do not end it [host]', async () => {
    const { deps, spawned, killed } = fakeDeps()
    const p = createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run(input({ purpose: undefined }))
    spawned[0].stdout.emit('data', jsonl(...BEFORE_FALLBACK, WAITING))
    expect(await settledYet(p)).toBe(false)
    expect(killed).toHaveLength(0)
    spawned[0].emit('close', 1)
    const r = await p
    expect(r).toMatchObject({ ok: false, code: 'failed' })
    if (!r.ok) expect(r.message).not.toMatch(/could not reach its model/)
  })

  it("the caller's own cancel is still a cancel [host]", async () => {
    const { deps, spawned } = fakeDeps()
    const ac = new AbortController()
    const p = createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run(input({ signal: ac.signal }))
    ac.abort()
    spawned[0].stdout.emit('data', jsonl(WAITING))
    expect(await p).toMatchObject({ ok: false, code: 'cancelled' })
  })

  it("only Codex's waiting-for-the-network words are the signal [host]", () => {
    expect(codexWaitingForNetwork(WAITING.message)).toBe(true)
    for (const m of [`Reconnecting... 5/5 (${REFUSED})`, `Falling back from WebSockets to HTTPS transport. ${REFUSED}`, 'unexpected status 401 Unauthorized', '']) expect(codexWaitingForNetwork(m), m).toBe(false)
  })
})
