import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useMemoryStore } from '../../../src/renderer/stores/memoryStore'
import type { MemoryFile, MemoryProject, MemoryScanResult } from '../../../src/shared/types'

function makeMemory(overrides: Partial<MemoryFile> = {}): MemoryFile {
  return {
    id: 'mem-' + Math.random().toString(36).slice(2, 8),
    name: 'Test Memory',
    filename: 'test.md',
    project: 'test-project',
    projectDir: 'F--TEST-PROJECT',
    type: 'reference',
    description: 'A test memory file',
    size: 1024,
    modified: Date.now(),
    hasFrontmatter: false,
    path: '/mock/.claude/projects/F--TEST-PROJECT/memory/test.md',
    ...overrides,
  }
}

function makeProject(overrides: Partial<MemoryProject> = {}): MemoryProject {
  return {
    name: 'test-project',
    projectDir: 'F--TEST-PROJECT',
    fileCount: 3,
    totalSize: 4096,
    lastModified: Date.now(),
    types: { reference: 1, feedback: 2 },
    ...overrides,
  }
}

function getMockMemoryAPI() {
  return (window as any).electronAPI.memory
}

describe('memoryStore', () => {
  beforeEach(() => {
    useMemoryStore.setState({
      projects: [],
      memories: [],
      warnings: [],
      totalSize: 0,
      scannedAt: 0,
      loading: false,
      error: null,
      selectedProject: null,
      selectedMemoryId: null,
      searchQuery: '',
      collapsedGroups: new Set(),
      selectedContent: null,
    })
    // Reset mocks
    vi.clearAllMocks()
  })

  describe('initial state', () => {
    it('has empty projects and memories', () => {
      const state = useMemoryStore.getState()
      expect(state.projects).toEqual([])
      expect(state.memories).toEqual([])
    })

    it('has no loading or error', () => {
      const state = useMemoryStore.getState()
      expect(state.loading).toBe(false)
      expect(state.error).toBeNull()
    })

    it('has empty warnings', () => {
      expect(useMemoryStore.getState().warnings).toEqual([])
    })

    it('has no selection state', () => {
      const state = useMemoryStore.getState()
      expect(state.selectedProject).toBeNull()
      expect(state.selectedMemoryId).toBeNull()
      expect(state.selectedContent).toBeNull()
    })

    it('has empty search and collapsed groups', () => {
      const state = useMemoryStore.getState()
      expect(state.searchQuery).toBe('')
      expect(state.collapsedGroups.size).toBe(0)
    })
  })

  describe('scan', () => {
    it('calls electronAPI.memory.scan and updates state', async () => {
      const mockResult: MemoryScanResult = {
        projects: [makeProject()],
        memories: [makeMemory()],
        warnings: [{ level: 'info', message: 'Test warning' }],
        totalSize: 4096,
        scannedAt: 1234567890,
      }
      getMockMemoryAPI().scan.mockResolvedValueOnce(mockResult)

      await useMemoryStore.getState().scan()

      expect(getMockMemoryAPI().scan).toHaveBeenCalledOnce()
      const state = useMemoryStore.getState()
      expect(state.projects).toHaveLength(1)
      expect(state.memories).toHaveLength(1)
      expect(state.warnings).toHaveLength(1)
      expect(state.totalSize).toBe(4096)
      expect(state.scannedAt).toBe(1234567890)
      expect(state.loading).toBe(false)
      expect(state.error).toBeNull()
    })

    it('sets loading to true while scanning', async () => {
      let loadingDuringScan = false
      getMockMemoryAPI().scan.mockImplementationOnce(() => {
        loadingDuringScan = useMemoryStore.getState().loading
        return Promise.resolve({
          projects: [],
          memories: [],
          warnings: [],
          totalSize: 0,
          scannedAt: Date.now(),
        })
      })

      await useMemoryStore.getState().scan()
      expect(loadingDuringScan).toBe(true)
      expect(useMemoryStore.getState().loading).toBe(false)
    })

    it('sets error on scan failure', async () => {
      getMockMemoryAPI().scan.mockRejectedValueOnce(new Error('Scan failed'))

      await useMemoryStore.getState().scan()

      const state = useMemoryStore.getState()
      expect(state.loading).toBe(false)
      expect(state.error).toContain('Scan failed')
    })
  })

  describe('selectProject', () => {
    it('sets selectedProject and clears selectedMemory', () => {
      useMemoryStore.setState({ selectedMemoryId: 'mem-1', selectedContent: 'old content' })

      useMemoryStore.getState().selectProject('my-project')

      const state = useMemoryStore.getState()
      expect(state.selectedProject).toBe('my-project')
      expect(state.selectedMemoryId).toBeNull()
      expect(state.selectedContent).toBeNull()
    })

    it('allows setting to null for all projects', () => {
      useMemoryStore.setState({ selectedProject: 'my-project' })

      useMemoryStore.getState().selectProject(null)

      expect(useMemoryStore.getState().selectedProject).toBeNull()
    })
  })

  describe('selectMemory', () => {
    it('calls electronAPI.memory.read and sets content', async () => {
      const mem = makeMemory({ id: 'mem-abc', path: '/test/path.md' })
      useMemoryStore.setState({ memories: [mem] })
      getMockMemoryAPI().read.mockResolvedValueOnce('# Hello World')

      await useMemoryStore.getState().selectMemory('mem-abc')

      expect(getMockMemoryAPI().read).toHaveBeenCalledWith('/test/path.md')
      const state = useMemoryStore.getState()
      expect(state.selectedMemoryId).toBe('mem-abc')
      expect(state.selectedContent).toBe('# Hello World')
    })

    it('clears selection when called with null', async () => {
      useMemoryStore.setState({ selectedMemoryId: 'mem-1', selectedContent: 'content' })

      await useMemoryStore.getState().selectMemory(null)

      const state = useMemoryStore.getState()
      expect(state.selectedMemoryId).toBeNull()
      expect(state.selectedContent).toBeNull()
    })

    it('does nothing for unknown memory id', async () => {
      useMemoryStore.setState({ memories: [makeMemory({ id: 'mem-1' })] })

      await useMemoryStore.getState().selectMemory('nonexistent')

      expect(getMockMemoryAPI().read).not.toHaveBeenCalled()
    })

    it('sets fallback content on read failure', async () => {
      const mem = makeMemory({ id: 'mem-fail' })
      useMemoryStore.setState({ memories: [mem] })
      getMockMemoryAPI().read.mockRejectedValueOnce(new Error('Read error'))

      await useMemoryStore.getState().selectMemory('mem-fail')

      expect(useMemoryStore.getState().selectedContent).toBe('(Failed to read file)')
    })
  })

  describe('setSearch', () => {
    it('updates searchQuery', () => {
      useMemoryStore.getState().setSearch('feedback')

      expect(useMemoryStore.getState().searchQuery).toBe('feedback')
    })

    it('can clear search', () => {
      useMemoryStore.setState({ searchQuery: 'old' })

      useMemoryStore.getState().setSearch('')

      expect(useMemoryStore.getState().searchQuery).toBe('')
    })
  })

  describe('toggleGroup', () => {
    it('adds type to collapsedGroups', () => {
      useMemoryStore.getState().toggleGroup('feedback')

      expect(useMemoryStore.getState().collapsedGroups.has('feedback')).toBe(true)
    })

    it('removes type from collapsedGroups on second toggle', () => {
      useMemoryStore.getState().toggleGroup('feedback')
      useMemoryStore.getState().toggleGroup('feedback')

      expect(useMemoryStore.getState().collapsedGroups.has('feedback')).toBe(false)
    })

    it('handles multiple groups independently', () => {
      useMemoryStore.getState().toggleGroup('feedback')
      useMemoryStore.getState().toggleGroup('reference')

      const groups = useMemoryStore.getState().collapsedGroups
      expect(groups.has('feedback')).toBe(true)
      expect(groups.has('reference')).toBe(true)

      useMemoryStore.getState().toggleGroup('feedback')
      const updated = useMemoryStore.getState().collapsedGroups
      expect(updated.has('feedback')).toBe(false)
      expect(updated.has('reference')).toBe(true)
    })
  })

  describe('deleteMemory', () => {
    it('calls electronAPI.memory.delete and triggers rescan', async () => {
      const mem = makeMemory({ id: 'mem-del', path: '/test/del.md' })
      useMemoryStore.setState({
        memories: [mem],
        selectedMemoryId: 'mem-del',
        selectedContent: 'content',
      })

      await useMemoryStore.getState().deleteMemory('mem-del')

      expect(getMockMemoryAPI().delete).toHaveBeenCalledWith('/test/del.md')
      expect(getMockMemoryAPI().scan).toHaveBeenCalled()
      const state = useMemoryStore.getState()
      expect(state.selectedMemoryId).toBeNull()
      expect(state.selectedContent).toBeNull()
    })

    it('does nothing for unknown memory id', async () => {
      useMemoryStore.setState({ memories: [makeMemory({ id: 'mem-1' })] })

      await useMemoryStore.getState().deleteMemory('nonexistent')

      expect(getMockMemoryAPI().delete).not.toHaveBeenCalled()
    })
  })

  describe('dismissWarnings', () => {
    it('clears warnings', () => {
      useMemoryStore.setState({
        warnings: [
          { level: 'warn', message: 'Warning 1' },
          { level: 'info', message: 'Info 1' },
        ],
      })

      useMemoryStore.getState().dismissWarnings()

      expect(useMemoryStore.getState().warnings).toEqual([])
    })
  })
})
