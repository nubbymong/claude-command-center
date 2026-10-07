import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Mock fs, os — memory-scanner uses them directly
vi.mock('fs')
vi.mock('os')

import { scanLocalMemory, readMemoryContent, deleteMemoryFile, writeMemoryFrontmatter } from '../../src/main/memory-scanner'
import { scanAccountMemories, ACCOUNT_MEMORY_LIMITS } from '../../src/main/account-memories'
import type { AccountFolderSet } from '../../src/main/account-folders'
import { createFakeAccountFs } from '../helpers/fake-account-fs'
import type { FakeAccountFs } from '../helpers/fake-account-fs'
import { PB6_MEMORIES, PB6_LISTED_MD } from '../fixtures/codex/memories-pb6'

/**
 * NOTE: cleanProjectName, inferTypeFromFilename, and parseFrontmatter are
 * private (not exported) in memory-scanner.ts. They should ideally be exported
 * for direct unit testing. For now we test them indirectly through scanLocalMemory.
 *
 * scanLocalMemory uses async fs.promises (stat/readdir/readFile) so the scan
 * never blocks the main thread. These helpers translate the old sync-style
 * mock maps (path -> Stats / entries / content) into fs.promises mocks, where
 * a missing/inaccessible path rejects (mirroring real stat behaviour, which
 * the scanner catches via statSafe).
 */

interface FsMocks {
  /** Paths that should "exist" — stat resolves; everything else rejects (ENOENT). */
  stat: (p: string) => fs.Stats | null
  readdir: (p: string) => any[]
  readFile: (p: string) => string
}

function applyAsyncFsMocks(m: FsMocks): void {
  ;(fs.promises as any) = {
    ...fs.promises,
    stat: vi.fn(async (p: string) => {
      const s = m.stat(p)
      if (!s) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return s
    }),
    readdir: vi.fn(async (p: string, _opts?: any) => m.readdir(p)),
    // Resolve with jittered, deliberately out-of-order timing so the
    // concurrency-order test genuinely exercises completion-order != input-order
    // (a `results.push()` bug would surface; `results[i] = ` survives).
    readFile: vi.fn((p: string) => new Promise<string>((resolve) => {
      setTimeout(() => resolve(m.readFile(p)), (p.length * 7) % 13)
    })),
  }
}

