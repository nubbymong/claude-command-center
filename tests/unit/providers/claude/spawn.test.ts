// ClaudeProvider.resolveBinary: the Claude Code a launch names. The platform is
// forced per case and the Windows PATH walk answers from a set this test owns
// (no file of this computer is read), so the result never depends on what the
// host has installed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ platform: 'win32' as NodeJS.Platform, present: new Set<string>() }))
vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), platform: () => h.platform }))
vi.mock('../../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../src/main/windows-programs')>()
  return {
    ...real,
    findOnWindowsPath: (names: readonly string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') =>
      real.findOnWindowsPath(names, env, (p) => h.present.has(p.toLowerCase()), order),
  }
})

const { ClaudeProvider } = await import('../../../../src/main/providers/claude')
const { CLAUDE_NOT_ON_PATH, _resetClaudeWindowsLookupForTest, _resetClaudeLoginShellLookupForTest } = await import('../../../../src/main/claude-cli-probe')

// The provider reads this process's own environment: PATH and SHELL are set
// per case and put back after.
const saved = { path: process.env.PATH, shell: process.env.SHELL }
function restore(name: 'PATH' | 'SHELL', value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  h.present = new Set()
  _resetClaudeWindowsLookupForTest()
  _resetClaudeLoginShellLookupForTest()
})
afterEach(() => {
  restore('PATH', saved.path)
  restore('SHELL', saved.shell)
})

describe('ClaudeProvider.resolveBinary', () => {
  it('off Windows, for a sh-family login shell: "claude", which the session\'s login shell finds', () => {
    h.platform = 'linux'
    process.env.SHELL = '/bin/bash'
    expect(new ClaudeProvider().resolveBinary()).toEqual({ cmd: 'claude', args: [] })
  })

  it('on Windows: the full path found in PATH\'s folders, or a refusal that names them -- never a bare name', () => {
    h.platform = 'win32'
    process.env.PATH = '.;rel\\bin;C:\\Tools'
    h.present = new Set(['.\\claude.exe', 'rel\\bin\\claude.exe', 'claude.exe', 'c:\\tools\\claude.exe'])
    expect(new ClaudeProvider().resolveBinary()).toEqual({ cmd: 'C:\\Tools\\claude.exe', args: [] })
    _resetClaudeWindowsLookupForTest()
    h.present = new Set(['.\\claude.exe', 'rel\\bin\\claude.exe', 'claude.exe'])
    expect(() => new ClaudeProvider().resolveBinary()).toThrow(CLAUDE_NOT_ON_PATH)
  })
})
