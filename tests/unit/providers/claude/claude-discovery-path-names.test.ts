// WP2 PR 4 review fix pass (ADR-009 L3): the Claude Code CLI that discovery
// proves is the file Windows runs. Node reads a folder or file name as it is
// spelled, while Windows' own path handling, which starts the program, can
// drop a trailing dot or space and reach another file; so a resolved Windows
// path with any name ending in a dot or a space is never proved or run, and a
// re-check before a launch reports it as moved. [host] Every port is a fake:
// no file is read and no process starts.
import { describe, it, expect } from 'vitest'
import { discoverClaude, verifyClaudeExecutable } from '../../../../src/main/providers/claude/discovery'
import type { ClaudeDiscoveryDeps, ClaudeFileStat } from '../../../../src/main/providers/claude/discovery'

const STAT: ClaudeFileStat = { size: 10, mtimeMs: 5, ctimeMs: 5, dev: '1', ino: '2', isFile: true }

function deps(resolved: string, platform: NodeJS.Platform = 'win32') {
  const versions: string[] = []
  const d: ClaudeDiscoveryDeps = {
    resolve: async () => resolved,
    realpath: (p) => p,
    stat: () => STAT,
    runVersion: async (exe) => { versions.push(exe); return { exitCode: 0, stdout: '2.1.289 (Claude Code)\n', timedOut: false } },
    platform,
    now: () => 1,
  }
  return { d, versions }
}

describe('Claude discovery: a Windows path with a name ending in a dot or a space is never proved [host]', () => {
  it('refuses it before anything runs, wherever the name is', async () => {
    for (const p of ['C:\\b\\a.\\bin\\claude.exe', 'C:\\b\\a \\bin\\claude.exe', 'C:\\tools.\\claude.exe', 'C:\\b\\claude.exe.', 'C:\\b\\claude.exe ', '\\\\srv\\share\\x.\\claude.exe']) {
      const t = deps(p)
      const r = await discoverClaude(t.d)
      expect(r.state, p).toBe('invalid')
      expect(r.detail, p).toMatch(/ending in a dot or a space/)
      expect(t.versions, p).toEqual([])
    }
  })

  it('a plain path is still proved; a POSIX name ending in a dot is the file it names and is not refused', async () => {
    const win = deps('C:\\Users\\u\\.local\\bin\\claude.exe')
    expect(await discoverClaude(win.d)).toMatchObject({ state: 'found', executable: 'C:\\Users\\u\\.local\\bin\\claude.exe' })
    const posix = deps('/opt/a./bin/claude', 'linux')
    expect(await discoverClaude(posix.d)).toMatchObject({ state: 'found', executable: '/opt/a./bin/claude' })
  })

  it('the re-check before a launch reports such a path as moved, never as the proved file', async () => {
    const recorded = { path: 'C:\\b\\a.\\bin\\claude.exe', size: 10, mtimeMs: 5, ctimeMs: 5, dev: '1', ino: '2' }
    const t = deps('C:\\b\\a.\\bin\\claude.exe')
    expect(await verifyClaudeExecutable(recorded, t.d)).toMatchObject({ ok: false, reason: 'moved' })
    const clean = { ...recorded, path: 'C:\\b\\a\\bin\\claude.exe' }
    expect(await verifyClaudeExecutable(clean, deps('C:\\b\\a\\bin\\claude.exe').d)).toEqual({ ok: true, executable: 'C:\\b\\a\\bin\\claude.exe' })
  })
})
