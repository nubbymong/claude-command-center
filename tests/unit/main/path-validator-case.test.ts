// The account-folder checks' real-path test on a disk or folder that keeps
// names in another case apart. The real path the file system gives back must
// be the path that reached it; a spelling that differs only in case passes
// only where the folder holding that name reads both spellings as one entry.
// Pure: the helper is driven through an injected file system, and the callers
// (the memory-file check, the memories listing, the log folder) through the
// in-memory one of tests/helpers/fake-account-fs.ts, in Windows and POSIX
// form whatever the host. No real file is touched and no link is planted.
import { describe, it, expect, vi } from 'vitest'
import type { BigIntStats } from 'node:fs'
import { createFakeAccountFs } from '../../helpers/fake-account-fs'
import type { FakeAccountFs } from '../../helpers/fake-account-fs'
import { AccountPathRefused, folderIgnoresCase, isOwnRealPath, validateAccountMemoryPath } from '../../../src/main/utils/path-validator'
import type { FolderCheckFs } from '../../../src/main/utils/path-validator'
import { scanAccountMemories } from '../../../src/main/account-memories'
import { openAccountLogFolder } from '../../../src/main/account-folders'
import type { AccountFolderSet } from '../../../src/main/account-folders'

/** A file system that answers lstat from a table: each name an entry with a
 *  device and file id; `ignoreCase` reads names in any case. */
function tableFs(entries: Record<string, { dev?: bigint; ino: bigint }>, ignoreCase: boolean) {
  const key = (p: string) => (ignoreCase ? p.toLowerCase() : p)
  const table = new Map(Object.entries(entries).map(([p, e]) => [key(p), { dev: e.dev ?? 7n, ino: e.ino }]))
  const calls: string[] = []
  const files: FolderCheckFs = {
    lstat: async (p: string) => {
      calls.push(p)
      const e = table.get(key(p))
      if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { dev: e.dev, ino: e.ino } as unknown as BigIntStats
    },
    realpath: async () => { throw new Error('not asked') },
  }
  return { files, calls }
}

