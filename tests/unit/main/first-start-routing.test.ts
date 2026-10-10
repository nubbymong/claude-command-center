// [host] ADR-025: each caller that may be the app's first start of a newly
// installed or updated Claude Code or Codex program awaits the first-start
// warm-up before its own start, with the environment its own `--version` run
// is built with. PURE: fake ports, the WP1 accounts harness, nothing started.
//
// Pinned here: Claude's discovery `--version` (which start-up discovery,
// Check again, Add it to PATH and the reviewer's re-proof all run), Codex's
// discovery `--version` (start-up discovery, Check again), and every LOCAL
// launch the accounts service prepares (Codex sessions, reviews and background
// runs, Claude reviews), never one for an SSH session.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createClaudeReviewLaunch } from '../../../src/main/providers/claude'
import type { ClaudeReviewPorts, ClaudeFileStat, ClaudeCliCommand, ClaudeCliRunResult } from '../../../src/main/providers/claude'
import { cliCommandLine, codexShellEnv, discoverCodex } from '../../../src/main/providers/codex'
import type { CodexDiscoveryDeps, CodexRunResult } from '../../../src/main/providers/codex'
import { harness, addCodexAccount, EXE as CODEX_EXE } from '../../wp1/accounts-harness'

const EXE = 'C:\\Users\\u\\.local\\bin\\claude.exe'
const STAT: ClaudeFileStat = { size: 100, mtimeMs: 1000.4, ctimeMs: 2000.7, dev: '7', ino: '99999999999999999', isFile: true }
const ran = (over: Partial<ClaudeCliRunResult> = {}): ClaudeCliRunResult => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, ...over })

function deferred<T = unknown>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

afterEach(() => { delete process.env.CCC_FIRST_START_MARK })

