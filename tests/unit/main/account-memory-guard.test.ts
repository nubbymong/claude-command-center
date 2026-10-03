// [host] WP2 PR 4, P4.4 (row 55): the path guard beside validateMemoryPath for
// a provider account's own memories folder (Codex's `memories/`, a git
// repository), and the read and delete behind it. The file system is the
// in-memory one of tests/helpers/fake-account-fs.ts, in Windows and POSIX
// form whatever the host: no real file is touched, no link is planted. The
// same rules on real junctions are account-folders-links-real.test.ts's (CI
// and VM only).
import { describe, it, expect, beforeEach } from 'vitest'
import { createFakeAccountFs } from '../../helpers/fake-account-fs'
import type { FakeAccountFs } from '../../helpers/fake-account-fs'
import { PB6_MEMORIES } from '../../fixtures/codex/memories-pb6'
import {
  validateAccountMemoryPath, localPathFormProblem, samePathForm, pathInside, isGitSegment, AccountPathRefused,
} from '../../../src/main/utils/path-validator'
import { readAccountMemory, deleteAccountMemory, isUnderAccountMemories } from '../../../src/main/account-memories'
import { readCheckedFile } from '../../../src/main/account-folders'
import type { AccountFolderSet } from '../../../src/main/account-folders'

const HOME = 'C:\\Users\\me\\res\\codex-realms\\r1'
const MEM = `${HOME}\\memories`
const set: AccountFolderSet = { providerId: 'codex', accountId: 'acct-1', external: false, logDir: `${HOME}\\log`, memoriesDir: MEM, configFile: `${HOME}\\config.toml` }

let fake: FakeAccountFs
function plantPb6(fs: FakeAccountFs, root: string, sep: string): void {
  fs.mkdir(root)
  for (const e of PB6_MEMORIES) {
    const at = root + sep + e.rel.split('/').join(sep)
    if (e.kind === 'dir') fs.mkdir(at)
    else fs.writeFile(at, e.content ?? '')
  }
}
const refusedWith = async (p: Promise<unknown>, code: 'refused' | 'not-found') => {
  const err = await p.then(() => null, (e) => e)
  expect(err).toBeInstanceOf(AccountPathRefused)
  expect((err as AccountPathRefused).code).toBe(code)
  // The message names no path.
  expect((err as Error).message).not.toMatch(/[\\/]/)
}
const guard = (p: unknown, roots: readonly string[] = [MEM], fs: FakeAccountFs = fake, platform: NodeJS.Platform = 'win32') =>
  validateAccountMemoryPath(p, roots, { platform, fs: fs as never })

beforeEach(() => {
  fake = createFakeAccountFs('win32')
  plantPb6(fake, MEM, '\\')
})

describe('localPathFormProblem: the form alone, before any file call', () => {
  it.each([
    ['C:\\a\\b', null], ['C:/a/b', null], ['c:\\', null], ['C:\\a\\b\\', null], ['D:\\codex logs\\x.md', null],
    ['\\\\host\\share\\x', 'unc-or-device'], ['//host/share/x', 'unc-or-device'], ['\\\\?\\C:\\x', 'unc-or-device'],
    ['\\\\.\\C:\\x', 'unc-or-device'], ['\\??\\C:\\x', 'device'], ['C:x', 'not-fully-qualified'], ['\\x', 'not-fully-qualified'],
    ['x\\y', 'not-fully-qualified'], ['C:\\a\\..\\b', 'dot-segment'], ['C:\\a\\.\\b', 'dot-segment'], ['C:\\a\\\\b', 'empty-segment'],
    ['C:\\a\\b.', 'trailing-dot-or-space'], ['C:\\a \\b', 'trailing-dot-or-space'], ['C:\\a\\b:stream', 'stream'],
    ['C:\\a\\CON', 'device-name'], ['C:\\a\\nul.txt', 'device-name'], ['C:\\a\\com1', 'device-name'], ['C:\\a\\b?', 'reserved-character'],
    ['C:\\a\u0000b', 'control-character'], ['', 'empty'],
  ])('win32 %j -> %j', (p, want) => {
    expect(localPathFormProblem(p, 'win32')).toBe(want)
  })
  it.each([
    ['/a/b', null], ['/', null], ['/a/b/', null], ['a/b', 'not-fully-qualified'], ['~/a', 'not-fully-qualified'],
    ['//host/x', 'unc-or-device'], ['/a/../b', 'dot-segment'], ['/a//b', 'empty-segment'], ['/a\nb', 'control-character'],
  ])('posix %j -> %j', (p, want) => {
    expect(localPathFormProblem(p, 'linux')).toBe(want)
  })
  it('not a string', () => {
    expect(localPathFormProblem(undefined, 'win32')).toBe('empty')
    expect(localPathFormProblem(42, 'linux')).toBe('empty')
  })
})

