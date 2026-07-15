// @vitest-environment jsdom
/**
 * P5.9 regression: Memory page shows an informational banner clarifying
 * that the page surfaces Claude Code memories only. Codex stores its
 * project context separately (AGENTS.md + ~/.codex/rules/) and is not
 * tracked here.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// MemoryPage calls useMemoryStore() without a selector and destructures
// the full state object. The mock returns the state directly when no
// selector is passed, otherwise applies the selector (defensive -- not
// strictly needed for this single page, but keeps the mock robust if a
// future refactor switches to selectors).
const mockMemoryState = {
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
  collapsedGroups: new Set<string>(),
  selectedContent: null,
  // Drilldown filter/sort state (added in dashboard recomposition)
  scopeFilter: 'all' as const,
  typeFilter: null,
  sortBy: 'modified' as const,
  sortDir: 'desc' as const,
  recentSessions: {} as Record<string, Array<{ sessionId: string; lastActive: number }>>,
  scan: vi.fn().mockResolvedValue(undefined),
  selectProject: vi.fn(),
  selectMemory: vi.fn().mockResolvedValue(undefined),
  setSearch: vi.fn(),
  toggleGroup: vi.fn(),
  deleteMemory: vi.fn().mockResolvedValue(undefined),
  writeFrontmatter: vi.fn().mockResolvedValue(undefined),
  dismissWarnings: vi.fn(),
  setScopeFilter: vi.fn(),
  setTypeFilter: vi.fn(),
  setSort: vi.fn(),
}

vi.mock('../../../src/renderer/stores/memoryStore', () => ({
  useMemoryStore: (sel?: any) => (sel ? sel(mockMemoryState) : mockMemoryState),
}))

vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({
  useAccountProfilesStore: (sel?: any) => sel ? sel({ profiles: [] }) : { profiles: [] },
}))

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel?: any) => sel ? sel({ sessions: [] }) : { sessions: [] },
}))

// Import after mock is registered
const { default: MemoryPage } = await import('../../../src/renderer/components/MemoryPage')

describe('MemoryPage -- Codex coverage banner (P5.9)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('renders the Codex coverage banner at the top of the page', () => {
    act(() => { root.render(React.createElement(MemoryPage)) })

    const text = container.textContent ?? ''
    // Banner mentions what IS covered
    expect(text).toContain('This page surfaces Claude Code memories')
    // Banner mentions where Codex stores its context (the two locations)
    expect(text).toContain('AGENTS.md')
    expect(text).toContain('~/.codex/rules/')
    // Banner uses the blue/30 border class (sanity check on styling)
    expect(container.innerHTML).toContain('border-blue/30')
  })
})