describe('memory-scanner', () => {
  const mockHome = '/mock/home'
  const projectsRoot = path.join(mockHome, '.claude', 'projects')

  beforeEach(() => {
    vi.clearAllMocks()
    ;(os.homedir as any).mockReturnValue(mockHome)
  })

  describe('scanLocalMemory', () => {
    // Stat helper for the common "one project, one memory dir, files of size N"
    // shape: projectsRoot + memoryDir exist; every other path is a file.
    const dirStat = { isDirectory: () => true } as fs.Stats
    const fileStat = (size: number) => ({ isDirectory: () => false, size, mtimeMs: Date.now() } as fs.Stats)

    it('returns empty result when projects directory does not exist', async () => {
      applyAsyncFsMocks({ stat: () => null, readdir: () => [], readFile: () => '' })

      const result = await scanLocalMemory()

      expect(result.projects).toEqual([])
      expect(result.memories).toEqual([])
      expect(result.warnings).toEqual([])
      expect(result.totalSize).toBe(0)
      expect(result.scannedAt).toBeGreaterThan(0)
    })

    it('returns empty result when no project directories have memory dirs', async () => {
      applyAsyncFsMocks({
        stat: (p) => (p === projectsRoot ? dirStat : null), // memory subdirs reject
        readdir: (p) => (p === projectsRoot ? [{ name: 'F--MY-PROJECT', isDirectory: () => true }] : []),
        readFile: () => '',
      })

      const result = await scanLocalMemory()

      expect(result.projects).toEqual([])
      expect(result.memories).toEqual([])
    })

    it('scans project memory directory and returns memories', async () => {
      const memoryDir = path.join(projectsRoot, 'F--MY-PROJECT', 'memory')
      const filePath = path.join(memoryDir, 'MEMORY.md')

      applyAsyncFsMocks({
        stat: (p) => {
          if (p === projectsRoot || p === memoryDir) return dirStat
          if (p === filePath) return { isDirectory: () => false, size: 512, mtimeMs: 1700000000000 } as fs.Stats
          return null
        },
        readdir: (p) => {
          if (p === projectsRoot) return [{ name: 'F--MY-PROJECT', isDirectory: () => true }]
          if (p === memoryDir) return ['MEMORY.md']
          return []
        },
        readFile: (p) => (p === filePath ? '# Test Memory\nSome content here.' : ''),
      })

      const result = await scanLocalMemory()

      expect(result.projects).toHaveLength(1)
      expect(result.projects[0].name).toBe('my-project')
      expect(result.projects[0].fileCount).toBe(1)
      expect(result.memories).toHaveLength(1)
      expect(result.memories[0].filename).toBe('MEMORY.md')
      expect(result.memories[0].type).toBe('reference')
      expect(result.memories[0].project).toBe('my-project')
    })

    // Single-project scaffold: projectsRoot + memoryDir are dirs; files get fileStat.
    function oneProject(dirName: string, files: string[], content: (f: string) => string, size = 100): void {
      const memoryDir = path.join(projectsRoot, dirName, 'memory')
      applyAsyncFsMocks({
        stat: (p) => (p === projectsRoot || p === memoryDir ? dirStat : fileStat(size)),
        readdir: (p) => {
          if (p === projectsRoot) return [{ name: dirName, isDirectory: () => true }]
          if (p === memoryDir) return files
          return []
        },
        readFile: content,
      })
    }

    it('cleans project name: F--MY-PROJECT becomes my-project', async () => {
      oneProject('F--MY-PROJECT', ['test.md'], () => 'Content')
      const result = await scanLocalMemory()
      expect(result.projects[0].name).toBe('my-project')
    })

    it('cleans project name: C--Users-testuser becomes users-testuser', async () => {
      oneProject('C--Users-testuser', ['test.md'], () => 'Content', 50)
      const result = await scanLocalMemory()
      expect(result.projects[0].name).toBe('users-testuser')
    })

    it('cleans project name: C--Users--me becomes home (short last segment)', async () => {
      oneProject('C--Users--me', ['test.md'], () => 'Content', 50)
      const result = await scanLocalMemory()
      expect(result.projects[0].name).toBe('home')
    })

    it('infers type feedback from filename starting with feedback_', async () => {
      oneProject('F--TEST', ['feedback_logging.md'], () => 'Feedback content', 200)
      const result = await scanLocalMemory()
      expect(result.memories[0].type).toBe('feedback')
    })

    it('infers type snapshot from filename starting with session-state-', async () => {
      oneProject('F--TEST', ['session-state-2024.md'], () => 'Session state', 300)
      const result = await scanLocalMemory()
      expect(result.memories[0].type).toBe('snapshot')
    })

    it('infers type reference from MEMORY.md', async () => {
      oneProject('F--TEST', ['MEMORY.md'], () => '# Memory\nContent', 400)
      const result = await scanLocalMemory()
      expect(result.memories[0].type).toBe('reference')
    })

    it('parses frontmatter type when present', async () => {
      oneProject('F--TEST', ['custom.md'], () => '---\nname: My Memory\ntype: user\ndescription: User memory\n---\n\nBody content', 500)
      const result = await scanLocalMemory()
      expect(result.memories[0].type).toBe('user')
      expect(result.memories[0].name).toBe('My Memory')
      expect(result.memories[0].description).toBe('User memory')
      expect(result.memories[0].hasFrontmatter).toBe(true)
    })

    it('warns about large MEMORY.md (>200 lines)', async () => {
      const bigContent = Array(250).fill('Line of content').join('\n')
      oneProject('F--TEST', ['MEMORY.md'], () => bigContent, 5000)
      const result = await scanLocalMemory()
      const warning = result.warnings.find(w => w.message.includes('250 lines'))
      expect(warning).toBeDefined()
      expect(warning!.level).toBe('warn')
    })

    it('custom frontmatter fields and types produce ZERO warnings (warning class deleted)', async () => {
      // Use MEMORY.md so the missing-MEMORY.md info doesn't appear — only testing
      // that custom type/fields no longer produce any warnings.
      oneProject('F--TEST', ['MEMORY.md'], () =>
        '---\nname: t\nnode_type: lineage\ntype: banana\nauthor: someone\n---\n\nContent')
      const result = await scanLocalMemory()
      expect(result.warnings).toEqual([])
      // unknown type still silently infers from filename
      expect(result.memories[0].type).toBe('reference')
    })

    it('real signals still warn: MEMORY.md over 200 lines and missing MEMORY.md', async () => {
      const big = Array(250).fill('line').join('\n')
      oneProject('F--TEST', ['MEMORY.md'], () => big, 5000)
      const r1 = await scanLocalMemory()
      expect(r1.warnings.some(w => w.message.includes('250 lines'))).toBe(true)

      oneProject('F--TEST', ['feedback_x.md'], () => 'Body')
      const r2 = await scanLocalMemory()
      expect(r2.warnings.some(w => w.message.includes('No MEMORY.md'))).toBe(true)
    })

    it('does NOT warn on the standard nested metadata: frontmatter block', async () => {
      // Real auto-memory frontmatter: name + description + a nested metadata.type.
      // The flat parser flattens `metadata:` to an empty top-level key + `type`,
      // both of which must be recognised (no spurious "Unknown field" warning).
      oneProject('F--TEST', ['feedback_x.md'], () =>
        '---\nname: x\ndescription: d\nmetadata:\n  type: feedback\n---\n\nBody', 120)
      const result = await scanLocalMemory()
      expect(result.warnings.find(w => w.message.includes('Unknown frontmatter field'))).toBeUndefined()
      expect(result.memories[0].type).toBe('feedback')
    })

    it('reads multiple files within a project concurrently, preserving order', async () => {
      // Bounded-concurrency read must keep memories[] in readdir order so the UI
      // and warning ordering match the old sequential scan.
      const files = Array.from({ length: 40 }, (_, i) => `feedback_${String(i).padStart(2, '0')}.md`)
      oneProject('F--BIG', files, (p) => `Body of ${path.basename(p)}`, 120)
      const result = await scanLocalMemory()
      expect(result.memories).toHaveLength(40)
      expect(result.memories.map(m => m.filename)).toEqual(files)
      expect(result.projects[0].fileCount).toBe(40)
    })
  })

  describe('readMemoryContent', () => {
    it('reads file content', async () => {
      ;(fs.promises as any) = {
        ...fs.promises,
        readFile: vi.fn().mockResolvedValue('# Memory content'),
      }

      const content = await readMemoryContent('/test/path.md')
      expect(content).toBe('# Memory content')
    })
  })

  describe('deleteMemoryFile', () => {
    it('deletes the file', async () => {
      const unlinkMock = vi.fn().mockResolvedValue(undefined)
      ;(fs.promises as any) = {
        ...fs.promises,
        unlink: unlinkMock,
      }

      await deleteMemoryFile('/test/path.md')
      expect(unlinkMock).toHaveBeenCalledWith('/test/path.md')
    })
  })

  describe('writeMemoryFrontmatter', () => {
    it('adds frontmatter to a file without existing frontmatter', async () => {
      const readMock = vi.fn().mockResolvedValue('# Simple content\nBody text')
      const writeMock = vi.fn().mockResolvedValue(undefined)
      ;(fs.promises as any) = {
        ...fs.promises,
        readFile: readMock,
        writeFile: writeMock,
      }

      await writeMemoryFrontmatter('/test/path.md', { name: 'My Memory', type: 'user' })

      expect(writeMock).toHaveBeenCalledOnce()
      const written = writeMock.mock.calls[0][1]
      expect(written).toContain('---')
      expect(written).toContain('name: My Memory')
      expect(written).toContain('type: user')
    })

    it('merges with existing frontmatter', async () => {
      const readMock = vi.fn().mockResolvedValue('---\nname: Old Name\ntype: feedback\n---\n\nBody')
      const writeMock = vi.fn().mockResolvedValue(undefined)
      ;(fs.promises as any) = {
        ...fs.promises,
        readFile: readMock,
        writeFile: writeMock,
      }

      await writeMemoryFrontmatter('/test/path.md', { name: 'New Name' })

      const written = writeMock.mock.calls[0][1]
      expect(written).toContain('name: New Name')
      expect(written).toContain('type: feedback')
    })
  })
})

