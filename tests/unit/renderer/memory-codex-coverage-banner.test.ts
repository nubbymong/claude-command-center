// @vitest-environment jsdom
/**
 * P5.9 regression: Memory page shows an informational banner clarifying
 * that the page shows Claude Code memories only. WP2 P2 reworded it under
 * the P1 parity rule (docs/wp2/parity-checklist.md, row 54): Codex memories
 * are not shown here yet,
 * and Codex reads its project instructions from AGENTS.md files. The earlier
 * claim that Codex keeps user rules in ~/.codex/rules/ is gone and must not
 * come back.
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

    // The banner: the blue/30 note (sanity check on styling), in full.
    const banners = Array.from(container.querySelectorAll('div')).filter((d) => d.className.split(/\s+/).includes('border-blue/30'))
    expect(banners).toHaveLength(1)
    const banner = banners[0]
    // What IS covered, and where it is read from
    expect(banner.textContent).toBe(
      'This page shows Claude Code memories from ~/.claude/projects/*/memory/. Codex memories are not shown here yet. Codex reads its project instructions from AGENTS.md files.',
    )
    // The retired claim about Codex user rules is not made anywhere on the page
    expect(container.textContent).not.toContain('~/.codex/rules/')
    // At the top of the page: before the page body (here, its empty state)
    const body = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === 'No memory directories found')
    expect(body).toBeTruthy()
    expect(banner.compareDocumentPosition(body!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
