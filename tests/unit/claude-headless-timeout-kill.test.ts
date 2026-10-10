// Leak fix: on Windows a headless run can be `cmd.exe -> claude.cmd -> node`
// or a claude.exe with children of its own. On timeout the old code called
// proc.kill(), which on Windows kills only the first process and orphans the
// rest (it keeps running and a fresh one spawns on the retry / next launch).
// The fix taskkill /T /F's the whole tree by pid, matching vision-manager /
// cloud-agent teardown, with taskkill started from the system folder.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const spawnCalls: Array<{ executable: string; args: string[]; opts: any }> = []
const killCalls: Array<{ file: string; args: string[] }> = []
let fakeChild: any
/** What a taskkill start fails with (none: it ran). */
let killError: Error | null = null

vi.mock('child_process', () => ({
  spawn: (executable: string, args: string[], opts: any) => {
    spawnCalls.push({ executable, args, opts })
    return fakeChild
  },
  spawnSync: (file: string, args: string[]) => {
    killCalls.push({ file, args })
    return killError ? { status: null, error: killError } : { status: 0 }
  },
}))
// The run finds Claude Code in PATH's folders (stubbed: no real PATH is read).
vi.mock('../../src/main/windows-programs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/windows-programs')>()),
  findOnWindowsPath: () => 'C:\\Tools\\claude.exe',
  findOnWindowsPathAsync: async () => 'C:\\Tools\\claude.exe',
}))
// withProfileHome pulls in the heavy pty-manager graph (reaches electron); stub it.
vi.mock('../../src/main/pty-manager', () => ({ withProfileHome: (env: any) => env }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

const { spawnClaudeHeadless } = await import('../../src/main/claude-headless')

// A child that never emits 'close'/'error', so spawnClaudeHeadless must hit its
// timeout path (the only path that kills the process).
function makeChild(pid: number) {
  return {
    pid,
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  }
}

describe('spawnClaudeHeadless timeout', () => {
  beforeEach(() => {
    spawnCalls.length = 0
    killCalls.length = 0
    killError = null
    fakeChild = makeChild(4242)
  })

  it('kills the whole process tree (not just the first process) when it times out', async () => {
    const res = await spawnClaudeHeadless(['-p'], 30, 'prompt', '/home')
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('Timed out')
    if (process.platform === 'win32') {
      expect(killCalls.some((c) => /[\\/]System32[\\/]taskkill\.exe$/i.test(c.file) && c.args.includes('/T') && c.args.includes('4242'))).toBe(true)
    } else {
      // POSIX path is unchanged (proc.kill on the spawned process).
      expect(fakeChild.kill).toHaveBeenCalled()
    }
  })
})

describe('spawnClaudeHeadless timeout on Windows: the tree, else the run itself', () => {
  const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const savedRoot = process.env.SystemRoot
  beforeEach(() => {
    spawnCalls.length = 0
    killCalls.length = 0
    killError = null
    fakeChild = makeChild(4242)
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env.SystemRoot = 'C:\\Windows'
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', hostPlatform)
    if (savedRoot === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = savedRoot
  })

  it('a taskkill that ran ends the tree, and the run is not signalled as well', async () => {
    await spawnClaudeHeadless(['-p'], 30, 'prompt', '/home')
    expect(killCalls).toEqual([{ file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/pid', '4242', '/T', '/F'] }])
    expect(fakeChild.kill).not.toHaveBeenCalled()
  })

  it('a taskkill that could not start leaves the run\'s own process to be ended', async () => {
    killError = Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })
    await spawnClaudeHeadless(['-p'], 30, 'prompt', '/home')
    expect(killCalls).toHaveLength(1)
    expect(fakeChild.kill).toHaveBeenCalled()
  })

  it('with no plain system folder, the run\'s own process is ended and no taskkill starts', async () => {
    process.env.SystemRoot = 'Windows'
    await spawnClaudeHeadless(['-p'], 30, 'prompt', '/home')
    expect(killCalls).toEqual([])
    expect(fakeChild.kill).toHaveBeenCalled()
  })
})