describe('a case-sensitive folder compares the real path exactly', () => {
  it('an exact match answers without a file call, on every platform', async () => {
    const { files, calls } = tableFs({}, false)
    expect(await isOwnRealPath('C:\\Users\\me\\m\\a.md', 'C:/Users/me/m/a.md/', 'win32', files)).toBe(true)
    expect(await isOwnRealPath('/Users/me/m/a.md', '/Users/me/m/a.md', 'darwin', files)).toBe(true)
    expect(await isOwnRealPath('/h/m', '/h/m/', 'linux', files)).toBe(true)
    expect(calls).toEqual([])
  })

  it('a path that differs by more than case is another path, without a file call', async () => {
    const { files, calls } = tableFs({}, true)
    expect(await isOwnRealPath('C:\\PROGRA~1\\m', 'C:\\Program Files\\m', 'win32', files)).toBe(false)
    expect(await isOwnRealPath('\\\\host\\share\\m', 'Z:\\m', 'win32', files)).toBe(false)
    expect(await isOwnRealPath('/elsewhere/m', '/h/m', 'darwin', files)).toBe(false)
    // Linux compares exactly: another case is another path.
    expect(await isOwnRealPath('/h/M', '/h/m', 'linux', files)).toBe(false)
    expect(calls).toEqual([])
  })

  for (const platform of ['win32', 'darwin'] as const) {
    const at = (...names: string[]) => (platform === 'win32' ? `C:\\${names.join('\\')}` : `/${names.join('/')}`)

    it(`${platform}: a name in another case is refused where the folder keeps the two apart`, async () => {
      // The disk's own spelling, and another entry (a link) under the other spelling.
      const { files } = tableFs({ [at('h', 'Mem')]: { ino: 10n }, [at('h', 'mem')]: { ino: 11n } }, false)
      expect(await isOwnRealPath(at('h', 'Mem', 'a.md'), at('h', 'mem', 'a.md'), platform, files)).toBe(false)
      expect(await folderIgnoresCase(at('h'), 'Mem', 'mem', platform, files)).toBe(false)
    })

    it(`${platform}: refused where the other spelling is missing, on another device, or cannot be looked at`, async () => {
      const missing = tableFs({ [at('h', 'Mem')]: { ino: 10n } }, false)
      expect(await isOwnRealPath(at('h', 'Mem'), at('h', 'mem'), platform, missing.files)).toBe(false)
      const otherDevice = tableFs({ [at('h', 'Mem')]: { dev: 1n, ino: 10n }, [at('h', 'mem')]: { dev: 2n, ino: 10n } }, false)
      expect(await isOwnRealPath(at('h', 'Mem'), at('h', 'mem'), platform, otherDevice.files)).toBe(false)
      const failing: FolderCheckFs = { lstat: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }, realpath: async () => '' }
      expect(await isOwnRealPath(at('h', 'Mem'), at('h', 'mem'), platform, failing)).toBe(false)
    })

    it(`${platform}: accepted where the folder reads both spellings as one entry, asking only about the names that differ`, async () => {
      const { files, calls } = tableFs({ [at('Users')]: { ino: 2n }, [at('Users', 'Me')]: { ino: 3n }, [at('Users', 'Me', 'mem')]: { ino: 4n } }, true)
      expect(await isOwnRealPath(at('Users', 'Me', 'mem', 'a.md'), at('users', 'me', 'mem', 'a.md'), platform, files)).toBe(true)
      expect(calls.sort()).toEqual([at('Users'), at('users'), at('Users', 'Me'), at('Users', 'me')].sort())
    })

    it(`${platform}: a file system that gives no file ids never counts as reading both spellings as one`, async () => {
      const { files } = tableFs({ [at('h', 'Mem')]: { ino: 0n }, [at('h', 'mem')]: { ino: 0n } }, false)
      expect(await isOwnRealPath(at('h', 'Mem', 'a.md'), at('h', 'mem', 'a.md'), platform, files)).toBe(false)
      expect(await folderIgnoresCase(at('h'), 'Mem', 'mem', platform, files)).toBe(false)
    })

    it(`${platform}: one folder that keeps names apart is enough to refuse`, async () => {
      // `Users` reads any case; `Me` holds a second entry under `mem`.
      const entries = { [at('Users')]: { ino: 2n }, [at('users')]: { ino: 2n }, [at('Users', 'Me', 'Mem')]: { ino: 4n }, [at('Users', 'Me', 'mem')]: { ino: 5n } }
      const { files } = tableFs(entries, false)
      expect(await isOwnRealPath(at('Users', 'Me', 'Mem'), at('users', 'Me', 'mem'), platform, files)).toBe(false)
    })
  }

  it('win32: a drive letter is the same drive in any case, without a file call', async () => {
    const { files, calls } = tableFs({}, false)
    expect(await isOwnRealPath('C:\\m', 'c:\\m', 'win32', files)).toBe(true)
    expect(await isOwnRealPath('C:\\', 'c:\\', 'win32', files)).toBe(true)
    expect(calls).toEqual([])
  })
})

// -- The callers, through the in-memory file system ---------------------------

const refusedWith = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e) => e)
  expect(err).toBeInstanceOf(AccountPathRefused)
  expect((err as AccountPathRefused).code).toBe('refused')
}
const memSet = (home: string, sep: string): AccountFolderSet => ({
  providerId: 'claude', accountId: 'acct-1', external: false,
  logDir: `${home}${sep}log`, memoriesDir: `${home}${sep}memories`, configFile: `${home}${sep}config.toml`,
})

