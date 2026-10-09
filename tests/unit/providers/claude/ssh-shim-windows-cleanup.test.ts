// Ending or closing an SSH session on a Windows host removes the session's
// files there too.
//
// On a Windows host the removal is a node program, base64'd into the same
// `$`-free powershell one-liner the Windows setup uses, so a cmd.exe and a
// PowerShell default shell read it the same. Asserted here
// without running anything on this machine: the one-liner's shape (what a cmd
// or PowerShell parent could read in it), and the decoded program, run in a
// sandbox whose file system and home folder are recorders, removes exactly
// this session's three files under `<home>\.claude` and nothing else.
import { describe, it, expect } from 'vitest'
import * as vm from 'node:vm'
import * as path from 'node:path'

const { buildWindowsRemoteSessionCleanupCommand, buildRemoteSessionCleanupCommand } = await import('../../../../src/main/providers/claude/ssh-shim')

const HOME = 'C:\\Users\\remote-user'

/** The base64 inside the one-liner, decoded. */
const programOf = (line: string): string => {
  const m = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(line)
  if (!m) throw new Error('no base64 payload')
  return Buffer.from(m[1], 'base64').toString('utf-8')
}

/** Run the decoded program in a sandbox: the paths it removes, and every
 *  other file-system call it made (none expected). */
const removedBy = (program: string): { removed: string[]; other: string[] } => {
  const removed: string[] = []
  const other: string[] = []
  const fsRecorder = new Proxy({}, {
    get: (_t, name: string) => (...args: unknown[]) => {
      if (name === 'rmSync') { removed.push(String(args[0])); return undefined }
      other.push(name)
      return undefined
    },
  })
  const sandboxRequire = (id: string): unknown => {
    if (id === 'fs') return fsRecorder
    if (id === 'path') return path.win32
    if (id === 'os') return { homedir: () => HOME }
    throw new Error(`unexpected module ${id}`)
  }
  vm.runInNewContext(program, { require: sandboxRequire })
  return { removed, other }
}

describe('the Windows removal of a session\'s files', () => {
  it('removes exactly this session\'s three files under the home folder\'s .claude', () => {
    const { removed, other } = removedBy(programOf(buildWindowsRemoteSessionCleanupCommand('a1b2c3d4e5f6a7b8c9d0e1f2')))
    expect(removed).toEqual([
      `${HOME}\\.claude\\settings-a1b2c3d4e5f6a7b8c9d0e1f2.json`,
      `${HOME}\\.claude\\mcp-a1b2c3d4e5f6a7b8c9d0e1f2.json`,
      `${HOME}\\.claude\\ccc-status-a1b2c3d4e5f6a7b8c9d0e1f2.url`,
    ])
    expect(other).toEqual([])
  })

  it('a session id with characters outside [A-Za-z0-9_-] is reduced to that set', () => {
    const { removed } = removedBy(programOf(buildWindowsRemoteSessionCleanupCommand('a&b|c%x%\\..\\x')))
    expect(removed).toEqual([
      `${HOME}\\.claude\\settings-a_b_c_x_____x.json`,
      `${HOME}\\.claude\\mcp-a_b_c_x_____x.json`,
      `${HOME}\\.claude\\ccc-status-a_b_c_x_____x.url`,
    ])
    for (const p of removed) expect(path.win32.dirname(p)).toBe(`${HOME}\\.claude`)
  })

  it('is one line a cmd or PowerShell parent reads the same: no $, no ; or & outside the quoted payload, under the cmd limit', () => {
    const line = buildWindowsRemoteSessionCleanupCommand('a&b|c%x%')
    expect(line).not.toMatch(/[\r\n]/)
    expect(line).not.toContain('$')
    expect(line.length).toBeLessThan(7500)
    // Everything a parent shell reads outside the double-quoted -Command.
    const outside = line.replace(/"[^"]*"/g, '')
    expect(outside).toBe('powershell -NoProfile -NonInteractive -Command ')
    // Inside, only the fixed decode expression and base64 (no session text).
    expect(line).toMatch(/^powershell -NoProfile -NonInteractive -Command "\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('[A-Za-z0-9+/=]+'\)\)\|node"$/)
  })

  it('the POSIX removal is unchanged', () => {
    expect(buildRemoteSessionCleanupCommand('sid-1')).toBe('rm -f ~/.claude/settings-sid-1.json ~/.claude/mcp-sid-1.json ~/.claude/ccc-status-sid-1.url\n')
  })
})
