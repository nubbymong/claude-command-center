// P3.9 round 2: a headless run can have its own working folder and a few of
// Claude Code's own switches (Sentinel's analysis runs in an empty folder of
// its own, with no memory files). The folder must be absolute; only
// CLAUDE_CODE_* switches with plain values are taken, and they hold over the
// account's environment. Anything else is a programming error and throws.
// The spawn is faked: no process starts.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as path from 'path'

const spawnCalls: Array<{ executable: string; args: string[]; opts: any }> = []

vi.mock('child_process', () => ({
  spawn: (executable: string, args: string[], opts: any) => {
    spawnCalls.push({ executable, args, opts })
    const handlers: Record<string, (code: number) => void> = {}
    const child = {
      pid: 4242,
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: (ev: string, fn: (code: number) => void) => { handlers[ev] = fn },
      kill: vi.fn(),
    }
    queueMicrotask(() => handlers.close?.(0))
    return child
  },
  execSync: vi.fn(),
}))
// The account's environment: it sets a switch the run's own options override.
vi.mock('../../src/main/pty-manager', () => ({ withProfileHome: (env: any) => ({ ...env, FROM_PROFILE: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0' }) }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

const { spawnClaudeHeadless, assertHeadlessOptions } = await import('../../src/main/claude-headless')
const { CLAUDE_ANALYSIS_ARGS, CLAUDE_ANALYSIS_ENV } = await import('../../src/main/sentinel/sentinel-analysis')

const FOLDER = path.resolve(path.sep, 'res', 'sentinel', 'runs', 'ccc-sentinel-claude-x')

describe('spawnClaudeHeadless: the run\'s own folder and switches (P3.9 round 2)', () => {
  beforeEach(() => { spawnCalls.length = 0 })

  it('runs in the folder given, with the switches over the account\'s environment; the argv is passed as given', async () => {
    const r = await spawnClaudeHeadless([...CLAUDE_ANALYSIS_ARGS], 1000, 'prompt', null, undefined, { cwd: FOLDER, env: CLAUDE_ANALYSIS_ENV })
    expect(r.code).toBe(0)
    const { executable, args, opts } = spawnCalls[0]
    expect(executable).toBe('claude')
    expect(args).toEqual([...CLAUDE_ANALYSIS_ARGS])
    expect(opts.cwd).toBe(FOLDER)
    expect(opts.env).toMatchObject({ FROM_PROFILE: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1' })
  })

  it('without options: this process\'s own folder and the account\'s environment, as before', async () => {
    await spawnClaudeHeadless(['-p'], 1000, 'prompt', null)
    expect(spawnCalls[0].opts.cwd).toBe(process.cwd())
    expect(spawnCalls[0].opts.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('0')
  })

  it('refuses a relative folder, or a variable that is not a plain Claude Code switch, before anything starts', () => {
    for (const bad of [
      { cwd: 'relative/folder' },
      { cwd: '' },
      { env: { PATH: 'C:\\evil' } },
      { env: { NODE_OPTIONS: '--require x' } },
      { env: { claude_code_x: '1' } },
      { env: { CLAUDE_CODE_X: 'a b' } },
      { env: { CLAUDE_CODE_X: '%PATH%' } },
      { env: { CLAUDE_CODE_X: 'x'.repeat(65) } },
    ]) {
      expect(() => assertHeadlessOptions(bad as never), JSON.stringify(bad)).toThrow()
      expect(() => spawnClaudeHeadless(['-p'], 1000, 'p', null, undefined, bad as never), JSON.stringify(bad)).toThrow()
    }
    expect(spawnCalls).toEqual([])
    expect(() => assertHeadlessOptions({})).not.toThrow()
  })
})
