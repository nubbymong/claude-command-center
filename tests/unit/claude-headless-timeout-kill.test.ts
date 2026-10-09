// Leak fix: on Windows a headless run can be `cmd.exe -> claude.cmd -> node`
// or a claude.exe with children of its own. On timeout the old code called
// proc.kill(), which on Windows kills only the first process and orphans the
// rest (it keeps running and a fresh one spawns on the retry / next launch).
// The fix taskkill /T /F's the whole tree by pid, matching vision-manager /
// cloud-agent teardown, with taskkill started from the system folder.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const spawnCalls: Array<{ executable: string; args: string[]; opts: any }> = []
const killCalls: Array<{ file: string; args: string[] }> = []
let fakeChild: any

vi.mock('child_process', () => ({
  spawn: (executable: string, args: string[], opts: any) => {
    spawnCalls.push({ executable, args, opts })
    return fakeChild
  },
  spawnSync: (file: string, args: string[]) => {
    killCalls.push({ file, args })
    return { status: 0 }
  },
}))
// The run finds Claude Code in PATH's folders (stubbed: no real PATH is read).
vi.mock('../../src/main/windows-programs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/windows-programs')>()),
  findOnWindowsPath: () => 'C:\\Tools\\claude.exe',
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
