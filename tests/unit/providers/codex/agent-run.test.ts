// [host] WP2 PR 4, P4.5 (row 57): a Cloud Agent on Codex is one `codex exec`
// through the CLI runner, from a prepared launch: PB5's argv without `-C`
// (the project is the working folder, as the reviewer's run is), the task on
// stdin, each permission choice mapped as section 10's question 7 builds its
// default A (default: read-only; skip-permissions: Auto's workspace-write),
// never danger-full-access or a sandbox bypass, no --ephemeral and no
// --ignore-user-config; the model and effort held to the launch's own rules
// and the runner's PLAIN_ARG; a network-path project refused on the npm
// `.cmd` route. The JSONL is read as it streams: each agent message is handed
// on, stderr is handed on (a refused edit shows only there), usage is summed
// and priced. PURE: no process is started (the runner's spawn is faked).
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  codexAgentArgs, codexAgentCommandLine, codexAgentSandbox, createCodexBackgroundOperations, CODEX_AGENT_EFFORTS, CODEX_AGENT_TIMEOUT_MS,
} from '../../../../src/main/providers/codex/agent-run'
import { CODEX_EFFORTS } from '../../../../src/main/sanitize-restored-spawn-options'
import type { CodexRunDeps } from '../../../../src/main/providers/codex/cli-runner'
import { CODEX_EXEC_EXIT_SETTLE_MS } from '../../../../src/main/providers/codex/review'

const fixture = (version: string, name: string) => readFileSync(join(__dirname, `../../../fixtures/codex/cli/${version}/${name}`), 'utf8')
const PLAIN_ARG = /^[A-Za-z0-9._,:=/[\]-]+$/

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { end: vi.fn(), on: vi.fn() }
}

function fakeDeps(platform: NodeJS.Platform = 'win32') {
  const spawned: Array<{ file: string; args: readonly string[]; opts: Record<string, unknown>; child: FakeChild }> = []
  const scopes: unknown[] = []
  const deps: CodexRunDeps = {
    platform,
    spawn: ((file: string, args: readonly string[], opts: Record<string, unknown>) => {
      const child = new FakeChild()
      spawned.push({ file, args, opts, child })
      return child
    }) as never,
    killTree: ((c: EventEmitter, o?: { scope?: string }) => { scopes.push(o?.scope); queueMicrotask(() => c.emit('exit', null, 'SIGKILL')) }) as never,
  }
  return { deps, spawned, scopes }
}

