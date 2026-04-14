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
 */

describe('memory-scanner', () => {
  const mockHome = '/mock/home'
  const projectsRoot = path.join(mockHome, '.claude', 'projects')

  beforeEach(() => {
    vi.clearAllMocks()
    ;(os.homedir as any).mockReturnValue(mockHome)
  })

  describe('scanLocalMemory', () => {
    it('returns empty result when projects directory does not exist', async () => {
      ;(fs.existsSync as any).mockReturnValue(false)

      const result = await scanLocalMemory()

      expect(result.projects).toEqual([])
      expect(result.memories).toEqual([])
      expect(result.warnings).toEqual([])
      expect(result.totalSize).toBe(0)
      expect(result.scannedAt).toBeGreaterThan(0)
    })

    it('returns empty result when no project directories have memory dirs', async () => {
      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot) return true
        // memory subdirs don't exist
        return false
      })
      ;(fs.readdirSync as any).mockImplementation((p: string, opts?: any) => {
        if (p === projectsRoot) {
          return [{ name: 'F--MY-PROJECT', isDirectory: () => true }]
        }
        return []
      })

      const result = await scanLocalMemory()

      expect(result.projects).toEqual([])
      expect(result.memories).toEqual([])
    })

    it('scans project memory directory and returns memories', async () => {
      const memoryDir = path.join(projectsRoot, 'F--CLAUDE-MULTI-APP', 'memory')
      const filePath = path.join(memoryDir, 'MEMORY.md')

      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot) return true
        if (p === memoryDir) return true
        return false
      })
      ;(fs.statSync as any).mockImplementation((p: string) => {
        if (p === memoryDir) return { isDirectory: () => true }
        if (p === filePath) return { size: 512, mtimeMs: 1700000000000 }
        return { isDirectory: () => false, size: 0, mtimeMs: 0 }
      })
      ;(fs.readdirSync as any).mockImplementation((p: string, opts?: any) => {
        if (p === projectsRoot) {
          return [{ name: 'F--CLAUDE-MULTI-APP', isDirectory: () => true }]
        }
        if (p === memoryDir) {
          return ['MEMORY.md']
        }
        return []
      })
      ;(fs.readFileSync as any).mockImplementation((p: string) => {
        if (p === filePath) return '# Test Memory\nSome content here.'
        return ''
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

    it('cleans project name: F--CLAUDE-MULTI-APP becomes claude-multi-app', async () => {
      // Test through scan — project name derivation
      const memoryDir = path.join(projectsRoot, 'F--CLAUDE-MULTI-APP', 'memory')
      const filePath = path.join(memoryDir, 'test.md')

      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot || p === memoryDir) return true
        return false
      })
      ;(fs.statSync as any).mockImplementation((p: string) => {
        if (p === memoryDir) return { isDirectory: () => true }
        return { size: 100, mtimeMs: Date.now() }
      })
      ;(fs.readdirSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot) return [{ name: 'F--CLAUDE-MULTI-APP', isDirectory: () => true }]
        if (p === memoryDir) return ['test.md']
        return []
      })
      ;(fs.readFileSync as any).mockReturnValue('Content')

      const result = await scanLocalMemory()
      expect(result.projects[0].name).toBe('claude-multi-app')
    })

    it('cleans project name: C--Users-testuser becomes users-testuser', async () => {
      // C--Users-testuser → replace '--' with '/' → 'C/Users-testuser'
      // Strip drive letter → 'Users-testuser' (single segment, no further --)
      // Last segment → 'Users-testuser' → lowercased → 'users-testuser'
      const memoryDir = path.join(projectsRoot, 'C--Users-testuser', 'memory')

      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot || p === memoryDir) return true
        return false
      })
      ;(fs.statSync as any).mockImplementation((p: string) => {
        if (p === memoryDir) return { isDirectory: () => true }
        return { size: 50, mtimeMs: Date.now() }
      })
      ;(fs.readdirSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot) return [{ name: 'C--Users-testuser', isDirectory: () => true }]
        if (p === memoryDir) return ['test.md']
        return []
      })
      ;(fs.readFileSync as any).mockReturnValue('Content')

      const result = await scanLocalMemory()
      expect(result.projects[0].name).toBe('users-testuser')
    })

    it('cleans project name: C--Users--testuser becomes home (short last segment)', async () => {
      // C--Users--testuser → 'C/Users/testuser' → strip drive → 'Users/testuser'
      // Last segment → 'testuser' (5 chars > 2) → 'testuser'
      // BUT if dir was 'C--Users--me' → 'C/Users/me' → last='me' (len 2) → 'home'
      const memoryDir = path.join(projectsRoot, 'C--Users--me', 'memory')

      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot || p === memoryDir) return true
        return false
      })
      ;(fs.statSync as any).mockImplementation((p: string) => {
        if (p === memoryDir) return { isDirectory: () => true }
        return { size: 50, mtimeMs: Date.now() }
      })
      ;(fs.readdirSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot) return [{ name: 'C--Users--me', isDirectory: () => true }]
        if (p === memoryDir) return ['test.md']
        return []
      })
      ;(fs.readFileSync as any).mockReturnValue('Content')

      const result = await scanLocalMemory()
      expect(result.projects[0].name).toBe('home')
    })

    it('infers type feedback from filename starting with feedback_', async () => {
      const memoryDir = path.join(projectsRoot, 'F--TEST', 'memory')

      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot || p === memoryDir) return true
        return false
      })
      ;(fs.statSync as any).mockImplementation((p: string) => {
        if (p === memoryDir) return { isDirectory: () => true }
        return { size: 200, mtimeMs: Date.now() }
      })
      ;(fs.readdirSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot) return [{ name: 'F--TEST', isDirectory: () => true }]
        if (p === memoryDir) return ['feedback_logging.md']
        return []
      })
      ;(fs.readFileSync as any).mockReturnValue('Feedback content')

      const result = await scanLocalMemory()
      expect(result.memories[0].type).toBe('feedback')
    })

    it('infers type snapshot from filename starting with session-state-', async () => {
      const memoryDir = path.join(projectsRoot, 'F--TEST', 'memory')

      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot || p === memoryDir) return true
        return false
      })
      ;(fs.statSync as any).mockImplementation((p: string) => {
        if (p === memoryDir) return { isDirectory: () => true }
        return { size: 300, mtimeMs: Date.now() }
      })
      ;(fs.readdirSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot) return [{ name: 'F--TEST', isDirectory: () => true }]
        if (p === memoryDir) return ['session-state-2024.md']
        return []
      })
      ;(fs.readFileSync as any).mockReturnValue('Session state')

      const result = await scanLocalMemory()
      expect(result.memories[0].type).toBe('snapshot')
    })

    it('infers type reference from MEMORY.md', async () => {
      const memoryDir = path.join(projectsRoot, 'F--TEST', 'memory')

      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot || p === memoryDir) return true
        return false
      })
      ;(fs.statSync as any).mockImplementation((p: string) => {
        if (p === memoryDir) return { isDirectory: () => true }
        return { size: 400, mtimeMs: Date.now() }
      })
      ;(fs.readdirSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot) return [{ name: 'F--TEST', isDirectory: () => true }]
        if (p === memoryDir) return ['MEMORY.md']
        return []
      })
      ;(fs.readFileSync as any).mockReturnValue('# Memory\nContent')

      const result = await scanLocalMemory()
      expect(result.memories[0].type).toBe('reference')
    })

    it('parses frontmatter type when present', async () => {
      const memoryDir = path.join(projectsRoot, 'F--TEST', 'memory')

      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot || p === memoryDir) return true
        return false
      })
      ;(fs.statSync as any).mockImplementation((p: string) => {
        if (p === memoryDir) return { isDirectory: () => true }
        return { size: 500, mtimeMs: Date.now() }
      })
      ;(fs.readdirSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot) return [{ name: 'F--TEST', isDirectory: () => true }]
        if (p === memoryDir) return ['custom.md']
        return []
      })
      ;(fs.readFileSync as any).mockReturnValue('---\nname: My Memory\ntype: user\ndescription: User memory\n---\n\nBody content')

      const result = await scanLocalMemory()
      expect(result.memories[0].type).toBe('user')
      expect(result.memories[0].name).toBe('My Memory')
      expect(result.memories[0].description).toBe('User memory')
      expect(result.memories[0].hasFrontmatter).toBe(true)
    })

    it('warns about large MEMORY.md (>200 lines)', async () => {
      const memoryDir = path.join(projectsRoot, 'F--TEST', 'memory')
      const bigContent = Array(250).fill('Line of content').join('\n')

      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot || p === memoryDir) return true
        return false
      })
      ;(fs.statSync as any).mockImplementation((p: string) => {
        if (p === memoryDir) return { isDirectory: () => true }
        return { size: 5000, mtimeMs: Date.now() }
      })
      ;(fs.readdirSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot) return [{ name: 'F--TEST', isDirectory: () => true }]
        if (p === memoryDir) return ['MEMORY.md']
        return []
      })
      ;(fs.readFileSync as any).mockReturnValue(bigContent)

      const result = await scanLocalMemory()
      const warning = result.warnings.find(w => w.message.includes('250 lines'))
      expect(warning).toBeDefined()
      expect(warning!.level).toBe('warn')
    })

    it('warns about unknown frontmatter type', async () => {
      const memoryDir = path.join(projectsRoot, 'F--TEST', 'memory')

      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot || p === memoryDir) return true
        return false
      })
      ;(fs.statSync as any).mockImplementation((p: string) => {
        if (p === memoryDir) return { isDirectory: () => true }
        return { size: 100, mtimeMs: Date.now() }
      })
      ;(fs.readdirSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot) return [{ name: 'F--TEST', isDirectory: () => true }]
        if (p === memoryDir) return ['test.md']
        return []
      })
      ;(fs.readFileSync as any).mockReturnValue('---\ntype: banana\n---\n\nContent')

      const result = await scanLocalMemory()
      const warning = result.warnings.find(w => w.message.includes('Unknown frontmatter type'))
      expect(warning).toBeDefined()
      expect(warning!.message).toContain('banana')
    })

    it('warns about unknown frontmatter fields', async () => {
      const memoryDir = path.join(projectsRoot, 'F--TEST', 'memory')

      ;(fs.existsSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot || p === memoryDir) return true
        return false
      })
      ;(fs.statSync as any).mockImplementation((p: string) => {
        if (p === memoryDir) return { isDirectory: () => true }
        return { size: 100, mtimeMs: Date.now() }
      })
      ;(fs.readdirSync as any).mockImplementation((p: string) => {
        if (p === projectsRoot) return [{ name: 'F--TEST', isDirectory: () => true }]
        if (p === memoryDir) return ['test.md']
        return []
      })
      ;(fs.readFileSync as any).mockReturnValue('---\nname: Test\nauthor: Someone\n---\n\nContent')

      const result = await scanLocalMemory()
      const warning = result.warnings.find(w => w.message.includes('Unknown frontmatter field'))
      expect(warning).toBeDefined()
      expect(warning!.message).toContain('author')
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
