// HOST QUARANTINE: this suite makes a temp folder and plants a junction (Windows) or a symbolic link (elsewhere) in it. [CI] [VM] only -- never run on the owner's machine.
//
// Add it to PATH for me writes the user's PATH in the registry only for a
// regular file in a real folder (the PATH finding of the first-run test,
// 2026-10-10; ADR-024). The real install-folder deps look at an entry itself
// (lstat), so a real junction or symbolic link reads as a link, never as the
// folder it points at, and the folder check refuses it before any write.
// The registry module's reader and writer are spies: nothing here can reach
// the registry or the user's PATH.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const reg = vi.hoisted(() => ({
  readRegistryPaths: vi.fn(async () => { throw new Error('the registry is not read in this suite') }),
  appendFolderToUserPath: vi.fn(async () => { throw new Error('the user PATH is not written in this suite') }),
}))
vi.mock('../../../src/main/windows-registry-path', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/windows-registry-path')>()),
  readRegistryPaths: reg.readRegistryPaths,
  appendFolderToUserPath: reg.appendFolderToUserPath,
}))

import { installFolderDeps } from '../../../src/main/install-folder-path'

const PREFIX = 'ccc-install-folder-links-'
let tmp = ''
let real = ''
let tool = ''
let linked = ''
const link = (target: string, at: string) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')

beforeAll(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  real = path.join(tmp, 'real')
  tool = path.join(real, 'claude.exe')
  linked = path.join(tmp, 'linked')
  fs.mkdirSync(real)
  fs.writeFileSync(tool, '')
  link(real, linked)
})

afterAll(() => {
  // TEST CLEANUP GUARD: only this suite's own folder, by its prefix and
  // parent; the link is removed first so nothing is followed out of it.
  if (tmp === '') return
  const tmpReal = fs.realpathSync.native(os.tmpdir())
  if (!path.basename(tmp).startsWith(PREFIX) || path.dirname(tmp) !== tmpReal) return
  try { if (fs.lstatSync(linked).isSymbolicLink()) fs.rmdirSync(linked) } catch { /* gone, or not a folder link */ }
  try { if (fs.lstatSync(linked).isSymbolicLink()) fs.unlinkSync(linked) } catch { /* gone */ }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

describe('the real deps look at an entry itself: a link is a link, never followed', () => {
  it('a junction or symbolic link to a folder reads as a link; the folder, its file and a missing path read as what they are', async () => {
    const d = installFolderDeps()
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true)
    expect(await d.entryKind(linked)).toBe('link')
    expect(await d.entryKind(real)).toBe('dir')
    expect(await d.entryKind(tool)).toBe('file')
    expect(await d.entryKind(path.join(tmp, 'not-there'))).toBe('none')
    expect(reg.readRegistryPaths).not.toHaveBeenCalled()
    expect(reg.appendFolderToUserPath).not.toHaveBeenCalled()
  })

  it('isFile follows a link (stat), as a PATH lookup does: the file reached through it is a file', async () => {
    expect(await installFolderDeps().isFile(path.join(linked, 'claude.exe'))).toBe(true)
  })
})