describe('samePathForm, pathInside and isGitSegment', () => {
  it('Windows: either separator, a trailing separator, and the case Windows folds; never the Kelvin sign, dotless i, sharp s or a surrogate', () => {
    expect(samePathForm('C:\\A\\b', 'c:/a/B/', 'win32')).toBe(true)
    expect(samePathForm('C:\\', 'c:\\', 'win32')).toBe(true)
    // A non-ASCII letter pair is one name to NTFS (B-3: a home spelled in another case).
    expect(samePathForm('C:\\Users\\\u00d6zil\\codex-home', 'c:\\users\\\u00f6zil\\codex-home', 'win32')).toBe(true)
    expect(samePathForm('C:\\x\\\u212a', 'C:\\x\\k', 'win32')).toBe(false) // the Kelvin sign is not k
    expect(samePathForm('C:\\x\\\u0131', 'C:\\x\\I', 'win32')).toBe(false) // dotless i is not I
    expect(samePathForm('C:\\x\\\u0131', 'C:\\x\\i', 'win32')).toBe(false)
    expect(samePathForm('C:\\x\\stra\u00dfe', 'C:\\x\\STRASSE', 'win32')).toBe(false) // one unit is never two
    expect(samePathForm('C:\\x\\\u017f', 'C:\\x\\s', 'win32')).toBe(false) // long s
    expect(samePathForm('C:\\x\\\ud801\udc28', 'C:\\x\\\ud801\udc00', 'win32')).toBe(false) // a surrogate pair is never folded
    expect(samePathForm('/a/B', '/a/b', 'linux')).toBe(false)
    expect(samePathForm('/a/\u00d6', '/a/\u00f6', 'linux')).toBe(false)
    expect(samePathForm('/a/B/', '/a/b', 'darwin')).toBe(true)
    expect(samePathForm('/a/\u00d6', '/a/\u00f6', 'darwin')).toBe(true)
  })
  it('pathInside: strictly inside the root, by the same case rule, the rest as written', () => {
    expect(pathInside(MEM, `${MEM}\\extensions\\x.md`, 'win32')).toBe('extensions\\x.md')
    expect(pathInside('C:/m/', 'c:\\M\\x.md', 'win32')).toBe('x.md')
    expect(pathInside('C:\\', 'C:\\x', 'win32')).toBe('x')
    expect(pathInside('c:\\users\\\u00f6zil\\m', 'C:\\Users\\\u00d6zil\\m\\x.md', 'win32')).toBe('x.md')
    // B-6: a name that starts with two dots is inside.
    expect(pathInside(MEM, `${MEM}\\..notes.md`, 'win32')).toBe('..notes.md')
    for (const outside of [MEM, `${MEM}\\`, `${MEM}x\\a.md`, 'D:\\Users\\me\\res\\codex-realms\\r1\\memories\\a.md', `${HOME}\\auth.json`]) {
      expect(pathInside(MEM, outside, 'win32'), outside).toBeNull()
    }
    expect(pathInside('C:\\Users\\Nik\\m', 'C:\\Users\\Ni\u212a\\m\\x.md', 'win32')).toBeNull()
    expect(pathInside('/h/m', '/h/m/a/b.md', 'linux')).toBe('a/b.md')
    expect(pathInside('/h/m', '/h/M/a', 'linux')).toBeNull()
    expect(pathInside('/h/m', '/h/M/a', 'darwin')).toBe('a')
    expect(pathInside('/', '/a', 'linux')).toBe('a')
    expect(pathInside('C:\\', 'c:\\', 'win32')).toBeNull()
    expect(pathInside('/', '/', 'linux')).toBeNull()
  })
  it('.git in any case, and as Windows reads a trailing dot or space', () => {
    for (const n of ['.git', '.GIT', '.Git', '.git.', '.git ', '.git. .']) expect(isGitSegment(n), n).toBe(true)
    for (const n of ['git', '.gitignore', '.git-x', 'x.git', '..git']) expect(isGitSegment(n), n).toBe(false)
  })
})

