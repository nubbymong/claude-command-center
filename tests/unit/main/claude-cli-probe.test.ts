/**
 * Phase 7 item B — the main-side "is the Claude CLI installed?" probe.
 *
 * The gate first-run setup hard-stops on. Two things must hold or the stop is
 * either useless or a brick:
 *  - it must probe the way the setup PTY LAUNCHES (a POSIX login shell, so a
 *    Homebrew/nvm install is seen), otherwise it reports "missing" for a CLI
 *    that works fine;
 *  - it must fail CLOSED, so a probe that throws blocks rather than waves
 *    through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const exec = vi.hoisted(() => ({ fn: vi.fn() }))
const platform = vi.hoisted(() => ({ value: 'win32' as NodeJS.Platform }))

vi.mock('child_process', () => ({ execFileSync: (...args: unknown[]) => exec.fn(...args) }))
vi.mock('os', () => ({ platform: () => platform.value }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {} }))

const { probeClaudeCli } = await import('../../../src/main/claude-cli-probe')

beforeEach(() => {
  exec.fn.mockReset()
})

describe('probeClaudeCli on Windows', () => {
  beforeEach(() => { platform.value = 'win32' })

  it('reports the first `where` hit', () => {
    exec.fn.mockReturnValueOnce('C:\\Users\\me\\AppData\\npm\\claude.cmd\r\n')
    const result = probeClaudeCli()
    expect(result.installed).toBe(true)
    expect(result.path).toBe('C:\\Users\\me\\AppData\\npm\\claude.cmd')
    expect(exec.fn.mock.calls[0][0]).toBe('where')
    expect(exec.fn.mock.calls[0][1]).toEqual(['claude.exe'])
  })

  it('walks .exe -> .cmd -> bare, then reports NOT installed', () => {
    exec.fn.mockImplementation(() => { throw new Error('not found') })
    const result = probeClaudeCli()
    expect(result.installed).toBe(false)
    expect(exec.fn.mock.calls.map((c) => (c[1] as string[])[0])).toEqual(['claude.exe', 'claude.cmd', 'claude'])
  })

  it('an empty/whitespace answer is NOT a hit', () => {
    exec.fn.mockReturnValue('   \r\n')
    expect(probeClaudeCli().installed).toBe(false)
  })
})

describe('probeClaudeCli on POSIX', () => {
  beforeEach(() => { platform.value = 'darwin'; process.env.SHELL = '/bin/zsh' })

  it('asks the LOGIN shell first, so a Homebrew/nvm install is seen', () => {
    exec.fn.mockReturnValueOnce('/opt/homebrew/bin/claude\n')
    const result = probeClaudeCli()
    expect(result.installed).toBe(true)
    expect(result.path).toBe('/opt/homebrew/bin/claude')
    expect(exec.fn.mock.calls[0][0]).toBe('/bin/zsh')
    expect(exec.fn.mock.calls[0][1]).toEqual(['-lc', 'command -v claude'])
  })

  it('falls back to `which` when the login shell probe cannot run', () => {
    exec.fn.mockImplementationOnce(() => { throw new Error('no shell') })
    exec.fn.mockReturnValueOnce('/usr/local/bin/claude\n')
    const result = probeClaudeCli()
    expect(result.installed).toBe(true)
    expect(exec.fn.mock.calls[1][0]).toBe('which')
  })

  it('both misses -> NOT installed', () => {
    exec.fn.mockImplementation(() => { throw new Error('nope') })
    expect(probeClaudeCli().installed).toBe(false)
  })
})
