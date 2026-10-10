// PR 4 (owner answers review, E-S1): a headless run can hand its stdout to the
// caller as it arrives (Sentinel's analysis watches its stream). The result
// still carries the whole stdout, a callback that throws never breaks the
// run, and a run without one is unchanged. The spawn is faked: no process
// starts. [host]
import { describe, it, expect, beforeEach, vi } from 'vitest'
// On Windows, programs are found in PATH's folders (windows-programs.ts); stubbed here,
// so no real PATH is read: the first name asked for, in one fully qualified folder
// (the walk on the event loop and the one off it alike).
vi.mock('../../src/main/windows-programs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/windows-programs')>()),
  findOnWindowsPath: (names: readonly string[]) => `C:\\Tools\\${names[0]}`,
  findOnWindowsPathAsync: async (names: readonly string[]) => `C:\\Tools\\${names[0]}`,
}))

type Handler = (data: unknown) => void
const child = vi.hoisted(() => ({ stdout: [] as Handler[], close: null as null | ((code: number) => void), chunks: [] as Array<string | Buffer> }))

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
      for (const t of child.chunks) for (const h of child.stdout) h(Buffer.isBuffer(t) ? t : Buffer.from(t))
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

  it('a character split across two chunks arrives whole, in the callback and in the result [host]', async () => {
    // Owner answers review (E-Q11): each chunk used to be decoded on its own, so a
    // character cut between chunks became U+FFFD (a quoted character in the reply then
    // failed the evidence check).
    const text = '{"type":"result","result":"caf' + String.fromCodePoint(0xe9) + ' ' + String.fromCodePoint(0x1f600) + '"}\n'
    const bytes = Buffer.from(text, 'utf8')
    const cutAt = [bytes.indexOf(0xc3) + 1, bytes.indexOf(0xf0) + 2]
    child.chunks = [bytes.subarray(0, cutAt[0]), bytes.subarray(cutAt[0], cutAt[1]), bytes.subarray(cutAt[1])]
    const seen: string[] = []
    const r = await spawnClaudeHeadless(['-p'], 1000, 'prompt', null, undefined, { onStdout: (c) => { seen.push(c) } })
    expect(seen.join('')).toBe(text)
    expect(r.stdout).toBe(text)
    expect(r.stdout).not.toContain(String.fromCodePoint(0xfffd))
  })

  it('bytes still held when the output ends are not lost (read as the platform reads a cut character) [host]', async () => {
    child.chunks = ['ok\n', Buffer.from([0xe2, 0x82])]
    const r = await spawnClaudeHeadless(['-p'], 1000, 'prompt', null)
    expect(r.stdout.startsWith('ok\n')).toBe(true)
    expect(r.stdout.length).toBeGreaterThan(3)
  })
})
