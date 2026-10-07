// HOST QUARANTINE: plants junctions and symbolic links. [CI] [VM] only -- never run on the owner's machine.
/**
 * WP2 PR 4, P4.3: the help folder's rebuild removes what a sandboxed model put
 * there WITHOUT following a link of any kind.
 *
 * Codex grants its sandbox write access to the session's working folder (PB8),
 * so a junction or symbolic link inside the help folder is the expected attack
 * on the rebuild: a recursive delete that followed it would empty whatever it
 * points at, with the user's own rights. Only the link may go; its target and
 * everything in it must survive, and the folder must end as exactly the app's
 * own files.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../src/main/debug-logger', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/account-profiles', () => ({
  mkdirSecure: (p: string) => fs.mkdirSync(p, { recursive: true }),
  hardenCredentialDir: () => true,
  atomicWriteSecure: (f: string, d: string | Uint8Array) => fs.writeFileSync(f, d, { flag: 'wx' }),
}))

const { ensureHelpWorkspace } = await import('../../../src/main/help-workspace')

let tmp: string
let outside: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-help-links-'))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-help-outside-'))
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me')
  fs.mkdirSync(path.join(outside, 'sub'))
  fs.writeFileSync(path.join(outside, 'sub', 'deeper.txt'), 'keep me too')
})
afterEach(() => {
  // Links first, by unlink, so cleanup itself never follows one.
  const help = path.join(tmp, 'help')
  for (const name of fs.existsSync(help) ? fs.readdirSync(help) : []) {
    const p = path.join(help, name)
    if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p)
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

const opts = { appVersion: '9.9.9', platform: 'win32' as const }

describe('[CI] [VM] the rebuild never follows a link planted in the help folder', () => {
  it('a directory link (a junction on Windows) is removed; its target and everything in it survive', () => {
    const dir = ensureHelpWorkspace(tmp, opts)
    const pristine = fs.readdirSync(dir).sort()
    fs.symlinkSync(outside, path.join(dir, '.codex'), process.platform === 'win32' ? 'junction' : 'dir')
    ensureHelpWorkspace(tmp, opts)
    expect(fs.readdirSync(dir).sort()).toEqual(pristine)
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf-8')).toBe('keep me')
    expect(fs.readFileSync(path.join(outside, 'sub', 'deeper.txt'), 'utf-8')).toBe('keep me too')
  })

  it('a link nested a folder down is removed the same way', () => {
    const dir = ensureHelpWorkspace(tmp, opts)
    fs.mkdirSync(path.join(dir, 'skills'))
    fs.symlinkSync(outside, path.join(dir, 'skills', 'evil'), process.platform === 'win32' ? 'junction' : 'dir')
    ensureHelpWorkspace(tmp, opts)
    expect(fs.existsSync(path.join(dir, 'skills'))).toBe(false)
    expect(fs.readdirSync(outside).sort()).toEqual(['precious.txt', 'sub'])
  })

  it('AGENTS.md replaced by a file link: the link goes, its target is untouched, AGENTS.md is the app\'s again', (ctx) => {
    const dir = ensureHelpWorkspace(tmp, opts)
    const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'))
    fs.rmSync(path.join(dir, 'AGENTS.md'))
    try {
      fs.symlinkSync(path.join(outside, 'precious.txt'), path.join(dir, 'AGENTS.md'), 'file')
    } catch (err) {
      // A file symlink needs Developer Mode or the privilege on Windows; a
      // junction (above) does not. Skip only that, and report it as skipped.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip('a file symlink needs Developer Mode or the privilege on Windows')
      throw err
    }
    ensureHelpWorkspace(tmp, opts)
    expect(fs.lstatSync(path.join(dir, 'AGENTS.md')).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md')).equals(agents)).toBe(true)
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf-8')).toBe('keep me')
  })
})