describe('the memory-file check: a case-sensitive folder compares the real path exactly', () => {
  it('win32, a folder with case sensitivity on: a link to a name in another case is refused', async () => {
    const cs = createFakeAccountFs('win32', { caseSensitive: true })
    const MEM = 'C:\\h\\memories'
    cs.writeFile(`${MEM}\\NOTES\\a.md`, '# A')
    cs.symlink(`${MEM}\\NOTES`, `${MEM}\\notes`)
    await refusedWith(validateAccountMemoryPath(`${MEM}\\notes\\a.md`, [MEM], { platform: 'win32', fs: cs as never }))
    // The folder's own spelling still passes.
    expect((await validateAccountMemoryPath(`${MEM}\\NOTES\\a.md`, [MEM], { platform: 'win32', fs: cs as never })).path).toBe(`${MEM}\\NOTES\\a.md`)
  })

  it('macOS on a case-sensitive disk: a link to a name in another case is refused', async () => {
    const px = createFakeAccountFs('linux')
    px.writeFile('/h/memories/NOTES/a.md', '# A')
    px.symlink('/h/memories/NOTES', '/h/memories/notes')
    await refusedWith(validateAccountMemoryPath('/h/memories/notes/a.md', ['/h/memories'], { platform: 'darwin', fs: px as never }))
    expect((await validateAccountMemoryPath('/h/memories/NOTES/a.md', ['/h/memories'], { platform: 'darwin', fs: px as never })).path).toBe('/h/memories/NOTES/a.md')
  })

  it('win32, a folder that reads any case: a name in another case than the disk is the same file', async () => {
    const ci = createFakeAccountFs('win32')
    const MEM = 'C:\\h\\memories'
    ci.writeFile(`${MEM}\\Notes\\a.md`, '# A')
    const t = await validateAccountMemoryPath(`${MEM}\\notes\\a.md`, [MEM], { platform: 'win32', fs: ci as never })
    expect(t.path).toBe(`${MEM}\\notes\\a.md`)
  })

  it('an exact match never probes: the only lstat is the file itself', async () => {
    const ci = createFakeAccountFs('win32')
    const MEM = 'C:\\h\\memories'
    ci.writeFile(`${MEM}\\a.md`, '# A')
    await validateAccountMemoryPath(`${MEM}\\a.md`, [MEM], { platform: 'win32', fs: ci as never })
    expect(ci.calls.lstat).toEqual([`${MEM}\\a.md`])
  })
})

describe('the memories listing: a case-sensitive folder compares the real path exactly', () => {
  const plant = (fs: FakeAccountFs, real: string, sep: string) => {
    fs.writeFile(`${real}${sep}memories${sep}MEMORY.md`, '# Memory\n\nkept')
  }

  it('win32: a memories folder reached through a link to a folder named in another case is not listed', async () => {
    const cs = createFakeAccountFs('win32', { caseSensitive: true })
    plant(cs, 'C:\\r\\ACCT', '\\')
    cs.symlink('C:\\r\\ACCT', 'C:\\r\\acct')
    const [m] = await scanAccountMemories([memSet('C:\\r\\acct', '\\')], { fs: cs as never, platform: 'win32' })
    expect(m.state).toBe('unreadable')
    expect(m.files).toEqual([])
  })

  it('macOS on a case-sensitive disk: the same', async () => {
    const px = createFakeAccountFs('linux')
    plant(px, '/r/ACCT', '/')
    px.symlink('/r/ACCT', '/r/acct')
    const [m] = await scanAccountMemories([memSet('/r/acct', '/')], { fs: px as never, platform: 'darwin' })
    expect(m.state).toBe('unreadable')
    expect(m.files).toEqual([])
  })

  it('win32, a folder that reads any case: a memories folder named in another case than the disk is listed', async () => {
    const ci = createFakeAccountFs('win32')
    plant(ci, 'C:\\r\\Acct', '\\')
    const [m] = await scanAccountMemories([memSet('C:\\r\\acct', '\\')], { fs: ci as never, platform: 'win32' })
    expect(m.state).toBe('present')
    expect(m.files.map((f) => f.relPath)).toEqual(['MEMORY.md'])
  })
})