describe('validateAccountMemoryPath', () => {
  it('lets through a plain file in the memories folder, nested or not', async () => {
    for (const rel of ['MEMORY.md', 'raw_memories.md', 'extensions\\ad_hoc\\instructions.md']) {
      const t = await guard(`${MEM}\\${rel}`)
      expect(t.path).toBe(`${MEM}\\${rel}`)
      expect(t.root).toBe(MEM)
      expect(t.ino).toBeGreaterThan(0n)
    }
  })

  it('refuses anything inside .git, in any spelling, before a file call', async () => {
    for (const rel of ['.git\\HEAD', '.git\\info\\notes.md', '.GIT\\config', 'extensions\\.git\\x.md']) {
      const before = fake.fileCalls()
      await refusedWith(guard(`${MEM}\\${rel}`), 'refused')
      expect(fake.fileCalls() - before, rel).toBe(0)
    }
    // A trailing dot or space is refused by its form already.
    await refusedWith(guard(`${MEM}\\.git.\\HEAD`), 'refused')
    // POSIX: .git in any case too (a case-insensitive macOS disk).
    const px = createFakeAccountFs('linux')
    plantPb6(px, '/h/codex-home/memories', '/')
    await refusedWith(guard('/h/codex-home/memories/.git/HEAD', ['/h/codex-home/memories'], px, 'darwin'), 'refused')
    await refusedWith(guard('/h/codex-home/memories/.Git/HEAD', ['/h/codex-home/memories'], px, 'linux'), 'refused')
  })

  it('refuses a UNC, device or relative path before any file call', async () => {
    for (const p of [`\\\\host\\share\\memories\\MEMORY.md`, `\\\\?\\${MEM}\\MEMORY.md`, `\\\\.\\${MEM}\\MEMORY.md`, 'memories\\MEMORY.md', `${MEM}\\..\\config.toml`,
      // Inside the folder by spelling, yet not a plain name Node and Win32 agree on:
      `${MEM}\\MEMORY.md:hidden`, `${MEM}\\MEMORY.md.`, `${MEM}\\extensions \\x.md`, `${MEM}\\CON`, `${MEM}\\nul.md`]) {
      const before = fake.fileCalls()
      await refusedWith(guard(p, [MEM]), 'refused')
      expect(fake.fileCalls() - before, p).toBe(0)
    }
  })

  it('refuses a path outside every memories folder, the folder itself, and a path from another account', async () => {
    fake.writeFile(`${HOME}\\auth.json`, '{}')
    await refusedWith(guard(`${HOME}\\auth.json`), 'refused')
    await refusedWith(guard(MEM), 'refused')
    await refusedWith(guard(`${MEM}x\\MEMORY.md`), 'refused')
    await refusedWith(guard(`${MEM}\\MEMORY.md`, []), 'refused')
    await refusedWith(guard(`${MEM}\\MEMORY.md`, ['C:\\other\\memories']), 'refused')
  })

  it('refuses a file that is a link, a link on the way, or a memories folder reached through a link', async () => {
    fake.writeFile('C:\\secret\\s.md', 'secret')
    fake.symlink('C:\\secret\\s.md', `${MEM}\\leak.md`)
    await refusedWith(guard(`${MEM}\\leak.md`), 'refused')
    fake.symlink('C:\\secret', `${MEM}\\out`)
    await refusedWith(guard(`${MEM}\\out\\s.md`), 'refused')
    // A link back inside resolves inside, and is still refused (no link at all).
    fake.symlink(`${MEM}\\extensions`, `${MEM}\\inner`)
    await refusedWith(guard(`${MEM}\\inner\\ad_hoc\\instructions.md`), 'refused')
    // The memories folder itself a junction elsewhere.
    const j = createFakeAccountFs('win32')
    plantPb6(j, 'C:\\elsewhere\\mem', '\\')
    j.mkdir(HOME)
    j.symlink('C:\\elsewhere\\mem', MEM)
    await refusedWith(guard(`${MEM}\\MEMORY.md`, [MEM], j), 'refused')
  })

  it('refuses a folder, and a file with a second name (a hard link)', async () => {
    await refusedWith(guard(`${MEM}\\extensions`), 'refused')
    fake.writeFile(`${MEM}\\twice.md`, 'x', { nlink: 2 })
    await refusedWith(guard(`${MEM}\\twice.md`), 'refused')
  })

  it('a missing file is not found', async () => {
    await refusedWith(guard(`${MEM}\\gone.md`), 'not-found')
  })

  it('B-3: a folder main names in another non-ASCII case than the disk is the same folder', async () => {
    const disk = 'C:\\Users\\\u00d6zil\\codex-home\\memories'
    const named = 'c:\\users\\\u00f6zil\\codex-home\\memories'
    const z = createFakeAccountFs('win32')
    plantPb6(z, disk, '\\')
    const t = await guard(`${named}\\extensions\\ad_hoc\\instructions.md`, [named], z)
    expect(t.root).toBe(named)
    const zset = { ...set, memoriesDir: named }
    expect(await readAccountMemory(`${named}\\MEMORY.md`, [zset], { fs: z as never, platform: 'win32' })).toContain('# Memory')
  })

  it('B-3: the Kelvin sign is another name to Windows: outside the folder, refused before any file call', async () => {
    const k = createFakeAccountFs('win32')
    plantPb6(k, 'C:\\Users\\Nik\\codex-home\\memories', '\\')
    const before = k.fileCalls()
    await refusedWith(guard('C:\\Users\\Ni\u212a\\codex-home\\memories\\MEMORY.md', ['C:\\Users\\Nik\\codex-home\\memories'], k), 'refused')
    expect(k.fileCalls() - before).toBe(0)
  })

  it('B-6: a file whose name starts with two dots, at the memories root, is inside it', async () => {
    fake.writeFile(`${MEM}\\..notes.md`, '# Notes\n\nkept')
    expect((await guard(`${MEM}\\..notes.md`)).path).toBe(`${MEM}\\..notes.md`)
    expect(await readAccountMemory(`${MEM}\\..notes.md`, [set], { fs: fake as never, platform: 'win32' })).toContain('kept')
  })
})

