import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Mock fs, os — memory-scanner uses them directly
vi.mock('fs')
vi.mock('os')

import { scanLocalMemory, readMemoryContent, deleteMemoryFile, writeMemoryFrontmatter } from '../../src/main/memory-scanner'

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
      const memoryDir = path.join(projectsRoot, 'F--CLAUDE-MULTI-APP', 'memory')
      const filePath = path.join(memoryDir, 'MEMORY.md')

      applyAsyncFsMocks({
        stat: (p) => {
          if (p === projectsRoot || p === memoryDir) return dirStat
          if (p === filePath) return { isDirectory: () => false, size: 512, mtimeMs: 1700000000000 } as fs.Stats
          return null
        },
        readdir: (p) => {
          if (p === projectsRoot) return [{ name: 'F--CLAUDE-MULTI-APP', isDirectory: () => true }]
          if (p === memoryDir) return ['MEMORY.md']
          return []
        },
        readFile: (p) => (p === filePath ? '# Test Memory\nSome content here.' : ''),
      })

      const result = await scanLocalMemory()

      expect(result.projects).toHaveLength(1)
      expect(result.projects[0].name).toBe('claude-multi-app')
      expect(result.projects[0].fileCount).toBe(1)
      expect(result.memories).toHaveLength(1)
      expect(result.memories[0].filename).toBe('MEMORY.md')
      expect(result.memories[0].type).toBe('reference')
      expect(result.memories[0].project).toBe('claude-multi-app')
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

    it('cleans project name: F--CLAUDE-MULTI-APP becomes claude-multi-app', async () => {
      oneProject('F--CLAUDE-MULTI-APP', ['test.md'], () => 'Content')
      const result = await scanLocalMemory()
      expect(result.projects[0].name).toBe('claude-multi-app')
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
