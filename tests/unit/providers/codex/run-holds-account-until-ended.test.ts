// [host] A Codex run holds its account until what is left of it has ended.
// A review (and Sentinel's analysis), an Insights report and a cloud agent
// whose codex exited on its own, while the step that ends what it left was
// still under way at the runner's bound, return `killSettled` whatever the
// outcome (a completed run, a failed one, one stopped after codex had
// exited), so the caller holding the account's lease lets go only once that
// step has ended.
//
// PURE: an injected spawn returning a scripted child and an injected kill
// whose leftovers step ends when the test says so; no process starts, fake
// timers only.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { CODEX_KILL_SETTLE_MS } from '../../../../src/main/providers/codex/cli-runner'
import type { CodexRunDeps } from '../../../../src/main/providers/codex/cli-runner'
import { createCodexReviewOperations, CODEX_EXEC_EXIT_SETTLE_MS } from '../../../../src/main/providers/codex/review'
import { runCodexInsightsExec } from '../../../../src/main/providers/codex/insights-exec'
import { createCodexBackgroundOperations } from '../../../../src/main/providers/codex/agent-run'

class FakeStream extends EventEmitter { setEncoding() { return this } destroy() { return this } }

/** A run whose leftovers step, once codex has exited, runs until `end()`. */
function rig() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new FakeStream(), stderr: new FakeStream(), stdin: { end: vi.fn(), write: vi.fn(), on: vi.fn(), destroy: vi.fn() }, pid: 4545,
  })
  let endStep: (() => void) | null = null
  const leftovers = vi.fn(() => new Promise<void>((res) => { endStep = res }))
  const killTree = Object.assign(async () => {}, { leftovers })
  const deps: CodexRunDeps = { spawn: (() => child as unknown as ChildProcess) as never, platform: 'win32', killTree: killTree as never }
  return { child, deps, leftovers, end: () => endStep?.() }
}

/** Watches a promise without awaiting it. */
function watch(p: Promise<void>) {
  const s = { done: false }
  void p.then(() => { s.done = true })
  return s
}

