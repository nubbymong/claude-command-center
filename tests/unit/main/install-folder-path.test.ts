// A CLI the check did not find, though its publisher's installer put it in
// its own folder (the PATH finding of the first-run test, 2026-10-10;
// ADR-024). Anthropic's native installer leaves claude.exe in
// %USERPROFILE%\.local\bin off PATH; a restart cannot help, so the app says
// so and, on Windows, may add exactly that one folder to the user's PATH.
// PURE: the file system, the registry and the PATH write are stand-ins;
// nothing is started and the real registry and PATH are never touched.
import { describe, it, expect, vi } from 'vitest'
import * as path from 'path'
import {
  pathHintFor, addToolFolderToPath, shellProfileFor, POSIX_PATH_LINE, FISH_PATH_LINE,
  type InstallFolderDeps, type EntryKind,
} from '../../../src/main/install-folder-path'
import type { RegistryPaths, UserPathAppendResult } from '../../../src/main/windows-registry-path'

const BS = String.fromCharCode(92)
const w = (s: string) => s.replace(/\//g, BS)
const HOME = w('C:/Users/u')
const LOCAL_BIN = w('C:/Users/u/.local/bin')
const CLAUDE_EXE = w('C:/Users/u/.local/bin/claude.exe')
const NPM = w('C:/Users/u/AppData/Roaming/npm')

function deps(over: Partial<InstallFolderDeps> & { entries?: Record<string, EntryKind>; files?: string[]; registry?: RegistryPaths | Error } = {}) {
  const entries = over.entries ?? {}
  const files = new Set((over.files ?? []).map((f) => f.toLowerCase()))
  const log = vi.fn()
  const appendUserPath = vi.fn(async (_folder: string): Promise<UserPathAppendResult> => ({ outcome: 'added', broadcast: true }))
  const d: InstallFolderDeps = {
    platform: 'win32',
    home: HOME,
    env: { Path: w('C:/Windows/system32;') + NPM, USERPROFILE: HOME },
    entryKind: async (p) => entries[p] ?? 'none',
    isFile: async (p) => files.has(p.toLowerCase()),
    readRegistry: async () => {
      const r = over.registry ?? { machine: { kind: 'ExpandString', data: w('%SystemRoot%/system32') }, user: { kind: 'ExpandString', data: w('%USERPROFILE%/AppData/Roaming/npm') } }
      if (r instanceof Error) throw r
      return r
    },
    appendUserPath,
    loginShell: () => '/bin/zsh',
    exists: () => false,
    log,
    ...over,
  }
  return { d, log, appendUserPath }
}

const INSTALLED = { [LOCAL_BIN]: 'dir', [CLAUDE_EXE]: 'file' } as Record<string, EntryKind>

describe('what a check that found nothing says (Windows)', () => {
  it("claude.exe in Anthropic's folder, which neither PATH names: Add it to PATH for me, the folder shown, never the real path", async () => {
    const { d } = deps({ entries: INSTALLED })
    const hint = await pathHintFor('claude', d)
    expect(hint).toEqual({ kind: 'add-to-path', folder: '%USERPROFILE%' + BS + '.local' + BS + 'bin' })
    expect(JSON.stringify(hint)).not.toContain('Users')
  })

  it('a link there (or a folder that is a link) is not taken for an install', async () => {
    for (const entries of [{ [LOCAL_BIN]: 'dir', [CLAUDE_EXE]: 'link' }, { [LOCAL_BIN]: 'link', [CLAUDE_EXE]: 'file' }, { [LOCAL_BIN]: 'dir' }] as Array<Record<string, EntryKind>>) {
      expect(await pathHintFor('claude', deps({ entries }).d), JSON.stringify(entries)).toBeUndefined()
    }
  })

  it('the folder already in the registry PATH but not taken in by this process: a restart is what helps', async () => {
    const { d } = deps({ entries: INSTALLED, registry: { machine: null, user: { kind: 'ExpandString', data: w('%USERPROFILE%/.local/bin/') } } })
    expect(await pathHintFor('claude', d)).toEqual({ kind: 'restart' })
  })

  it('not in that folder: a restart is advised only when the tool is in a folder the registry PATH names', async () => {
    const reg = { machine: null, user: { kind: 'String', data: w('D:/tools') } }
    expect(await pathHintFor('claude', deps({ registry: reg, files: [w('D:/tools/claude.cmd')] }).d)).toEqual({ kind: 'restart' })
    expect(await pathHintFor('claude', deps({ registry: reg }).d)).toBeUndefined()
    expect(await pathHintFor('codex', deps({ registry: reg, files: [w('D:/tools/codex.exe')] }).d)).toEqual({ kind: 'restart' })
    expect(await pathHintFor('claude', deps({ registry: new Error('no answer') }).d)).toBeUndefined()
  })

  it("Codex on Windows has no folder of its own to add: OpenAI's installer puts its folder on PATH itself", async () => {
    const codexExe = w('C:/Users/u/.local/bin/codex.exe')
    expect(await pathHintFor('codex', deps({ entries: { [LOCAL_BIN]: 'dir', [codexExe]: 'file' } }).d)).toBeUndefined()
  })
})

describe('what a check that found nothing says (macOS and Linux): the line and the file, never an edit', () => {
  const posix = (shell: string, platform: NodeJS.Platform, files: string[], exists: string[] = []) => deps({
    platform, home: '/home/u', env: { PATH: '/usr/bin' }, files, loginShell: () => shell, exists: (p) => exists.includes(p),
  }).d

  it('Claude Code and Codex in ~/.local/bin, which the login shell misses: the shell file it reads and the exact line', async () => {
    expect(await pathHintFor('claude', posix('/bin/zsh', 'darwin', ['/home/u/.local/bin/claude']))).toEqual({
      kind: 'shell-profile', folder: '~/.local/bin', file: '~/.zprofile', line: 'export PATH="$HOME/.local/bin:$PATH"',
    })
    expect(await pathHintFor('codex', posix('/usr/bin/bash', 'linux', ['/home/u/.local/bin/codex'], ['/home/u/.profile']))).toEqual({
      kind: 'shell-profile', folder: '~/.local/bin', file: '~/.profile', line: POSIX_PATH_LINE,
    })
    expect(await pathHintFor('claude', posix('/bin/zsh', 'darwin', []))).toBeUndefined()
  })

  it('the file a login shell reads: zsh .zprofile; bash the first of .bash_profile, .bash_login, .profile; fish its config', () => {
    expect(shellProfileFor('/bin/zsh', 'darwin', '/Users/u', {}, () => false)).toEqual({ file: '~/.zprofile', line: POSIX_PATH_LINE })
    expect(shellProfileFor('/bin/zsh', 'linux', '/home/u', { ZDOTDIR: '/home/u/.zsh' }, () => false).file).toBe('$ZDOTDIR/.zprofile')
    const has = (...names: string[]) => (p: string) => names.some((n) => p === path.posix.join('/home/u', n))
    expect(shellProfileFor('/bin/bash', 'linux', '/home/u', {}, has('.bash_login', '.profile')).file).toBe('~/.bash_login')
    expect(shellProfileFor('/bin/bash', 'linux', '/home/u', {}, has('.profile')).file).toBe('~/.profile')
    expect(shellProfileFor('/bin/bash', 'linux', '/home/u', {}, has()).file).toBe('~/.profile')
    expect(shellProfileFor('/bin/bash', 'darwin', '/Users/u', {}, () => false).file).toBe('~/.bash_profile')
    expect(shellProfileFor('/usr/bin/fish', 'linux', '/home/u', {}, () => false)).toEqual({ file: '~/.config/fish/config.fish', line: FISH_PATH_LINE })
    expect(shellProfileFor('/bin/dash', 'linux', '/home/u', {}, () => false).file).toBe('~/.profile')
  })
})

describe('Add it to PATH for me: only ever the one folder main computes, appended', () => {
  it('appends exactly home\\.local\\bin to the user PATH, then to this process\'s PATH, at the end, nothing else changed', async () => {
    const { d, appendUserPath, log } = deps({ entries: INSTALLED })
    const before = d.env.Path!
    expect(await addToolFolderToPath('claude', d)).toEqual({ outcome: 'added' })
    expect(appendUserPath).toHaveBeenCalledTimes(1)
    expect(appendUserPath).toHaveBeenCalledWith(LOCAL_BIN)
    expect(d.env.Path).toBe(`${before};${LOCAL_BIN}`)
    expect(d.env.Path!.split(';').slice(0, before.split(';').length)).toEqual(before.split(';'))
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain(LOCAL_BIN)
    expect(log.mock.calls[0][0]).toMatch(/written/)
  })

  it('the folder is computed from the home folder alone: whatever the environment says, it is the same one', async () => {
    const { d, appendUserPath } = deps({ entries: INSTALLED })
    d.env.USERPROFILE = w('D:/elsewhere')
    d.env.LOCALAPPDATA = w('D:/evil')
    await addToolFolderToPath('claude', d)
    expect(appendUserPath).toHaveBeenCalledWith(path.win32.join(HOME, '.local', 'bin'))
  })

  it('already on the registry PATH: nothing written, and this process takes the folder in', async () => {
    const { d, appendUserPath } = deps({ entries: INSTALLED })
    appendUserPath.mockResolvedValueOnce({ outcome: 'already' })
    expect(await addToolFolderToPath('claude', d)).toEqual({ outcome: 'already' })
    expect(d.env.Path!.endsWith(`;${LOCAL_BIN}`)).toBe(true)
  })

  it('refused, with nothing written, when the tool is not there as a regular file, off Windows, or for a provider with no folder', async () => {
    for (const entries of [{}, { [LOCAL_BIN]: 'dir', [CLAUDE_EXE]: 'link' }, { [LOCAL_BIN]: 'link', [CLAUDE_EXE]: 'file' }] as Array<Record<string, EntryKind>>) {
      const { d, appendUserPath } = deps({ entries })
      expect(await addToolFolderToPath('claude', d)).toMatchObject({ outcome: 'refused' })
      expect(appendUserPath).not.toHaveBeenCalled()
    }
    const codex = deps({ entries: INSTALLED })
    expect(await addToolFolderToPath('codex', codex.d)).toMatchObject({ outcome: 'refused' })
    const mac = deps({ entries: INSTALLED, platform: 'darwin', home: '/Users/u' })
    expect(await addToolFolderToPath('claude', mac.d)).toMatchObject({ outcome: 'refused' })
    expect(codex.appendUserPath).not.toHaveBeenCalled()
    expect(mac.appendUserPath).not.toHaveBeenCalled()
  })

  it('a write that fails, or a PATH that keeps changing, changes nothing here and is logged with the folder', async () => {
    const { d, appendUserPath, log } = deps({ entries: INSTALLED })
    const before = d.env.Path
    appendUserPath.mockRejectedValueOnce(new Error('powershell refused'))
    expect(await addToolFolderToPath('claude', d)).toMatchObject({ outcome: 'failed' })
    appendUserPath.mockResolvedValueOnce({ outcome: 'changed' })
    expect(await addToolFolderToPath('claude', d)).toMatchObject({ outcome: 'failed' })
    expect(d.env.Path).toBe(before)
    expect(log).toHaveBeenCalledTimes(2)
    for (const [line] of log.mock.calls) expect(line).toContain(LOCAL_BIN)
  })
})
