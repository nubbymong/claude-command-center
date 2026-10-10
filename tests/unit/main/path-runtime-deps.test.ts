// The PATH refresh and Add it to PATH for me run on their REAL deps (owner
// decision D4 and the PATH finding of the first-run test, 2026-10-10;
// ADR-024). The helpers are tested with stand-in deps elsewhere
// (windows-path-refresh, install-folder-path); this suite holds the wiring
// those stand-ins replace, so a later edit that stubs it goes red:
//   - the refresh reads the system and user PATH through the registry
//     module's reader (the one that keeps every character), for this
//     process's environment, and logs a read that fails, once, with why;
//   - the install-folder deps read the registry and append to the user PATH
//     through the same module, look at an entry itself (lstat: a link is a
//     link, never followed), and log to the app log.
// The registry module's reader and writer are spies here and never run, the
// app log is a spy, and the file checks only read (the repo's own
// package.json, its folder, a path that is not there). The link case is a
// stand-in from lstat; a real junction or symbolic link is planted by
// install-folder-path-links-real.test.ts, which runs in CI and on the VM.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { RegistryPaths, UserPathAppendResult } from '../../../src/main/windows-registry-path'

const reg = vi.hoisted(() => ({
  readRegistryPaths: vi.fn<() => Promise<RegistryPaths>>(),
  appendFolderToUserPath: vi.fn<(folder: string) => Promise<UserPathAppendResult>>(),
}))
vi.mock('../../../src/main/windows-registry-path', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/windows-registry-path')>()),
  readRegistryPaths: reg.readRegistryPaths,
  appendFolderToUserPath: reg.appendFolderToUserPath,
}))
const logInfo = vi.hoisted(() => vi.fn<(...args: unknown[]) => void>())
vi.mock('../../../src/main/debug-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/debug-logger')>()),
  logInfo,
}))

import { refreshWindowsPath, refreshWindowsPathDeps } from '../../../src/main/windows-path-refresh'
import { installFolderDeps } from '../../../src/main/install-folder-path'

const BS = String.fromCharCode(92)
const w = (s: string) => s.replace(/\//g, BS)
const ROOT = path.resolve(__dirname, '..', '..', '..')
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const VALUES: RegistryPaths = {
  machine: { kind: 'ExpandString', data: w('%SystemRoot%/system32') },
  user: { kind: 'String', data: w('D:/tools') },
}

beforeEach(() => {
  reg.readRegistryPaths.mockReset()
  reg.readRegistryPaths.mockRejectedValue(new Error('the stand-in reader was not given an answer'))
  reg.appendFolderToUserPath.mockReset()
  reg.appendFolderToUserPath.mockRejectedValue(new Error('the stand-in writer was not given an answer'))
  logInfo.mockReset()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
})

describe('the PATH refresh runs on its real deps', () => {
  it("reads the system and user PATH through the registry module's reader, for this process's environment", async () => {
    const d = refreshWindowsPathDeps()
    expect(d.platform).toBe(process.platform)
    expect(d.env).toBe(process.env)
    reg.readRegistryPaths.mockResolvedValueOnce(VALUES)
    await expect(d.readValues()).resolves.toBe(VALUES)
    expect(reg.readRegistryPaths).toHaveBeenCalledTimes(1)
    expect(logInfo).not.toHaveBeenCalled()
  })

  it('a read that fails is logged once, with why', () => {
    const d = refreshWindowsPathDeps()
    expect(d.onReadFailure).toBeTypeOf('function')
    d.onReadFailure!('x')
    expect(logInfo).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledWith('[path] Could not read PATH from the registry, so nothing was added: x')
  })

  it('refreshWindowsPath goes through them: on Windows a read that fails is logged once, adds nothing and changes nothing', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const before = { ...process.env }
    reg.readRegistryPaths.mockRejectedValueOnce(new Error('Windows PowerShell was not allowed to run'))
    expect(await refreshWindowsPath()).toEqual([])
    expect(reg.readRegistryPaths).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledWith('[path] Could not read PATH from the registry, so nothing was added: Windows PowerShell was not allowed to run')
    expect({ ...process.env }).toEqual(before)
  })
})

describe('Add it to PATH for me runs on its real deps', () => {
  it("reads the registry and appends the one folder through the registry module, for this process, and logs to the app log", async () => {
    const d = installFolderDeps()
    expect(d.platform).toBe(process.platform)
    expect(d.home).toBe(os.homedir())
    expect(d.env).toBe(process.env)
    reg.readRegistryPaths.mockResolvedValueOnce(VALUES)
    await expect(d.readRegistry()).resolves.toBe(VALUES)
    expect(reg.readRegistryPaths).toHaveBeenCalledTimes(1)
    const answer: UserPathAppendResult = { outcome: 'added', broadcast: false }
    reg.appendFolderToUserPath.mockResolvedValueOnce(answer)
    const folder = w('C:/Users/u/.local/bin')
    await expect(d.appendUserPath(folder)).resolves.toBe(answer)
    expect(reg.appendFolderToUserPath).toHaveBeenCalledTimes(1)
    expect(reg.appendFolderToUserPath).toHaveBeenCalledWith(folder)
    expect(logInfo).not.toHaveBeenCalled()
    d.log('[path] one line')
    expect(logInfo).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledWith('[path] one line')
  })

  it('looks at an entry itself: a file is a file, a folder a folder, a path that is not there nothing; isFile and exists agree', async () => {
    const d = installFolderDeps()
    const file = path.join(ROOT, 'package.json')
    const missing = path.join(ROOT, `no-such-entry-${process.pid}`)
    expect(await d.entryKind(file)).toBe('file')
    expect(await d.entryKind(ROOT)).toBe('dir')
    expect(await d.entryKind(missing)).toBe('none')
    expect(await d.isFile(file)).toBe(true)
    expect(await d.isFile(ROOT)).toBe(false)
    expect(await d.isFile(missing)).toBe(false)
    expect(d.exists(file)).toBe(true)
    expect(d.exists(missing)).toBe(false)
  })

  it('a link is a link, never followed: the entry is looked at with lstat, never with stat', async () => {
    // What Node reports for a junction or a symbolic link to a folder: lstat
    // sees the link, stat the folder it points at.
    const asLink = { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false } as unknown as fs.Stats
    const asFolder = { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false } as unknown as fs.Stats
    const at = path.join(ROOT, 'stand-in-link')
    const realLstat = fs.promises.lstat
    const realStat = fs.promises.stat
    const lstat = vi.spyOn(fs.promises, 'lstat').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) =>
      p === at ? Promise.resolve(asLink) : (realLstat as (...a: unknown[]) => Promise<fs.Stats>)(p, ...rest)) as typeof fs.promises.lstat)
    const stat = vi.spyOn(fs.promises, 'stat').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) =>
      p === at ? Promise.resolve(asFolder) : (realStat as (...a: unknown[]) => Promise<fs.Stats>)(p, ...rest)) as typeof fs.promises.stat)
    try {
      expect(await installFolderDeps().entryKind(at)).toBe('link')
      expect(lstat).toHaveBeenCalledWith(at)
      expect(stat).not.toHaveBeenCalledWith(at)
    } finally {
      lstat.mockRestore()
      stat.mockRestore()
    }
  })
})
