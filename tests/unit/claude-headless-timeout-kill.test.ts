// Leak fix: spawnClaudeHeadless spawns with shell:true so on Windows the child
// is `cmd.exe -> claude`. On timeout the old code called proc.kill(), which on
// Windows kills only the cmd shell and orphans the real `claude` process (it
// keeps running and a fresh one spawns on the retry / next launch). The fix
// taskkill /T /F's the whole tree by pid, matching vision-manager / cloud-agent
// teardown.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const spawnCalls: Array<{ executable: string; args: string[]; opts: any }> = []
const execSyncCalls: string[] = []
let fakeChild: any

vi.mock('child_process', () => ({
  spawn: (executable: string, args: string[], opts: any) => {
    spawnCalls.push({ executable, args, opts })
    return fakeChild
  },
  execSync: (cmd: string) => {
    execSyncCalls.push(cmd)
  },
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
    execSyncCalls.length = 0
    fakeChild = makeChild(4242)
  })

  it('kills the whole process tree (not just the shell) when it times out', async () => {
    const res = await spawnClaudeHeadless(['-p'], 30, 'prompt', '/home')
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('Timed out')
    if (process.platform === 'win32') {
      expect(
        execSyncCalls.some((c) => c.includes('taskkill') && c.includes('/T') && c.includes('4242')),
      ).toBe(true)
    } else {
      // POSIX path is unchanged (proc.kill on the spawned process).
      expect(fakeChild.kill).toHaveBeenCalled()
    }
  })
})