describe('the read and delete behind memory:read and memory:delete', () => {
  const deps = () => ({ fs: fake as never, platform: 'win32' as const })

  it('reads a listed file; refuses .git and anything the guard refuses', async () => {
    expect(await readAccountMemory(`${MEM}\\MEMORY.md`, [set], deps())).toContain('# Memory')
    await expect(readAccountMemory(`${MEM}\\.git\\HEAD`, [set], deps())).rejects.toThrow(/Refused/)
    await expect(readAccountMemory(`${HOME}\\config.toml`, [set], deps())).rejects.toThrow(/Refused/)
    await expect(readAccountMemory(`${MEM}\\MEMORY.md`, null, deps())).rejects.toThrow(/Refused/)
  })

  it('refuses a file swapped between the check and the open', async () => {
    const realOpen = fake.open.bind(fake)
    fake.open = (async (p: string, flags: number) => {
      // Someone replaces the file right after the check (a new file id).
      fake.remove(p)
      fake.writeFile(p, 'swapped')
      return realOpen(p, flags)
    }) as typeof fake.open
    await expect(readAccountMemory(`${MEM}\\MEMORY.md`, [set], deps())).rejects.toThrow(/changed/)
  })

  it('opens without following a link where the platform can (O_NOFOLLOW)', async () => {
    fake.writeFile('C:\\secret\\s.md', 'secret')
    fake.symlink('C:\\secret\\s.md', `${MEM}\\leak.md`)
    const target = await fake.lstat('C:\\secret\\s.md', { bigint: true })
    await expect(readCheckedFile(`${MEM}\\leak.md`, 100, fake as never, { expect: { dev: target.dev, ino: target.ino } })).rejects.toThrow(/ELOOP/)
  })

  it('refuses a file larger than the reading drawer takes', async () => {
    fake.writeFile(`${MEM}\\huge.md`, Buffer.alloc(1024 * 1024 + 1, 0x61))
    await expect(readAccountMemory(`${MEM}\\huge.md`, [set], deps())).rejects.toThrow(/too large/)
  })

  it('deletes a listed file, and never anything inside .git', async () => {
    await deleteAccountMemory(`${MEM}\\raw_memories.md`, [set], deps())
    expect(fake.exists(`${MEM}\\raw_memories.md`)).toBe(false)
    for (const rel of ['.git\\HEAD', '.git\\info\\notes.md', '.git\\refs\\heads\\master']) {
      await expect(deleteAccountMemory(`${MEM}\\${rel}`, [set], deps())).rejects.toThrow(/Refused/)
      expect(fake.exists(`${MEM}\\${rel}`), rel).toBe(true)
    }
    expect(fake.calls.unlink).toEqual([`${MEM}\\raw_memories.md`])
  })

  it('a delete refuses a file that changed after its check, and a link', async () => {
    const realLstat = fake.lstat.bind(fake)
    let n = 0
    fake.lstat = (async (p: string, o: { bigint: true }) => {
      // The second look (right before the unlink) sees another file.
      if (p.endsWith('MEMORY.md') && ++n === 2) { fake.remove(p); fake.writeFile(p, 'other') }
      return realLstat(p, o)
    }) as typeof fake.lstat
    await expect(deleteAccountMemory(`${MEM}\\MEMORY.md`, [set], deps())).rejects.toThrow(/changed/)
    expect(fake.calls.unlink).toEqual([])
    fake.writeFile('C:\\secret\\s.md', 'secret')
    fake.symlink('C:\\secret\\s.md', `${MEM}\\leak.md`)
    await expect(deleteAccountMemory(`${MEM}\\leak.md`, [set], deps())).rejects.toThrow(/Refused/)
    expect(fake.exists('C:\\secret\\s.md')).toBe(true)
  })

  it('isUnderAccountMemories picks the branch by spelling only', () => {
    expect(isUnderAccountMemories(`${MEM}\\MEMORY.md`, [set], 'win32')).toBe(true)
    expect(isUnderAccountMemories(`${MEM}\\.git\\HEAD`, [set], 'win32')).toBe(true) // the guard refuses it
    expect(isUnderAccountMemories(MEM, [set], 'win32')).toBe(false)
    expect(isUnderAccountMemories(`${HOME}\\auth.json`, [set], 'win32')).toBe(false)
    expect(isUnderAccountMemories('\\\\host\\share\\memories\\x.md', [set], 'win32')).toBe(false)
    expect(isUnderAccountMemories(`${MEM}\\MEMORY.md`, null, 'win32')).toBe(false)
    // The same rule as the guard: two leading dots inside, a non-ASCII case
    // pair the same folder, the Kelvin sign another.
    expect(isUnderAccountMemories(`${MEM}\\..notes.md`, [set], 'win32')).toBe(true)
    const k = { ...set, memoriesDir: 'C:\\Users\\Nik\\\u00d6\\memories' }
    expect(isUnderAccountMemories('c:\\users\\nik\\\u00f6\\memories\\MEMORY.md', [k], 'win32')).toBe(true)
    expect(isUnderAccountMemories('C:\\Users\\Ni\u212a\\\u00d6\\memories\\MEMORY.md', [k], 'win32')).toBe(false)
  })
})
