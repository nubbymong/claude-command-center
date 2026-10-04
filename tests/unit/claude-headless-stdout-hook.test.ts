// PR 4 (owner answers review, E-S1): a headless run can hand its stdout to the
// caller as it arrives (Sentinel's analysis watches its stream). The result
// still carries the whole stdout, a callback that throws never breaks the
// run, and a run without one is unchanged. The spawn is faked: no process
// starts. [host]
import { describe, it, expect, beforeEach, vi } from 'vitest'

type Handler = (data: unknown) => void
const child = vi.hoisted(() => ({ stdout: [] as Handler[], close: null as null | ((code: number) => void), chunks: [] as string[] }))

vi.mock('child_process', () => ({
  spawn: () => {
    child.stdout = []
    const c = {
      pid: 4242,
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: (ev: string, fn: Handler) => { if (ev === 'data') child.stdout.push(fn) } },
      stderr: { on: vi.fn() },
      on: (ev: string, fn: (code: number) => void) => { if (ev === 'close') child.close = fn },
      kill: vi.fn(),
    }
    queueMicrotask(() => {
      for (const t of child.chunks) for (const h of child.stdout) h(Buffer.from(t))
      child.close?.(0)
    })
    return c
  },
  execSync: vi.fn(),
}))
vi.mock('../../src/main/pty-manager', () => ({ withProfileHome: (env: Record<string, string>) => env }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

const { spawnClaudeHeadless, assertHeadlessOptions } = await import('../../src/main/claude-headless')

describe('spawnClaudeHeadless: the stdout as it arrives (owner answers review)', () => {
  beforeEach(() => { child.chunks = ['{"type":"system"', ',"subtype":"init"}\n', '{"type":"result"}\n'] })

  it('each chunk reaches the callback in order, and the result carries the whole stdout [host]', async () => {
    const seen: string[] = []
    const r = await spawnClaudeHeadless(['-p'], 1000, 'prompt', null, undefined, { onStdout: (c) => { seen.push(c) } })
    expect(seen).toEqual(child.chunks)
    expect(r).toMatchObject({ code: 0, stdout: child.chunks.join('') })
  })

  it('a callback that throws never breaks the run [host]', async () => {
    const r = await spawnClaudeHeadless(['-p'], 1000, 'prompt', null, undefined, { onStdout: () => { throw new Error('boom') } })
    expect(r).toMatchObject({ code: 0, stdout: child.chunks.join('') })
  })

  it('without one, the run is as before; anything but a function is refused before anything starts [host]', async () => {
    const r = await spawnClaudeHeadless(['-p'], 1000, 'prompt', null)
    expect(r).toMatchObject({ code: 0, stdout: child.chunks.join('') })
    expect(() => assertHeadlessOptions({ onStdout: 'not a function' as never })).toThrow(/stdout/)
  })
})