// [host] WP2 PR 4, P4.4 (row 55): a provider account's own memories (Codex's
// `memories/`, on the layout PB6's run made: a git repository), walked with
// the in-memory file system of tests/helpers/fake-account-fs.ts (the `fs`
// mock above is not used by it). The fixture's MEMORY.md and
// memory_summary.md are seeded, and labelled so in the fixture.
describe('scanAccountMemories (a provider account\'s own memories folder)', () => {
  const HOME = 'C:\\Users\\me\\res\\codex-realms\\r1'
  const MEM = `${HOME}\\memories`
  const set = (over: Partial<AccountFolderSet> = {}): AccountFolderSet => ({
    providerId: 'codex', accountId: 'acct-1', external: false, logDir: `${HOME}\\log`, memoriesDir: MEM, configFile: `${HOME}\\config.toml`, ...over,
  })
  let fake: FakeAccountFs
  const deps = () => ({ fs: fake as never, platform: 'win32' as const })
  const plant = (root: string): void => {
    fake.mkdir(root)
    for (const e of PB6_MEMORIES) {
      const at = `${root}\\${e.rel.split('/').join('\\')}`
      if (e.kind === 'dir') fake.mkdir(at)
      else fake.writeFile(at, e.content ?? '')
    }
  }
  const inGit = (p: string): boolean => p.split('\\').some((s) => s.toLowerCase() === '.git')

  beforeEach(() => {
    fake = createFakeAccountFs('win32')
    plant(MEM)
  })

  it('lists every .md file, nested ones included, and nothing inside .git', async () => {
    const [acct] = await scanAccountMemories([set()], deps())
    expect(acct.state).toBe('present')
    expect(acct.truncated).toBe(false)
    expect(acct.files.map((f) => f.relPath)).toEqual([...PB6_LISTED_MD])
    expect(acct.files.map((f) => f.relPath)).toContain('extensions/ad_hoc/instructions.md')
    expect(acct.files.some((f) => f.relPath.split('/').some((s) => s.toLowerCase() === '.git'))).toBe(false)
    // .git is never even listed, looked at or opened.
    expect(fake.calls.readdir.some(inGit)).toBe(false)
    expect(fake.calls.lstat.some(inGit)).toBe(false)
    expect(fake.calls.open.some(inGit)).toBe(false)
  })

  it('describes each file from its heading-first text, labelled by account', async () => {
    const [acct] = await scanAccountMemories([set({ external: true })], deps())
    expect(acct).toMatchObject({ providerId: 'codex', accountId: 'acct-1', external: true })
    const byRel = Object.fromEntries(acct.files.map((f) => [f.relPath, f]))
    expect(byRel['MEMORY.md']).toMatchObject({ name: 'MEMORY', filename: 'MEMORY.md', type: 'reference', hasFrontmatter: false, accountId: 'acct-1', providerId: 'codex' })
    expect(byRel['MEMORY.md'].description).toBe('Seeded stand-in: the user prefers small commits.')
    expect(byRel['MEMORY.md'].path).toBe(`${MEM}\\MEMORY.md`)
    expect(byRel['raw_memories.md'].description).toBe('') // a heading only (PB6)
    expect(byRel['extensions/ad_hoc/instructions.md']).toMatchObject({ name: 'instructions', filename: 'extensions/ad_hoc/instructions.md' })
    // Ids are stable across scans and differ between accounts.
    const again = await scanAccountMemories([set(), set({ accountId: 'acct-2' })], deps())
    expect(again[0].files.map((f) => f.id)).toEqual(acct.files.map((f) => f.id))
    expect(again[1].files[0].id).not.toBe(again[0].files[0].id)
  })

  it('no memories folder is the "memories are off" state; something odd there is unreadable', async () => {
    const none = createFakeAccountFs('win32')
    none.mkdir(HOME)
    fake = none
    expect((await scanAccountMemories([set()], deps()))[0]).toMatchObject({ state: 'none', files: [] })
    fake.writeFile(MEM, 'a file where the folder would be')
    expect((await scanAccountMemories([set()], deps()))[0]).toMatchObject({ state: 'unreadable', files: [] })
    // The memories folder a junction elsewhere: nothing read through it.
    const j = createFakeAccountFs('win32')
    fake = j
    plant('C:\\elsewhere\\mem')
    j.mkdir(HOME)
    j.symlink('C:\\elsewhere\\mem', MEM)
    expect((await scanAccountMemories([set()], deps()))[0]).toMatchObject({ state: 'unreadable', files: [] })
    expect(j.calls.readdir).toEqual([])
    // A folder ABOVE the memories folder a junction (the account folder
    // swapped after the accounts service checked it): unreadable too.
    const above = createFakeAccountFs('win32')
    fake = above
    plant('C:\\real\\memories')
    above.symlink('C:\\real', 'C:\\via')
    expect((await scanAccountMemories([set({ memoriesDir: 'C:\\via\\memories' })], deps()))[0]).toMatchObject({ state: 'unreadable', files: [] })
    expect(above.calls.readdir).toEqual([])
    // A path that is not a local one is never touched.
    fake = createFakeAccountFs('win32')
    expect((await scanAccountMemories([set({ memoriesDir: '\\\\host\\share\\memories' })], deps()))[0].state).toBe('unreadable')
    expect(fake.fileCalls()).toBe(0)
  })

  it('never follows a link or junction inside, and skips a file with a second name', async () => {
    fake.writeFile('C:\\secret\\outside.md', '# Secret\n\nnot a memory')
    fake.symlink('C:\\secret', `${MEM}\\linked-dir`)
    fake.symlink('C:\\secret\\outside.md', `${MEM}\\linked.md`)
    fake.writeFile(`${MEM}\\hardlinked.md`, '# x\n\ny', { nlink: 2 })
    fake.writeFile(`${MEM}\\notes.txt`, 'not markdown')
    const [acct] = await scanAccountMemories([set()], deps())
    expect(acct.files.map((f) => f.relPath)).toEqual([...PB6_LISTED_MD])
    expect(fake.calls.readdir.some((p) => p.toLowerCase().includes('secret') || p.includes('linked-dir'))).toBe(false)
  })

  it('a file swapped between the walk and the description read is left out', async () => {
    const realOpen = fake.open.bind(fake)
    fake.open = (async (p: string, flags: number) => {
      if (p.endsWith('MEMORY.md')) { fake.remove(p); fake.writeFile(p, '# other') }
      return realOpen(p, flags)
    }) as typeof fake.open
    const [acct] = await scanAccountMemories([set()], deps())
    expect(acct.files.map((f) => f.relPath)).not.toContain('MEMORY.md')
  })

  it('a folder swapped for a link after the walk saw it is not listed through', async () => {
    fake.writeFile('C:\\secret\\outside.md', '# Secret\n\nnot a memory')
    const realReaddir = fake.readdir.bind(fake)
    let swapped = false
    fake.readdir = (async (p: string) => {
      if (!swapped && p.toLowerCase().endsWith('\\extensions')) {
        // Someone replaces the folder with a junction to elsewhere, now.
        swapped = true
        fake.remove(p)
        fake.symlink('C:\\secret', p)
      }
      return realReaddir(p)
    }) as typeof fake.readdir
    const [acct] = await scanAccountMemories([set()], deps())
    expect(swapped).toBe(true)
    expect(acct.files.map((f) => f.relPath).some((r) => r.includes('outside'))).toBe(false)
    expect(fake.calls.open.some((p) => p.includes('outside'))).toBe(false)
    // A folder that is a link before it is listed is never listed at all.
    const j = createFakeAccountFs('win32')
    fake = j
    plant(MEM)
    j.writeFile('C:\\secret\\outside.md', '# Secret')
    const realRealpath = j.realpath.bind(j)
    let swapped2 = false
    j.realpath = (async (p: string) => {
      if (!swapped2 && p.toLowerCase().endsWith('\\extensions')) { swapped2 = true; j.remove(p); j.symlink('C:\\secret', p) }
      return realRealpath(p)
    }) as typeof j.realpath
    const [acct2] = await scanAccountMemories([set()], deps())
    expect(swapped2).toBe(true)
    expect(j.calls.readdir.some((p) => p.toLowerCase().endsWith('\\extensions'))).toBe(false)
    expect(acct2.files.map((f) => f.relPath).some((r) => r.includes('outside'))).toBe(false)
  })

  it('is bounded: past the file limit the listing is cut and says so', async () => {
    for (let i = 0; i < ACCOUNT_MEMORY_LIMITS.maxFiles + 5; i++) fake.writeFile(`${MEM}\\rollout_summaries\\s${String(i).padStart(4, '0')}.md`, `# s${i}`)
    const [acct] = await scanAccountMemories([set()], deps())
    expect(acct.truncated).toBe(true)
    expect(acct.files.length).toBe(ACCOUNT_MEMORY_LIMITS.maxFiles)
  })

  it('B-3: a memories folder main names in another non-ASCII case than the disk is listed, not unreadable', async () => {
    fake = createFakeAccountFs('win32')
    plant('C:\\Users\\\u00d6zil\\codex-home\\memories')
    const [acct] = await scanAccountMemories([set({ memoriesDir: 'c:\\users\\\u00f6zil\\codex-home\\memories' })], deps())
    expect(acct.state).toBe('present')
    expect(acct.files.map((f) => f.relPath)).toEqual([...PB6_LISTED_MD])
  })

  it('one account failing never hides the others; no accounts lists none', async () => {
    expect(await scanAccountMemories(null, deps())).toEqual([])
    const out = await scanAccountMemories([set({ accountId: 'acct-bad', memoriesDir: 'C:\\nowhere\\memories' }), set()], deps())
    expect(out.map((a) => [a.accountId, a.state])).toEqual([['acct-bad', 'none'], ['acct-1', 'present']])
  })
})
