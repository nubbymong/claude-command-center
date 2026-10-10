// [host] The failure text of a Codex Insights run, a Codex cloud agent and a
// Codex analysis hides a URL's password and a session value at every place
// that text is made: the tail of what Codex printed on stderr, Codex's own
// error event, a start that failed, and the line Codex gives when it cannot
// reach its model. Each case plants both in the one route it drives and
// checks the message that route returns, so a route that stops hiding them
// fails here even while the shared redactor's own tests pass. Synthetic
// values only; a fake spawn records what would run; no process starts.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { CodexRunDeps } from '../../../../src/main/providers/codex/cli-runner'
import { runCodexInsightsExec } from '../../../../src/main/providers/codex/insights-exec'
import { createCodexBackgroundOperations } from '../../../../src/main/providers/codex/agent-run'
import { createCodexReviewOperations, CODEX_UNREACHABLE_PREFIX } from '../../../../src/main/providers/codex/review'

class FakeChild extends EventEmitter {
  pid = 4646
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { end: vi.fn(), write: vi.fn(), on: vi.fn() }
}
function fakeDeps(platform: NodeJS.Platform) {
  const spawned: FakeChild[] = []
  const deps: CodexRunDeps = {
    platform,
    spawn: (() => { const child = new FakeChild(); spawned.push(child); return child }) as never,
    killTree: (c) => { queueMicrotask(() => c.emit('exit', null, 'SIGKILL')) },
  }
  return { deps, spawned }
}
const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'

// Synthetic values, assembled here so no whole one sits in the source.
const PASSWORD = ['synth', 'pw', '7f3a9c'].join('-')
const SESSION = ['synth', 'session', '91b2e4'].join('-')
const HOST = 'api.synthetic.example'
const URL_LINE = `error sending request for url (https://svc:${PASSWORD}@${HOST}/v1/responses)`
const COOKIE_LINE = `Cookie: session_id=${SESSION}`
const BOTH = `${URL_LINE}; ${COOKIE_LINE}`

/** Neither planted value is in the message, and the message still carries
 *  the line it came from (so the route under test is the one that ran). */
function hidesBoth(r: { ok: boolean; message?: string }, prefix: string): void {
  expect(r.ok).toBe(false)
  const m = String(r.message)
  expect(m.startsWith(prefix), m).toBe(true)
  expect(m).toContain(HOST)
  expect(m).not.toContain(PASSWORD)
  expect(m).not.toContain(SESSION)
}

describe('a Codex Insights run hides credentials in its failure text', () => {
  const ENV = { PATH: '/usr/bin', HOME: '/tmp/realm-home' }
  async function run(feed: (c: FakeChild) => void) {
    const { deps, spawned } = fakeDeps('linux')
    const p = runCodexInsightsExec({ executable: '/usr/bin/codex', env: ENV, cwd: '/res/insights/.insights-codex-runs/ccc-insights-codex-ab', prompt: 'P' }, { platform: 'linux', runDeps: () => deps })
    await Promise.resolve()
    expect(spawned).toHaveLength(1)
    feed(spawned[0])
    return p
  }

  it('in the tail of what Codex printed on stderr before it failed', async () => {
    const r = await run((c) => { c.stderr.emit('data', `${URL_LINE}\n${COOKIE_LINE}\n`); c.emit('close', 1) })
    hidesBoth(r, 'Codex exited with code 1: ')
  })

  it("in Codex's own error event of a failed run", async () => {
    const r = await run((c) => { c.stdout.emit('data', jsonl({ type: 'turn.failed', error: { message: BOTH } })); c.emit('close', 1) })
    hidesBoth(r, 'Codex exited with code 1: ')
  })

  it('in the reason Codex could not be started', async () => {
    const r = await run((c) => { c.emit('error', new Error(BOTH)) })
    hidesBoth(r, 'Codex could not be started: ')
  })

  it('in the line Codex gives when it cannot reach its model', async () => {
    const r = await run((c) => { c.stdout.emit('data', jsonl({ type: 'error', message: `Reconnecting... waiting for network (${BOTH})` })) })
    hidesBoth(r, 'Codex could not reach its model: ')
  })
})

describe('a Codex cloud agent hides credentials in its failure text', () => {
  it('in the tail of what Codex printed on stderr before it failed', async () => {
    const { deps, spawned } = fakeDeps('win32')
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run({
      executable: 'C:\\Tools\\codex.exe', cwd: 'D:\\work\\proj', prompt: 'Tidy the imports.', skipPermissions: false,
      env: { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' },
    })
    await Promise.resolve()
    expect(spawned).toHaveLength(1)
    spawned[0].stderr.emit('data', `${URL_LINE}\n${COOKIE_LINE}\n`)
    spawned[0].emit('close', 1)
    hidesBoth(await p, 'Codex exited with code 1: ')
  })
})

describe('a Codex analysis hides credentials in its failure text', () => {
  it('in the line Codex gives when it cannot reach its model', async () => {
    const { deps, spawned } = fakeDeps('win32')
    const p = createCodexReviewOperations({ platform: 'win32', runDeps: () => deps }).run({
      executable: 'C:\\Tools\\codex.exe', cwd: 'D:\\runs\\ccc-sentinel-codex-x', prompt: 'Analyse these notes.', timeoutMs: 180_000,
      env: { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' }, purpose: 'analysis',
    })
    expect(spawned).toHaveLength(1)
    spawned[0].stdout.emit('data', jsonl({ type: 'error', message: `Reconnecting... waiting for network (${BOTH})` }))
    hidesBoth(await p, `${CODEX_UNREACHABLE_PREFIX}: `)
  })
})