const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'
const REPLY = jsonl(
  { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'the reply' } },
  { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
)
const ENV = { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\res\\codex-realms\\realm-1' }
const EXE = 'C:\\Tools\\codex.exe'

/** Codex exits with `code` after printing `out`; the run settles at the
 *  runner's bound with the leftovers step still under way. `stopAfterExit`:
 *  a stop comes after codex had exited, before the run settles. */
async function settleWithStepUnderWay<R extends { killSettled?: Promise<void> }>(
  start: (deps: CodexRunDeps, signal: AbortSignal) => Promise<R>, code: number, out: string, stopAfterExit = false,
) {
  const { child, deps, leftovers, end } = rig()
  const ac = new AbortController()
  const p = start(deps, ac.signal)
  await vi.advanceTimersByTimeAsync(0)
  child.stdout.emit('data', out)
  child.emit('exit', code, null)
  if (stopAfterExit) {
    await vi.advanceTimersByTimeAsync(500)
    ac.abort()
  }
  await vi.advanceTimersByTimeAsync(CODEX_EXEC_EXIT_SETTLE_MS + CODEX_KILL_SETTLE_MS + 10)
  const r = await p
  expect(leftovers).toHaveBeenCalledTimes(1)
  return { r, end }
}

/** `killSettled` is carried, and resolves only once the leftovers step ends. */
async function heldUntilTheStepEnds(r: { killSettled?: Promise<void> }, end: () => void, tag: string) {
  expect(r.killSettled, tag).toBeInstanceOf(Promise)
  const settled = watch(r.killSettled!)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(settled.done, tag).toBe(false)
  end()
  await vi.advanceTimersByTimeAsync(0)
  expect(settled.done, tag).toBe(true)
}

afterEach(() => { vi.useRealTimers() })

describe('a Codex run whose codex exited while what it left is still being ended carries killSettled whatever the outcome [host]', () => {
  it('a review or an analysis: a completed one and a failed one each carry it, held until what is left of the run has ended [host]', async () => {
    vi.useFakeTimers()
    for (const purpose of ['review', 'analysis'] as const) {
      const ops = (deps: CodexRunDeps) => createCodexReviewOperations({ platform: 'win32', runDeps: () => deps })
      const run = (deps: CodexRunDeps, signal: AbortSignal) => ops(deps).run({ executable: EXE, env: ENV, cwd: 'D:\\work\\proj', prompt: 'Review this.', timeoutMs: 600_000, signal, purpose })
      const ok = await settleWithStepUnderWay(run, 0, REPLY)
      expect(ok.r, purpose).toMatchObject({ ok: true })
      await heldUntilTheStepEnds(ok.r, ok.end, `${purpose} ok`)
      const failed = await settleWithStepUnderWay(run, 1, '')
      expect(failed.r, purpose).toMatchObject({ ok: false, code: 'failed' })
      await heldUntilTheStepEnds(failed.r, failed.end, `${purpose} failed`)
      const none = await settleWithStepUnderWay(run, 0, '')
      expect(none.r, purpose).toMatchObject({ ok: false, code: 'no-output' })
      await heldUntilTheStepEnds(none.r, none.end, `${purpose} no reply`)
    }
  })

  it('an Insights report: a completed one and a failed one each carry it, held until what is left of the run has ended [host]', async () => {
    vi.useFakeTimers()
    const run = (deps: CodexRunDeps, signal: AbortSignal) => runCodexInsightsExec({ executable: EXE, env: ENV, cwd: 'D:\\res\\insights\\.runs\\ccc-insights-codex-ab', prompt: 'THE PROMPT', signal }, { platform: 'win32', runDeps: () => deps })
    const ok = await settleWithStepUnderWay(run, 0, REPLY)
    expect(ok.r).toMatchObject({ ok: true, text: 'the reply' })
    await heldUntilTheStepEnds(ok.r, ok.end, 'ok')
    const failed = await settleWithStepUnderWay(run, 1, '')
    expect(failed.r).toMatchObject({ ok: false, code: 'failed' })
    await heldUntilTheStepEnds(failed.r, failed.end, 'failed')
    const none = await settleWithStepUnderWay(run, 0, '')
    expect(none.r).toMatchObject({ ok: false, code: 'no-output' })
    await heldUntilTheStepEnds(none.r, none.end, 'no reply')
  })

  it('a cloud agent: a completed one, a failed one and one stopped after codex had exited each carry it, held until what is left of the run has ended [host]', async () => {
    vi.useFakeTimers()
    const run = (deps: CodexRunDeps, signal: AbortSignal) => createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps })
      .run({ executable: EXE, env: ENV, cwd: 'D:\\work\\proj', prompt: 'Tidy the imports.', skipPermissions: false, signal })
    const ok = await settleWithStepUnderWay(run, 0, REPLY)
    expect(ok.r).toMatchObject({ ok: true })
    await heldUntilTheStepEnds(ok.r, ok.end, 'ok')
    const failed = await settleWithStepUnderWay(run, 1, '')
    expect(failed.r).toMatchObject({ ok: false, code: 'failed' })
    await heldUntilTheStepEnds(failed.r, failed.end, 'failed')
    // A Stop after codex had exited on its own: its own exit code stands.
    const stoppedOk = await settleWithStepUnderWay(run, 0, REPLY, true)
    expect(stoppedOk.r).toMatchObject({ ok: true })
    await heldUntilTheStepEnds(stoppedOk.r, stoppedOk.end, 'stopped after exit 0')
    const stoppedFailed = await settleWithStepUnderWay(run, 1, '', true)
    expect(stoppedFailed.r).toMatchObject({ ok: false, code: 'failed' })
    await heldUntilTheStepEnds(stoppedFailed.r, stoppedFailed.end, 'stopped after exit 1')
  })
})