describe('the memories listing re-checks each folder and file at its own real path, exactly', () => {
  // A folder under the listing, swapped for a link to a folder of the same
  // name in another case after the walk looked at it: on a disk or folder that
  // keeps the two names apart, that link reaches another folder.
  const forms = [
    { platform: 'win32' as const, make: () => createFakeAccountFs('win32', { caseSensitive: true }), home: 'C:\\h', sep: '\\' },
    { platform: 'darwin' as const, make: () => createFakeAccountFs('linux'), home: '/h', sep: '/' },
  ]
  const swapOn = (fs: FakeAccountFs, when: string, folder: string, to: string) => {
    const realRealpath = fs.realpath.bind(fs)
    const state = { swapped: false }
    fs.realpath = (async (p: string) => {
      if (!state.swapped && p === when) { state.swapped = true; fs.remove(folder); fs.symlink(to, folder) }
      return realRealpath(p)
    }) as typeof fs.realpath
    return state
  }

  for (const { platform, make, home, sep } of forms) {
    const MEM = `${home}${sep}memories`
    const other = `${home}${sep}Memories${sep}Sub`

    it(`${platform}: a folder swapped after the walk saw it is never read through`, async () => {
      const fs = make()
      fs.writeFile(`${MEM}${sep}MEMORY.md`, '# M')
      fs.mkdir(`${MEM}${sep}Sub`)
      fs.writeFile(`${other}${sep}other.md`, '# other')
      const state = swapOn(fs, `${MEM}${sep}Sub`, `${MEM}${sep}Sub`, other)
      const [m] = await scanAccountMemories([memSet(home, sep)], { fs: fs as never, platform })
      expect(state.swapped).toBe(true)
      expect(fs.calls.readdir).not.toContain(`${MEM}${sep}Sub`)
      expect(m.files.map((f) => f.relPath)).toEqual(['MEMORY.md'])
    })

    it(`${platform}: a file whose folder is swapped after the walk listed it is never opened`, async () => {
      const fs = make()
      fs.writeFile(`${MEM}${sep}Sub${sep}a.md`, '# A')
      fs.writeFile(`${other}${sep}a.md`, '# other')
      const state = swapOn(fs, `${MEM}${sep}Sub${sep}a.md`, `${MEM}${sep}Sub`, other)
      const [m] = await scanAccountMemories([memSet(home, sep)], { fs: fs as never, platform })
      expect(state.swapped).toBe(true)
      expect(fs.calls.open).not.toContain(`${MEM}${sep}Sub${sep}a.md`)
      expect(m.files).toEqual([])
    })
  }
})

describe('the log folder: a case-sensitive folder compares the real path exactly', () => {
  const deps = (fs: FakeAccountFs, platform: NodeJS.Platform) => ({
    fs: fs as never, platform, openPath: vi.fn(async () => ''), showItemInFolder: vi.fn(),
  })

  it('win32: a log folder reached through a link to a folder named in another case is refused, never opened', async () => {
    const cs = createFakeAccountFs('win32', { caseSensitive: true })
    cs.mkdir('C:\\r\\ACCT\\log')
    cs.symlink('C:\\r\\ACCT', 'C:\\r\\acct')
    const d = deps(cs, 'win32')
    expect(await openAccountLogFolder({ accountId: 'acct-1', folder: 'log' }, async () => [memSet('C:\\r\\acct', '\\')], d)).toEqual({ ok: false, code: 'refused' })
    expect(d.openPath).not.toHaveBeenCalled()
  })

  it('macOS on a case-sensitive disk: the same', async () => {
    const px = createFakeAccountFs('linux')
    px.mkdir('/r/ACCT/log')
    px.symlink('/r/ACCT', '/r/acct')
    const d = deps(px, 'darwin')
    expect(await openAccountLogFolder({ accountId: 'acct-1', folder: 'log' }, async () => [memSet('/r/acct', '/')], d)).toEqual({ ok: false, code: 'refused' })
    expect(d.openPath).not.toHaveBeenCalled()
  })

  it('win32, a folder that reads any case: a log folder named in another case than the disk opens', async () => {
    const ci = createFakeAccountFs('win32')
    ci.mkdir('C:\\r\\Acct\\log')
    const d = deps(ci, 'win32')
    expect(await openAccountLogFolder({ accountId: 'acct-1', folder: 'log' }, async () => [memSet('C:\\r\\acct', '\\')], d)).toEqual({ ok: true })
    expect(d.openPath).toHaveBeenCalledWith('C:\\r\\Acct\\log')
  })
})