const ENV = { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\res\\codex-realms\\realm-1', CCC_SESSION: 'x', CONDUCTOR_MCP_TOKEN: 'y' }
const input = (over: Record<string, unknown> = {}) => ({
  executable: 'C:\\Tools\\codex.exe', env: ENV, cwd: 'D:\\work\\proj', prompt: 'Tidy the imports.', skipPermissions: false, ...over,
})

describe('the argv (PB5; question 7, default A)', () => {
  it('the default runs read-only, skip-permissions runs Auto: workspace-write; never danger-full-access', () => {
    expect(codexAgentSandbox(false)).toBe('read-only')
    expect(codexAgentSandbox(true)).toBe('workspace-write')
    expect(codexAgentSandbox('yes' as never)).toBe('read-only')
    expect(codexAgentArgs({ sandbox: 'read-only' })).toEqual(['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '-'])
    expect(codexAgentArgs({ sandbox: 'workspace-write', model: 'gpt-5.5', effort: 'high' }))
      .toEqual(['exec', '--json', '-m', 'gpt-5.5', '-c', 'model_reasoning_effort=high', '-s', 'workspace-write', '--skip-git-repo-check', '-'])
    for (const bad of ['danger-full-access', 'workspace_write', '', undefined, null]) {
      expect(codexAgentArgs({ sandbox: bad }), String(bad)).toHaveProperty('refused')
    }
  })

  it('no path, no --ephemeral, no --ignore-user-config, no -C, no sandbox bypass; every element passes PLAIN_ARG', () => {
    for (const sandbox of ['read-only', 'workspace-write'] as const) {
      const args = codexAgentArgs({ sandbox, model: 'gpt-oss:20b', effort: 'xhigh' }) as string[]
      for (const a of args) expect(PLAIN_ARG.test(a), a).toBe(true)
      for (const never of ['--ephemeral', '--ignore-user-config', '-C', '--cd', '--dangerously-bypass-approvals-and-sandbox', '--full-auto', '--yolo', 'danger-full-access']) {
        expect(args).not.toContain(never)
      }
      // No element is a path: no backslash, no drive, no leading slash.
      expect(args.filter((a) => a.includes('\\') || /^[A-Za-z]:/.test(a) || a.startsWith('/'))).toEqual([])
      expect(args.at(-1)).toBe('-')
    }
  })

  it('the model and the effort: absent or empty pass nothing, effort none passes nothing; anything else outside the launch rules is refused', () => {
    expect(codexAgentArgs({ sandbox: 'read-only', model: '', effort: 'none' })).toEqual(['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '-'])
    for (const model of ['-rf', 'gpt 5', 'gpt-5.5;calc', 'a&b', 'x'.repeat(65), '/abs', 7]) {
      expect(codexAgentArgs({ sandbox: 'read-only', model }), String(model)).toHaveProperty('refused')
    }
    for (const effort of ['HIGH', 'extreme', 'high ', 'high&calc', 3]) {
      expect(codexAgentArgs({ sandbox: 'read-only', effort }), String(effort)).toHaveProperty('refused')
    }
  })

  it("the efforts are the launch's own list less 'none'", () => {
    expect([...CODEX_AGENT_EFFORTS]).toEqual(CODEX_EFFORTS.filter((e) => e !== 'none'))
  })

  it('every flag is one both supported CLIs list for exec', () => {
    for (const version of ['0.153.4', '0.155.1']) {
      const help = fixture(version, 'help/exec-help.txt')
      for (const flag of ['--json', '-m, --model', '-c, --config', '-s, --sandbox', '--skip-git-repo-check']) expect(help, `${version} ${flag}`).toContain(flag)
      for (const level of ['read-only', 'workspace-write']) expect(help, `${version} ${level}`).toContain(level)
    }
  })

  it('the command line: direct on an executable, through cmd.exe verbatim for an npm shim', () => {
    const direct = codexAgentCommandLine('C:\\Tools\\codex.exe', { sandbox: 'read-only' }, 'win32', { SystemRoot: 'C:\\Windows' })
    expect(direct).toMatchObject({ file: 'C:\\Tools\\codex.exe', verbatim: false, args: ['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '-'] })
    const shim = codexAgentCommandLine('C:\\npm\\codex.cmd', { sandbox: 'workspace-write', model: 'gpt-5.5' }, 'win32', { SystemRoot: 'C:\\Windows' })
    expect(shim).toMatchObject({ file: 'C:\\Windows\\System32\\cmd.exe', verbatim: true })
    expect((shim as { args: string[] }).args.at(-1)).toBe('""C:\\npm\\codex.cmd" exec --json -m gpt-5.5 -s workspace-write --skip-git-repo-check -"')
    expect(codexAgentCommandLine('codex.exe', { sandbox: 'read-only' }, 'win32', { SystemRoot: 'C:\\Windows' })).toHaveProperty('refused')
  })
})

describe('the run', () => {
  it('runs in the project as its working folder, the task on stdin, no shell, the Conductor variables removed, no deadline of its own', async () => {
    const { deps, spawned } = fakeDeps()
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input())
    const s = spawned[0]
    expect(s.file).toBe('C:\\Tools\\codex.exe')
    expect(s.args).toEqual(['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '-'])
    expect(s.opts).toMatchObject({ cwd: 'D:\\work\\proj', shell: false, windowsHide: true })
    const env = s.opts.env as Record<string, string>
    expect(env.CODEX_HOME).toBe(ENV.CODEX_HOME)
    expect(env.CCC_SESSION).toBeUndefined()
    expect(env.CONDUCTOR_MCP_TOKEN).toBeUndefined()
    expect(s.child.stdin.end).toHaveBeenCalledWith('Tidy the imports.')
    s.child.emit('exit', 0)
    s.child.emit('close', 0)
    expect(await p).toEqual({ ok: true })
    expect(CODEX_AGENT_TIMEOUT_MS).toBe(2_147_483_647)
  })

  it('skip-permissions runs workspace-write; the model and effort reach the argv', async () => {
    const { deps, spawned } = fakeDeps()
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ skipPermissions: true, model: 'gpt-5.5', effort: 'medium' }))
    expect(spawned[0].args).toEqual(['exec', '--json', '-m', 'gpt-5.5', '-c', 'model_reasoning_effort=medium', '-s', 'workspace-write', '--skip-git-repo-check', '-'])
    spawned[0].child.emit('close', 0)
    await p
  })

  for (const version of ['0.153.4', '0.155.1']) {
    for (const name of ['exec-json.jsonl', 'exec-edit-json.jsonl']) {
      it(`${version} ${name}: every agent message handed on in order, usage summed and priced`, async () => {
        const { deps, spawned } = fakeDeps()
        const texts: string[] = []
        const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ model: 'gpt-5.5', onText: (t: string) => texts.push(t) }))
        const jsonl = fixture(version, name)
        // Split mid-line, as a pipe delivers it.
        const cut = Math.floor(jsonl.length / 2)
        spawned[0].child.stdout.emit('data', jsonl.slice(0, cut))
        spawned[0].child.stdout.emit('data', jsonl.slice(cut))
        spawned[0].child.emit('close', 0)
        const r = await p
        const expected = jsonl.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
          .filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text)
        expect(expected.length).toBeGreaterThan(0)
        expect(texts).toEqual(expected)
        const usage = jsonl.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'turn.completed').usage
        expect(r).toMatchObject({ ok: true, usage: { inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens, outputTokens: usage.output_tokens } })
        expect(typeof (r as { costUsd?: number }).costUsd).toBe('number')
      })
    }
  }

  it('no model named: no cost (Codex chose the model), tokens still kept', async () => {
    const { deps, spawned } = fakeDeps()
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input())
    spawned[0].child.stdout.emit('data', fixture('0.155.1', 'exec-json.jsonl'))
    spawned[0].child.emit('close', 0)
    const r = await p
    expect(r.ok && r.usage?.inputTokens).toBeGreaterThan(0)
    expect(r).not.toHaveProperty('costUsd')
  })

  it('stderr is handed on as it arrives (a refused edit exits 0 and shows only there)', async () => {
    const { deps, spawned } = fakeDeps()
    const said: string[] = []
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ onDiagnostic: (t: string) => said.push(t) }))
    spawned[0].child.stderr.emit('data', 'patch rejected: writing is blocked by read-only sandbox\n')
    spawned[0].child.emit('close', 0)
    expect(await p).toEqual({ ok: true })
    expect(said).toEqual(['patch rejected: writing is blocked by read-only sandbox\n'])
  })

  it('a callback that throws never breaks the run', async () => {
    const { deps, spawned } = fakeDeps()
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ onText: () => { throw new Error('boom') }, onDiagnostic: () => { throw new Error('boom') } }))
    spawned[0].child.stdout.emit('data', fixture('0.155.1', 'exec-json.jsonl'))
    spawned[0].child.stderr.emit('data', 'warn\n')
    spawned[0].child.emit('close', 0)
    expect((await p).ok).toBe(true)
  })

  it('a non-zero exit fails with the event error, redacted; else the stderr tail', async () => {
    const { deps, spawned } = fakeDeps()
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input())
    spawned[0].child.stdout.emit('data', JSON.stringify({ type: 'turn.failed', error: { message: 'quota for sk-proj-' + 'Q'.repeat(40) } }) + '\n')
    spawned[0].child.emit('close', 1)
    const r = await p
    expect(r).toMatchObject({ ok: false, code: 'failed' })
    expect(r.ok ? '' : r.message).toMatch(/^Codex exited with code 1: quota for /)
    expect(r.ok ? '' : r.message).not.toContain('Q'.repeat(40))
    const two = fakeDeps()
    const q = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => two.deps }).run(input())
    two.spawned[0].child.stderr.emit('data', 'Not inside a trusted directory\n')
    two.spawned[0].child.emit('close', 1)
    expect(await q).toMatchObject({ ok: false, code: 'failed', message: 'Codex exited with code 1: Not inside a trusted directory.' })
  })

  it('a stop takes the whole tree below codex and says cancelled', async () => {
    const { deps, spawned, scopes } = fakeDeps()
    const ac = new AbortController()
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ signal: ac.signal }))
    expect(spawned).toHaveLength(1)
    ac.abort()
    expect(await p).toMatchObject({ ok: false, code: 'cancelled' })
    expect(scopes).toEqual(['tree'])
  })

  // [host] PR 4 review C-2: a Stop in the settle window after codex exited
  // on its own read as cancelled, for a run that had finished.
  it('a Stop that comes after codex has exited on its own (the settle window) keeps the run\'s own result: completed on 0, failed with its reason otherwise', async () => {
    vi.useFakeTimers()
    try {
      const { deps, spawned, scopes } = fakeDeps()
      const ac = new AbortController()
      const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ signal: ac.signal }))
      spawned[0].child.stdout.emit('data', fixture('0.155.1', 'exec-json.jsonl'))
      spawned[0].child.emit('exit', 0)
      ac.abort()
      await vi.advanceTimersByTimeAsync(0)
      const r = await p
      expect(r.ok).toBe(true)
      expect(r).not.toHaveProperty('code')
      // Nothing was killed by pid: the root had exited.
      expect(scopes).toEqual([])
      const two = fakeDeps()
      const ac2 = new AbortController()
      const q = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => two.deps }).run(input({ signal: ac2.signal }))
      two.spawned[0].child.stderr.emit('data', 'Not inside a trusted directory\n')
      two.spawned[0].child.emit('exit', 1)
      ac2.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(await q).toMatchObject({ ok: false, code: 'failed', message: 'Codex exited with code 1: Not inside a trusted directory.' })
    } finally { vi.useRealTimers() }
  })

  // [host] PR 4 review C-5: exit 0 after a failed turn with no reply left no
  // trace. The status still follows the exit code (Claude parity).
  it('exit 0 after a failed turn with no reply: completed, with the reason kept in the output, redacted; a reply, or no error, adds nothing', async () => {
    const { deps, spawned } = fakeDeps()
    const said: string[] = []
    const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input({ onDiagnostic: (t: string) => said.push(t) }))
    spawned[0].child.stderr.emit('data', 'warn: retrying')
    spawned[0].child.stdout.emit('data', JSON.stringify({ type: 'turn.failed', error: { message: 'quota for sk-proj-' + 'Q'.repeat(40) } }) + '\n')
    spawned[0].child.emit('close', 0)
    expect(await p).toEqual({ ok: true })
    expect(said).toHaveLength(2)
    expect(said[0]).toBe('warn: retrying')
    expect(said[1]).toMatch(/^\nCodex reported an error and gave no reply: quota for .*\n$/)
    expect(said[1]).not.toContain('Q'.repeat(40))
    const replied = fakeDeps()
    const told: string[] = []
    const q = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => replied.deps }).run(input({ onDiagnostic: (t: string) => told.push(t) }))
    replied.spawned[0].child.stdout.emit('data', JSON.stringify({ type: 'error', message: 'reconnecting' }) + '\n' + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }) + '\n')
    replied.spawned[0].child.emit('close', 0)
    expect(await q).toEqual({ ok: true })
    expect(told).toEqual([])
    const clean = fakeDeps()
    const none: string[] = []
    const c = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => clean.deps }).run(input({ onDiagnostic: (t: string) => none.push(t) }))
    clean.spawned[0].child.emit('close', 0)
    expect(await c).toEqual({ ok: true })
    expect(none).toEqual([])
  })

  it('settles soon after codex exits while something it started holds the pipes', async () => {
    vi.useFakeTimers()
    try {
      const { deps, spawned } = fakeDeps()
      const p = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input())
      spawned[0].child.stdout.emit('data', fixture('0.155.1', 'exec-json.jsonl'))
      spawned[0].child.emit('exit', 0)
      await vi.advanceTimersByTimeAsync(CODEX_EXEC_EXIT_SETTLE_MS + 10)
      expect((await p).ok).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('a project on a network path is refused on the npm .cmd route, before anything starts; allowed directly', async () => {
    const shim = fakeDeps()
    const r = await createCodexBackgroundOperations({ platform: 'win32', runDeps: () => shim.deps }).run(input({ executable: 'C:\\npm\\codex.cmd', cwd: '\\\\server\\share\\proj' }))
    expect(r).toMatchObject({ ok: false, code: 'not-started' })
    expect(r.ok ? '' : r.message).toMatch(/network path/)
    expect(shim.spawned).toHaveLength(0)
    const direct = fakeDeps()
    const q = createCodexBackgroundOperations({ platform: 'win32', runDeps: () => direct.deps }).run(input({ cwd: '\\\\server\\share\\proj' }))
    expect(direct.spawned[0].opts.cwd).toBe('\\\\server\\share\\proj')
    direct.spawned[0].child.emit('close', 0)
    await q
  })

  it('a project that is not a full path, a refused model or no task starts nothing', async () => {
    for (const over of [{ cwd: 'proj' }, { cwd: '\\proj' }, { cwd: '' }, { cwd: '\\\\?\\C:\\proj' }, { model: 'bad model' }, { effort: 'max&x' }, { prompt: undefined }, { executable: 'codex' }]) {
      const { deps, spawned } = fakeDeps()
      const r = await createCodexBackgroundOperations({ platform: 'win32', runDeps: () => deps }).run(input(over))
      expect(r, JSON.stringify(over)).toMatchObject({ ok: false, code: 'not-started' })
      expect(spawned).toHaveLength(0)
    }
    const posix = fakeDeps('linux')
    const r = await createCodexBackgroundOperations({ platform: 'linux', runDeps: () => posix.deps }).run(input({ executable: '/usr/bin/codex', cwd: 'rel/proj' }))
    expect(r).toMatchObject({ ok: false, code: 'not-started' })
  })
})
