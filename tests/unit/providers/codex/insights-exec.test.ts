// [host] WP2 PR 4, P4.7 (row 68): a Codex Insights report's one model run.
// Sentinel's text-only analysis form, with one change, no --ephemeral
// (mockup D13): no tool that runs a command, browses or connects anything,
// web search off, none of the account's config, rules or AGENTS.md, no -m,
// and no path in the argv; the material on stdin, the run in the folder made
// for it. A fake spawn records what would run; no process starts.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { codexCommandLine } from '../../../../src/main/providers/codex/cli-runner'
import type { CodexRunDeps } from '../../../../src/main/providers/codex/cli-runner'
import { runCodexInsightsExec } from '../../../../src/main/providers/codex/insights-exec'

class FakeChild extends EventEmitter {
  pid = 4343
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { end: vi.fn(), write: vi.fn(), on: vi.fn() }
}
function fakeDeps() {
  const spawned: Array<{ child: FakeChild; file: string; args: readonly string[]; opts: Record<string, unknown> }> = []
  const deps: CodexRunDeps = {
    platform: 'linux',
    spawn: ((file: string, args: readonly string[], opts: Record<string, unknown>) => {
      const child = new FakeChild()
      spawned.push({ child, file, args, opts })
      return child
    }) as never,
    killTree: (c) => { queueMicrotask(() => c.emit('exit', null, 'SIGKILL')) },
  }
  return { deps, spawned }
}
const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'
const ENV = { PATH: '/usr/bin', HOME: '/tmp/realm-home', CODEX_HOME: '/res/codex-realms/r1' }

describe("the report's argv (cli-runner, `insights`)", () => {
  const analysis = codexCommandLine('/usr/bin/codex', 'analysis', 'linux', {})
  const insights = codexCommandLine('/usr/bin/codex', 'insights', 'linux', {})
  const argsOf = (c: typeof insights) => ('refused' in c ? [] : c.args)

  it("is the analysis form less --ephemeral, and nothing else (D13) [host]", () => {
    expect(argsOf(analysis)).toContain('--ephemeral')
    expect(argsOf(insights)).not.toContain('--ephemeral')
    expect(argsOf(insights)).toEqual(argsOf(analysis).filter((a) => a !== '--ephemeral'))
  })

  it('read-only, no shell or other tools, no user config or rules, web search off, no -m, the prompt on stdin [host]', () => {
    const a = argsOf(insights)
    expect(a.slice(0, 2)).toEqual(['exec', '--json'])
    expect(a[a.indexOf('--sandbox') + 1]).toBe('read-only')
    for (const f of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use', 'multi_agent', 'hooks', 'code_mode', 'code_mode_host']) {
      expect(a.flatMap((x, i) => (a[i - 1] === '--disable' ? [x] : []))).toContain(f)
    }
    expect(a).toEqual(expect.arrayContaining(['--ignore-user-config', '--ignore-rules', 'web_search=disabled', 'project_doc_max_bytes=0']))
    expect(a).not.toContain('-m')
    expect(a[a.length - 1]).toBe('-')
    // No element is a path (9.6 item 20): every one is a constant flag or value.
    expect(a.some((x) => /[\\/]/.test(x) && x !== '-')).toBe(false)
  })
})

describe('runCodexInsightsExec', () => {
  it('runs in the folder it is given, the prompt on stdin, and returns the last agent message [host]', async () => {
    const { deps, spawned } = fakeDeps()
    const p = runCodexInsightsExec({ executable: '/usr/bin/codex', env: ENV, cwd: '/res/insights/.insights-codex-runs/ccc-insights-codex-ab', prompt: 'THE PROMPT' }, { platform: 'linux', runDeps: () => deps })
    await Promise.resolve()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].opts.cwd).toBe('/res/insights/.insights-codex-runs/ccc-insights-codex-ab')
    expect(spawned[0].args).not.toContain('THE PROMPT')
    spawned[0].child.stdout.emit('data', jsonl(
      { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'first' } },
      { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: '{"ok":1}' } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } },
    ))
    spawned[0].child.emit('close', 0)
    const r = await p
    expect(r).toMatchObject({ ok: true, text: '{"ok":1}', usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 } })
    expect(spawned[0].child.stdin.end).toHaveBeenCalledWith('THE PROMPT')
  })

  it('a failed run says why; no reply is "no-output"; a waiting-for-network line ends it [host]', async () => {
    let { deps, spawned } = fakeDeps()
    let p = runCodexInsightsExec({ executable: '/usr/bin/codex', env: ENV, cwd: '/r/x', prompt: 'p' }, { platform: 'linux', runDeps: () => deps })
    await Promise.resolve()
    spawned[0].child.stdout.emit('data', jsonl({ type: 'turn.failed', error: { message: 'usage limit reached' } }))
    spawned[0].child.emit('close', 1)
    expect(await p).toMatchObject({ ok: false, code: 'failed', message: 'Codex exited with code 1: usage limit reached.' })
    ;({ deps, spawned } = fakeDeps())
    p = runCodexInsightsExec({ executable: '/usr/bin/codex', env: ENV, cwd: '/r/x', prompt: 'p' }, { platform: 'linux', runDeps: () => deps })
    await Promise.resolve()
    spawned[0].child.emit('close', 0)
    expect(await p).toMatchObject({ ok: false, code: 'no-output' })
    ;({ deps, spawned } = fakeDeps())
    p = runCodexInsightsExec({ executable: '/usr/bin/codex', env: ENV, cwd: '/r/x', prompt: 'p' }, { platform: 'linux', runDeps: () => deps })
    await Promise.resolve()
    spawned[0].child.stdout.emit('data', jsonl({ type: 'error', message: 'Reconnecting... waiting for network (x)' }))
    const r = await p
    expect(r).toMatchObject({ ok: false, code: 'failed' })
    if (!r.ok) expect(r.message).toMatch(/^Codex could not reach its model/)
  })

  it('an executable that is not absolute is refused before anything runs [host]', async () => {
    const { deps, spawned } = fakeDeps()
    const r = await runCodexInsightsExec({ executable: 'codex', env: ENV, cwd: '/r/x', prompt: 'p' }, { platform: 'linux', runDeps: () => deps })
    expect(r).toMatchObject({ ok: false, code: 'not-started' })
    expect(spawned).toHaveLength(0)
  })
})
