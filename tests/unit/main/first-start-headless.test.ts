// ADR-025: a headless Claude Code run (Sentinel's checks and analysis, the
// Insights runs, onboarding's Find Claude) starts a claude.exe found in PATH's
// folders directly on Windows, on the main thread. Before that start it awaits
// the first-start warm-up of that same program, with Claude's --version
// environment; a run aborted during the wait starts nothing; an npm
// claude.cmd (started through cmd.exe) is not warmed. The lookup, the warm-up
// and child_process are faked and the platform is forced: nothing is started.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  bin: 'C:\\Users\\A\\.local\\bin\\claude.exe' as string | null,
  order: [] as string[],
  warm: [] as Array<{ program: string; env: () => unknown }>,
  gate: null as null | Promise<void>,
}))
vi.mock('child_process', () => ({
  spawn: (file: string) => {
    h.order.push(`spawn ${file}`)
    const handlers = new Map<string, (...a: unknown[]) => void>()
    const child = {
      pid: 4242,
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: (ev: string, fn: (...a: unknown[]) => void) => { handlers.set(ev, fn); if (ev === 'close') setTimeout(() => fn(0), 0) },
      kill: vi.fn(),
    }
    return child
  },
  spawnSync: () => ({ status: 0 }),
}))
vi.mock('../../../src/main/claude-cli-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/claude-cli-probe')>()),
  recentClaudeOnWindows: () => h.bin,
  findClaudeOnWindowsAsync: async () => h.bin,
}))
// withProfileHome pulls in the heavy pty-manager graph (reaches electron); stub it.
vi.mock('../../../src/main/pty-manager', () => ({ withProfileHome: (env: Record<string, string>) => env }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/first-start-warmup', () => ({
  warmFirstStart: async (program: string, env: () => unknown) => {
    h.warm.push({ program, env })
    h.order.push(`warm ${program}`)
    if (h.gate) await h.gate
    return { outcome: 'ran', exitCode: 0, timedOut: false }
  },
}))

const { spawnClaudeHeadless } = await import('../../../src/main/claude-headless')

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedRoot = process.env.SystemRoot
beforeEach(() => {
  h.bin = 'C:\\Users\\A\\.local\\bin\\claude.exe'
  h.order.length = 0
  h.warm.length = 0
  h.gate = null
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.SystemRoot = 'C:\\Windows'
})
afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatform)
  if (savedRoot === undefined) delete process.env.SystemRoot
  else process.env.SystemRoot = savedRoot
  delete process.env.CCC_FIRST_START_MARK
})

describe('a headless Claude Code run on Windows (ADR-025)', () => {
  it('awaits the warm-up of the claude.exe found in PATH\'s folders before it starts it', async () => {
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const run = spawnClaudeHeadless(['--version'], 10_000)
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(h.order).toEqual(['warm C:\\Users\\A\\.local\\bin\\claude.exe'])
    release()
    expect((await run).code).toBe(0)
    expect(h.order).toEqual(['warm C:\\Users\\A\\.local\\bin\\claude.exe', 'spawn C:\\Users\\A\\.local\\bin\\claude.exe'])
  })

  it('warms with Claude\'s --version environment, never the run\'s own', async () => {
    process.env.CCC_FIRST_START_MARK = 'never reaches a CLI run'
    await spawnClaudeHeadless(['--version'], 10_000)
    const env = (await (h.warm[0].env as () => Promise<{ env: Record<string, string> }> | { env: Record<string, string> })()).env
    expect(Object.keys(env).some((k) => k.toUpperCase().startsWith('CCC_'))).toBe(false)
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1')
  })

  it('a run aborted while the warm-up runs starts nothing', async () => {
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const ac = new AbortController()
    const run = spawnClaudeHeadless(['-p'], 10_000, 'prompt', null, ac.signal)
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    ac.abort()
    release()
    const res = await run
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('Aborted')
    expect(h.order).toEqual(['warm C:\\Users\\A\\.local\\bin\\claude.exe'])
  })

  it('an npm claude.cmd, which cmd.exe starts, is not warmed', async () => {
    h.bin = 'C:\\Npm\\claude.cmd'
    await spawnClaudeHeadless(['--version'], 10_000)
    expect(h.warm).toEqual([])
    expect(h.order).toEqual(['spawn C:\\Windows\\System32\\cmd.exe'])
  })
})
