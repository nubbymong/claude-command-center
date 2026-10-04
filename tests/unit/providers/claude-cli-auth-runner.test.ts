// WP2 PR 4 review fix pass (A2-Q5, A2-Q2): how the Claude sign-in status and
// sign-out start the CLI. The composition root's runner runs the executable
// discovery proved, with no shell (an npm shim only through an absolute
// cmd.exe with a constant argument line), in that executable's own folder, and
// hands back the run's end so the profile stays held until a stopped process
// tree has gone. [host] The run itself is a fake: no process starts.
import { describe, it, expect } from 'vitest'
import { claudeCliAuthRunner } from '../../../src/main/providers/compose'
import type { CodexCommand, CodexRunOptions, CodexRunResult } from '../../../src/main/providers/codex'

function fakeRun(result: Partial<CodexRunResult> = {}) {
  const calls: Array<{ cmd: CodexCommand; opts: CodexRunOptions }> = []
  const run = async (cmd: CodexCommand, opts: CodexRunOptions): Promise<CodexRunResult> => {
    calls.push({ cmd, opts })
    return { exitCode: 0, stdout: '{"loggedIn":false}', stderr: '', timedOut: false, truncated: false, ...result }
  }
  return { calls, run }
}

describe('claudeCliAuthRunner: the proved executable, no shell, its own folder [host]', () => {
  it('POSIX: the executable itself with the constant arguments, in its folder, with the env and time limit given', async () => {
    const f = fakeRun()
    const r = claudeCliAuthRunner('/opt/claude/bin/claude', 'linux', f.run)
    expect(r.cwd).toBe('/opt/claude/bin')
    const out = await r.run(['auth', 'logout'], { HOME: '/p' }, 30_000)
    expect(f.calls).toEqual([{ cmd: { file: '/opt/claude/bin/claude', args: ['auth', 'logout'], verbatim: false, cwd: '/opt/claude/bin' }, opts: { env: { HOME: '/p' }, timeoutMs: 30_000 } }])
    expect(out).toEqual({ exitCode: 0, stdout: '{"loggedIn":false}', timedOut: false })
  })

  it('Windows: a native executable runs as itself; an npm shim only through the absolute cmd.exe, its line built from constants', async () => {
    const native = fakeRun()
    await claudeCliAuthRunner('C:\\Users\\u\\.local\\bin\\claude.exe', 'win32', native.run).run(['auth', 'status'], { SystemRoot: 'C:\\Windows' }, 10_000)
    expect(native.calls[0].cmd).toEqual({ file: 'C:\\Users\\u\\.local\\bin\\claude.exe', args: ['auth', 'status'], verbatim: false, cwd: 'C:\\Users\\u\\.local\\bin' })
    const shim = fakeRun()
    await claudeCliAuthRunner('C:\\Tools\\npm\\claude.cmd', 'win32', shim.run).run(['auth', 'logout'], { SystemRoot: 'C:\\Windows' }, 30_000)
    expect(shim.calls[0].cmd).toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/v:off', '/s', '/c', '""C:\\Tools\\npm\\claude.cmd" auth logout"'], verbatim: true, cwd: 'C:\\Tools\\npm' })
  })

  it('an executable the command-line rules refuse starts nothing and says why', async () => {
    for (const [exe, platform] of [['claude', 'linux'], ['', 'win32'], ['C:\\Tools\\claude.cmd.', 'win32'], ['C:\\To%ols\\claude.cmd', 'win32']] as const) {
      const f = fakeRun()
      const out = await claudeCliAuthRunner(exe, platform, f.run).run(['auth', 'logout'], { SystemRoot: 'C:\\Windows' }, 30_000)
      expect(f.calls, exe).toEqual([])
      expect(typeof out.refused, exe).toBe('string')
      expect(out.timedOut, exe).toBe(false)
    }
  })

  it('a run stopped at its deadline reads as timed out and hands back the end of its kill; a start failure says so', async () => {
    const killSettled = Promise.resolve()
    const stopped = await claudeCliAuthRunner('/opt/c/claude', 'linux', fakeRun({ exitCode: null, timedOut: false, stopped: 'deadline', killSettled }).run).run(['auth', 'logout'], {}, 30_000)
    expect(stopped.timedOut).toBe(true)
    expect(stopped.killSettled).toBe(killSettled)
    const failed = await claudeCliAuthRunner('/opt/c/claude', 'linux', fakeRun({ exitCode: null, spawnError: 'spawn ENOENT' }).run).run(['auth', 'status'], {}, 10_000)
    expect(failed.spawnError).toBe('spawn ENOENT')
  })
})