describe('Claude Code discovery warms the first start before its --version run', () => {
  function ports(over: Partial<ClaudeReviewPorts> = {}) {
    const order: string[] = []
    const gate = deferred()
    const warmFirstStart = vi.fn(async (executable: string, _env: Readonly<Record<string, string>>) => { order.push(`warm ${executable}`); await gate.promise })
    const run = vi.fn(async (cmd: ClaudeCliCommand, _opts: { env: Record<string, string> }) => { order.push(`run ${cmd.file} ${cmd.args.join(' ')}`); return ran({ stdout: '2.1.296 (Claude Code)\n' }) })
    const p: ClaudeReviewPorts = {
      lookupRealm: async () => ({ ok: false }),
      profileRealmLaunch: () => ({ refused: 'not here' }),
      holdProfile: async () => () => {},
      recordPreflight: () => {},
      resolveExecutable: async () => EXE,
      fileStat: { realpath: (x) => x, stat: () => STAT },
      commandLine: (e, a, pl, s) => cliCommandLine(e, a, pl, s, 'Claude Code'),
      shellEnv: codexShellEnv,
      run: run as unknown as ClaudeReviewPorts['run'],
      warmFirstStart,
      platform: 'win32',
      now: () => 1,
      ...over,
    }
    return { p, order, gate, warmFirstStart, run }
  }

  it('the run waits for the warm-up of the executable discovery resolved, and both get the same sanitised environment', async () => {
    process.env.CCC_FIRST_START_MARK = 'a Conductor variable never reaches a CLI run'
    const t = ports()
    const found = createClaudeReviewLaunch(t.p).setup.discover()
    await vi.waitFor(() => expect(t.warmFirstStart).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(t.run).not.toHaveBeenCalled()
    t.gate.resolve(undefined)
    expect(await found).toMatchObject({ state: 'found', executable: EXE, version: '2.1.296' })
    expect(t.order).toEqual([`warm ${EXE}`, `run ${EXE} --version`])
    const [warmExe, warmEnv] = t.warmFirstStart.mock.calls[0]
    expect(warmExe).toBe(EXE)
    const runEnv = t.run.mock.calls[0][1].env
    expect(warmEnv).toEqual(runEnv)
    expect(Object.keys(warmEnv).some((k) => k.toUpperCase().startsWith('CCC_'))).toBe(false)
    expect(warmEnv.NoDefaultCurrentDirectoryInExePath).toBe('1')
  })

  it('a warm-up that fails changes nothing about the run or its answer', async () => {
    const t = ports({ warmFirstStart: vi.fn(async () => { throw new Error('worker failed') }) })
    expect(await createClaudeReviewLaunch(t.p).setup.discover()).toMatchObject({ state: 'found', version: '2.1.296' })
    expect(t.run).toHaveBeenCalledTimes(1)
  })

  it('a refused command line warms nothing and runs nothing', async () => {
    const t = ports({ commandLine: () => ({ refused: 'no' }) })
    expect(await createClaudeReviewLaunch(t.p).setup.discover()).toMatchObject({ state: 'invalid' })
    expect(t.warmFirstStart).not.toHaveBeenCalled()
    expect(t.run).not.toHaveBeenCalled()
  })

  it('the review launch warms the executable it is handed with the same --version environment', async () => {
    process.env.CCC_FIRST_START_MARK = 'x'
    const t = ports()
    t.gate.resolve(undefined)
    const launch = createClaudeReviewLaunch(t.p).launch
    await launch.warmFirstStart!(EXE)
    expect(t.warmFirstStart).toHaveBeenCalledWith(EXE, expect.objectContaining({ NoDefaultCurrentDirectoryInExePath: '1' }))
    expect(Object.keys(t.warmFirstStart.mock.calls[0][1]).some((k) => k.toUpperCase().startsWith('CCC_'))).toBe(false)
  })
})

describe('Codex discovery warms the first start before its --version run', () => {
  const CSTAT = { size: 10, mtimeMs: 5, ctimeMs: 6, dev: '1', ino: '2', isFile: true }
  function deps(over: Partial<CodexDiscoveryDeps> = {}) {
    const order: string[] = []
    const gate = deferred()
    const warm = vi.fn(async (executable: string, _env: Readonly<Record<string, string>>) => { order.push(`warm ${executable}`); await gate.promise })
    const run = vi.fn(async (cmd: { file: string; args: string[] }, _env: Record<string, string>): Promise<CodexRunResult> => {
      order.push(`run ${cmd.file} ${cmd.args.join(' ')}`)
      return { exitCode: 0, stdout: 'codex-cli 0.155.1\n', stderr: '', timedOut: false, truncated: false }
    })
    const d: CodexDiscoveryDeps = {
      resolve: () => CODEX_EXE, realpath: (p) => p, stat: () => CSTAT,
      run, warm,
      env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32', OPENAI_API_KEY: 'sk-ambient-0000' },
      platform: 'win32',
      versionHome: () => ({ home: 'C:\\tmp\\ccc-codex-version-abc', dispose: () => {} }),
      now: () => 1,
      ...over,
    }
    return { d, order, gate, warm, run }
  }

  it('the run waits for the warm-up of the canonical executable, and both get the throwaway-home environment', async () => {
    const t = deps()
    const found = discoverCodex(t.d)
    await vi.waitFor(() => expect(t.warm).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(t.run).not.toHaveBeenCalled()
    t.gate.resolve(undefined)
    expect(await found).toMatchObject({ state: 'found', executable: CODEX_EXE })
    expect(t.order).toEqual([`warm ${CODEX_EXE}`, `run ${CODEX_EXE} --version`])
    const warmEnv = t.warm.mock.calls[0][1]
    expect(warmEnv).toEqual(t.run.mock.calls[0][1])
    expect(Object.values(warmEnv)).toContain('C:\\tmp\\ccc-codex-version-abc')
    expect(warmEnv.OPENAI_API_KEY).toBeUndefined()
  })

  it('a warm-up that fails changes nothing about the run or its answer', async () => {
    const t = deps({ warm: vi.fn(async () => { throw new Error('x') }) })
    expect(await discoverCodex(t.d)).toMatchObject({ state: 'found' })
    expect(t.run).toHaveBeenCalledTimes(1)
  })
})

describe('a local launch the accounts service prepares waits for the warm-up; an SSH one never warms', () => {
  async function setup() {
    const h = await harness()
    await addCodexAccount(h)
    const gate = deferred()
    const warm = vi.fn(async (_executable: string) => { await gate.promise })
    ;(h.codex.launch as { warmFirstStart?: unknown }).warmFirstStart = warm
    return { h, gate, warm }
  }

  it('a local Codex session is prepared only once the proven executable has been warmed', async () => {
    const { h, gate, warm } = await setup()
    let done = false
    const p = h.service.prepareLaunch({ kind: 'session', providerId: 'codex', ownerId: 's1', remote: false }).then((r) => { done = true; return r })
    await vi.waitFor(() => expect(warm).toHaveBeenCalledWith(CODEX_EXE))
    await new Promise((r) => setTimeout(r, 10))
    expect(done).toBe(false)
    gate.resolve(undefined)
    expect(await p).toMatchObject({ ok: true, executable: CODEX_EXE })
  })

  it('reviews and background runs, which run on this computer, are warmed too', async () => {
    const { h, gate, warm } = await setup()
    gate.resolve(undefined)
    expect(await h.service.prepareLaunch({ kind: 'background', providerId: 'codex', ownerId: 'b1', remote: false })).toMatchObject({ ok: true })
    expect(await h.service.prepareLaunch({ kind: 'review', providerId: 'codex', ownerId: 'r1', remote: false })).toMatchObject({ ok: true })
    expect(warm).toHaveBeenCalledTimes(2)
  })

  it('a launch for an SSH session is never warmed here, even where the provider runs over SSH', async () => {
    const { h, gate, warm } = await setup()
    gate.resolve(undefined)
    h.setCapabilities({ 'session.ssh': { state: 'supported' } } as never)
    expect(await h.service.prepareLaunch({ kind: 'session', providerId: 'codex', ownerId: 's2', remote: true })).toMatchObject({ ok: true, executable: CODEX_EXE })
    expect(warm).not.toHaveBeenCalled()
  })

  it('a warm-up that throws does not stop the launch', async () => {
    const { h } = await setup()
    ;(h.codex.launch as { warmFirstStart?: unknown }).warmFirstStart = async () => { throw new Error('worker failed') }
    expect(await h.service.prepareLaunch({ kind: 'session', providerId: 'codex', ownerId: 's3', remote: false })).toMatchObject({ ok: true })
  })
})
