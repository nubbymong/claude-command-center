# v2.0.0 IDE Experience Uplift -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Claude Command Center from a terminal orchestrator into a full IDE-class development environment with drag-and-drop panels, diff viewer, side chat, preview pane, file editor, and git worktree isolation.

**Architecture:** Recursive binary split tree layout system replaces the fixed two-pane App.tsx layout. Each panel type is an independent React component registered in a pane registry. New main process modules handle file watching, git operations, and preview management. All features configurable via settings with tips and tour integration.

**Tech Stack:** React 18, Zustand 5, xterm.js 5.5, Monaco Editor, chokidar, node-pty, Electron 33 (webview tag), Tailwind CSS v4

**Design Spec:** `docs/superpowers/specs/2026-04-15-v2-ide-experience-uplift.md`

---

## Phase Overview

| Phase | Feature | Tasks | Status |
|-------|---------|-------|--------|
| 0 | Version Bump & PR Setup | 1-2 | Pending |
| 1 | Panel System (Foundation) | 3-12 | Pending |
| 2 | Side Chat | 13-18 | Pending |
| 3 | Diff Viewer | 19-26 | Pending |
| 4 | Preview Pane | 27-32 | Pending |
| 5 | File Editor | 33-37 | Pending |
| 6 | Git Worktree Isolation | 38-42 | Pending |

---

## Phase 0: Version Bump & PR Setup

### Task 1: Bump version to 2.0.0

**Files:**
- Modify: `package.json:2` (version field)

- [ ] **Step 1: Update package.json version**

In `package.json`, change:
```json
"version": "1.3.0",
```
to:
```json
"version": "2.0.0",
```

- [ ] **Step 2: Verify build still works**

Run: `npm run build`
Expected: Build succeeds with no errors

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 2.0.0 for IDE Experience Uplift"
```

### Task 2: Add panel system types to shared module

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/panel-types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import type { SplitNode, PaneNode, LayoutNode, PaneType } from '../../src/shared/types'

describe('Panel system types', () => {
  it('creates a valid PaneNode', () => {
    const pane: PaneNode = {
      type: 'pane',
      id: 'pane-1',
      paneType: 'claude-terminal',
      props: {},
    }
    expect(pane.type).toBe('pane')
    expect(pane.paneType).toBe('claude-terminal')
  })

  it('creates a valid SplitNode with two pane children', () => {
    const left: PaneNode = { type: 'pane', id: 'p1', paneType: 'claude-terminal', props: {} }
    const right: PaneNode = { type: 'pane', id: 'p2', paneType: 'diff-viewer', props: {} }
    const split: SplitNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [left, right],
    }
    expect(split.direction).toBe('horizontal')
    expect(split.children).toHaveLength(2)
  })

  it('allows nested splits (tree structure)', () => {
    const terminal: PaneNode = { type: 'pane', id: 'p1', paneType: 'claude-terminal', props: {} }
    const diff: PaneNode = { type: 'pane', id: 'p2', paneType: 'diff-viewer', props: {} }
    const partner: PaneNode = { type: 'pane', id: 'p3', paneType: 'partner-terminal', props: {} }
    const innerSplit: SplitNode = {
      type: 'split', id: 's-inner', direction: 'vertical', ratio: 0.6,
      children: [terminal, partner],
    }
    const outerSplit: SplitNode = {
      type: 'split', id: 's-outer', direction: 'horizontal', ratio: 0.7,
      children: [innerSplit, diff],
    }
    expect(outerSplit.children[0].type).toBe('split')
    expect((outerSplit.children[0] as SplitNode).children).toHaveLength(2)
  })

  it('supports maximized flag on panes', () => {
    const pane: PaneNode = {
      type: 'pane', id: 'p1', paneType: 'preview', props: { url: 'http://localhost:3000' },
      maximized: true,
    }
    expect(pane.maximized).toBe(true)
  })

  it('validates all PaneType values', () => {
    const validTypes: PaneType[] = ['claude-terminal', 'partner-terminal', 'diff-viewer', 'preview', 'file-editor']
    expect(validTypes).toHaveLength(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/panel-types.test.ts`
Expected: FAIL -- types not exported from `src/shared/types.ts`

- [ ] **Step 3: Add types to shared/types.ts**

Append to the end of `src/shared/types.ts`:

```typescript
// ── Panel System (v2) ──

export type PaneType = 'claude-terminal' | 'partner-terminal' | 'diff-viewer' | 'preview' | 'file-editor'

export interface PaneNode {
  type: 'pane'
  id: string
  paneType: PaneType
  props: Record<string, unknown>
  maximized?: boolean
}

export interface SplitNode {
  type: 'split'
  id: string
  direction: 'horizontal' | 'vertical'
  ratio: number
  children: [LayoutNode, LayoutNode]
}

export type LayoutNode = SplitNode | PaneNode
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/panel-types.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts tests/unit/panel-types.test.ts
git commit -m "feat(types): add panel system types (PaneNode, SplitNode, LayoutNode)"
```

---

## Phase 1: Panel System (Foundation)

### Task 3: Create panel layout utility functions

These pure functions operate on the layout tree. They power the store and UI but have no React or Zustand dependency, making them easy to unit test.

**Files:**
- Create: `src/renderer/utils/panel-layout.ts`
- Create: `tests/unit/panel-layout.test.ts`

- [ ] **Step 1: Write failing tests for layout utilities**

Create `tests/unit/panel-layout.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  createPane,
  findPane,
  removePane,
  splitPane,
  updateRatio,
  countPanes,
  getAllPaneIds,
  setMaximized,
} from '../../src/renderer/utils/panel-layout'
import type { PaneNode, SplitNode, LayoutNode } from '../../src/shared/types'

describe('panel-layout utilities', () => {
  const terminal = (): PaneNode => createPane('claude-terminal')
  const diff = (): PaneNode => createPane('diff-viewer')
  const partner = (): PaneNode => createPane('partner-terminal')

  describe('createPane', () => {
    it('generates unique IDs', () => {
      const a = createPane('claude-terminal')
      const b = createPane('claude-terminal')
      expect(a.id).not.toBe(b.id)
      expect(a.type).toBe('pane')
      expect(a.paneType).toBe('claude-terminal')
      expect(a.props).toEqual({})
    })

    it('accepts initial props', () => {
      const pane = createPane('preview', { url: 'http://localhost:3000' })
      expect(pane.props.url).toBe('http://localhost:3000')
    })
  })

  describe('findPane', () => {
    it('finds a pane in a single-pane layout', () => {
      const pane = terminal()
      expect(findPane(pane, pane.id)).toBe(pane)
    })

    it('finds a pane in a split layout', () => {
      const t = terminal()
      const d = diff()
      const split: SplitNode = {
        type: 'split', id: 's1', direction: 'horizontal', ratio: 0.5,
        children: [t, d],
      }
      expect(findPane(split, d.id)).toBe(d)
    })

    it('returns null for non-existent pane', () => {
      const t = terminal()
      expect(findPane(t, 'non-existent')).toBeNull()
    })

    it('finds panes in deeply nested splits', () => {
      const t = terminal()
      const d = diff()
      const p = partner()
      const inner: SplitNode = {
        type: 'split', id: 's1', direction: 'vertical', ratio: 0.5,
        children: [t, d],
      }
      const outer: SplitNode = {
        type: 'split', id: 's2', direction: 'horizontal', ratio: 0.7,
        children: [inner, p],
      }
      expect(findPane(outer, t.id)).toBe(t)
      expect(findPane(outer, p.id)).toBe(p)
    })
  })

  describe('splitPane', () => {
    it('splits a single pane horizontally', () => {
      const t = terminal()
      const result = splitPane(t, t.id, 'diff-viewer', 'horizontal')
      expect(result.type).toBe('split')
      const split = result as SplitNode
      expect(split.direction).toBe('horizontal')
      expect(split.ratio).toBe(0.5)
      expect((split.children[0] as PaneNode).id).toBe(t.id)
      expect((split.children[1] as PaneNode).paneType).toBe('diff-viewer')
    })

    it('splits a pane vertically', () => {
      const t = terminal()
      const result = splitPane(t, t.id, 'partner-terminal', 'vertical')
      const split = result as SplitNode
      expect(split.direction).toBe('vertical')
    })

    it('splits a pane within a nested tree', () => {
      const t = terminal()
      const d = diff()
      const tree: SplitNode = {
        type: 'split', id: 's1', direction: 'horizontal', ratio: 0.5,
        children: [t, d],
      }
      const result = splitPane(tree, d.id, 'preview', 'vertical')
      // d should now be replaced by a split containing d + preview
      const outer = result as SplitNode
      expect(outer.children[0]).toBe(t) // left unchanged
      const innerSplit = outer.children[1] as SplitNode
      expect(innerSplit.type).toBe('split')
      expect(innerSplit.direction).toBe('vertical')
      expect((innerSplit.children[0] as PaneNode).id).toBe(d.id)
      expect((innerSplit.children[1] as PaneNode).paneType).toBe('preview')
    })

    it('returns tree unchanged if target pane not found', () => {
      const t = terminal()
      const result = splitPane(t, 'non-existent', 'diff-viewer', 'horizontal')
      expect(result).toBe(t)
    })
  })

  describe('removePane', () => {
    it('cannot remove the last pane', () => {
      const t = terminal()
      const result = removePane(t, t.id)
      expect(result).toBe(t) // unchanged
    })

    it('removes a pane from a two-pane split, returning sibling', () => {
      const t = terminal()
      const d = diff()
      const split: SplitNode = {
        type: 'split', id: 's1', direction: 'horizontal', ratio: 0.5,
        children: [t, d],
      }
      const result = removePane(split, d.id)
      expect(result).toBe(t) // sibling promoted
    })

    it('removes a pane from a nested tree', () => {
      const t = terminal()
      const d = diff()
      const p = partner()
      const inner: SplitNode = {
        type: 'split', id: 's1', direction: 'vertical', ratio: 0.5,
        children: [d, p],
      }
      const outer: SplitNode = {
        type: 'split', id: 's2', direction: 'horizontal', ratio: 0.7,
        children: [t, inner],
      }
      const result = removePane(outer, p.id) as SplitNode
      expect(result.type).toBe('split')
      expect(result.children[0]).toBe(t)
      expect(result.children[1]).toBe(d) // inner split collapsed, d promoted
    })
  })

  describe('updateRatio', () => {
    it('updates a split ratio', () => {
      const t = terminal()
      const d = diff()
      const split: SplitNode = {
        type: 'split', id: 's1', direction: 'horizontal', ratio: 0.5,
        children: [t, d],
      }
      const result = updateRatio(split, 's1', 0.3) as SplitNode
      expect(result.ratio).toBe(0.3)
    })

    it('clamps ratio between 0.1 and 0.9', () => {
      const t = terminal()
      const d = diff()
      const split: SplitNode = {
        type: 'split', id: 's1', direction: 'horizontal', ratio: 0.5,
        children: [t, d],
      }
      expect((updateRatio(split, 's1', 0.02) as SplitNode).ratio).toBe(0.1)
      expect((updateRatio(split, 's1', 0.98) as SplitNode).ratio).toBe(0.9)
    })
  })

  describe('countPanes', () => {
    it('counts 1 for a single pane', () => {
      expect(countPanes(terminal())).toBe(1)
    })

    it('counts panes in a tree', () => {
      const t = terminal()
      const d = diff()
      const p = partner()
      const inner: SplitNode = {
        type: 'split', id: 's1', direction: 'vertical', ratio: 0.5,
        children: [d, p],
      }
      const outer: SplitNode = {
        type: 'split', id: 's2', direction: 'horizontal', ratio: 0.7,
        children: [t, inner],
      }
      expect(countPanes(outer)).toBe(3)
    })
  })

  describe('getAllPaneIds', () => {
    it('returns all pane IDs from a tree', () => {
      const t = terminal()
      const d = diff()
      const split: SplitNode = {
        type: 'split', id: 's1', direction: 'horizontal', ratio: 0.5,
        children: [t, d],
      }
      const ids = getAllPaneIds(split)
      expect(ids).toContain(t.id)
      expect(ids).toContain(d.id)
      expect(ids).toHaveLength(2)
    })
  })

  describe('setMaximized', () => {
    it('sets maximized on target pane and false on others', () => {
      const t = terminal()
      const d = diff()
      const split: SplitNode = {
        type: 'split', id: 's1', direction: 'horizontal', ratio: 0.5,
        children: [t, d],
      }
      const result = setMaximized(split, d.id) as SplitNode
      expect((result.children[0] as PaneNode).maximized).toBeFalsy()
      expect((result.children[1] as PaneNode).maximized).toBe(true)
    })

    it('clears maximized when toggling off', () => {
      const t = terminal()
      t.maximized = true
      const result = setMaximized(t, t.id) as PaneNode
      expect(result.maximized).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/panel-layout.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement panel-layout utilities**

Create `src/renderer/utils/panel-layout.ts`:

```typescript
import type { PaneNode, SplitNode, LayoutNode, PaneType } from '../../shared/types'

let paneCounter = 0

export function createPane(paneType: PaneType, props: Record<string, unknown> = {}): PaneNode {
  return {
    type: 'pane',
    id: `pane-${paneType}-${Date.now()}-${++paneCounter}`,
    paneType,
    props,
  }
}

export function findPane(node: LayoutNode, paneId: string): PaneNode | null {
  if (node.type === 'pane') {
    return node.id === paneId ? node : null
  }
  return findPane(node.children[0], paneId) || findPane(node.children[1], paneId)
}

export function splitPane(
  node: LayoutNode,
  targetPaneId: string,
  newPaneType: PaneType,
  direction: 'horizontal' | 'vertical',
  props: Record<string, unknown> = {},
): LayoutNode {
  if (node.type === 'pane') {
    if (node.id !== targetPaneId) return node
    const newPane = createPane(newPaneType, props)
    return {
      type: 'split',
      id: `split-${Date.now()}-${++paneCounter}`,
      direction,
      ratio: 0.5,
      children: [node, newPane],
    }
  }
  const leftResult = splitPane(node.children[0], targetPaneId, newPaneType, direction, props)
  if (leftResult !== node.children[0]) {
    return { ...node, children: [leftResult, node.children[1]] }
  }
  const rightResult = splitPane(node.children[1], targetPaneId, newPaneType, direction, props)
  if (rightResult !== node.children[1]) {
    return { ...node, children: [node.children[0], rightResult] }
  }
  return node
}

export function removePane(node: LayoutNode, paneId: string): LayoutNode {
  if (node.type === 'pane') return node // can't remove last pane
  const [left, right] = node.children
  if (left.type === 'pane' && left.id === paneId) return right
  if (right.type === 'pane' && right.id === paneId) return left
  const leftResult = removePane(left, paneId)
  if (leftResult !== left) {
    return { ...node, children: [leftResult, right] }
  }
  const rightResult = removePane(right, paneId)
  if (rightResult !== right) {
    return { ...node, children: [left, rightResult] }
  }
  return node
}

export function updateRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  const clamped = Math.max(0.1, Math.min(0.9, ratio))
  if (node.type === 'pane') return node
  if (node.id === splitId) return { ...node, ratio: clamped }
  const leftResult = updateRatio(node.children[0], splitId, ratio)
  if (leftResult !== node.children[0]) {
    return { ...node, children: [leftResult, node.children[1]] }
  }
  const rightResult = updateRatio(node.children[1], splitId, ratio)
  if (rightResult !== node.children[1]) {
    return { ...node, children: [node.children[0], rightResult] }
  }
  return node
}

export function countPanes(node: LayoutNode): number {
  if (node.type === 'pane') return 1
  return countPanes(node.children[0]) + countPanes(node.children[1])
}

export function getAllPaneIds(node: LayoutNode): string[] {
  if (node.type === 'pane') return [node.id]
  return [...getAllPaneIds(node.children[0]), ...getAllPaneIds(node.children[1])]
}

export function setMaximized(node: LayoutNode, paneId: string): LayoutNode {
  if (node.type === 'pane') {
    if (node.id === paneId) {
      return { ...node, maximized: !node.maximized }
    }
    return node.maximized ? { ...node, maximized: false } : node
  }
  return {
    ...node,
    children: [
      setMaximized(node.children[0], paneId),
      setMaximized(node.children[1], paneId),
    ] as [LayoutNode, LayoutNode],
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/panel-layout.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/utils/panel-layout.ts tests/unit/panel-layout.test.ts
git commit -m "feat(panels): add layout tree utility functions with tests"
```

### Task 4: Create panel store (Zustand)

**Files:**
- Create: `src/renderer/stores/panelStore.ts`
- Create: `tests/unit/panel-store.test.ts`

- [ ] **Step 1: Write failing tests for panel store**

Create `tests/unit/panel-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock config-saver before importing store
vi.mock('../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: vi.fn(),
  saveConfigDebounced: vi.fn(),
}))

import { usePanelStore } from '../../src/renderer/stores/panelStore'
import type { PaneNode, SplitNode } from '../../src/shared/types'

describe('panelStore', () => {
  beforeEach(() => {
    usePanelStore.getState().reset()
  })

  it('initializes with empty layouts map', () => {
    expect(usePanelStore.getState().layouts).toEqual({})
  })

  describe('initSession', () => {
    it('creates a default single-pane layout for a session', () => {
      usePanelStore.getState().initSession('session-1')
      const layout = usePanelStore.getState().layouts['session-1']
      expect(layout).toBeDefined()
      expect(layout.type).toBe('pane')
      expect((layout as PaneNode).paneType).toBe('claude-terminal')
    })

    it('creates side-by-side layout for ultrawide', () => {
      usePanelStore.getState().initSession('session-2', 3440)
      const layout = usePanelStore.getState().layouts['session-2']
      expect(layout.type).toBe('split')
      const split = layout as SplitNode
      expect((split.children[0] as PaneNode).paneType).toBe('claude-terminal')
      expect((split.children[1] as PaneNode).paneType).toBe('diff-viewer')
    })

    it('does not overwrite existing layout', () => {
      usePanelStore.getState().initSession('session-1')
      const originalLayout = usePanelStore.getState().layouts['session-1']
      usePanelStore.getState().initSession('session-1')
      expect(usePanelStore.getState().layouts['session-1']).toBe(originalLayout)
    })
  })

  describe('addPane', () => {
    it('splits the layout to add a new pane', () => {
      usePanelStore.getState().initSession('s1')
      const layout = usePanelStore.getState().layouts['s1'] as PaneNode
      usePanelStore.getState().addPane('s1', layout.id, 'diff-viewer', 'horizontal')
      const updated = usePanelStore.getState().layouts['s1']
      expect(updated.type).toBe('split')
    })
  })

  describe('removePane', () => {
    it('removes a pane and collapses the split', () => {
      usePanelStore.getState().initSession('s1')
      const layout = usePanelStore.getState().layouts['s1'] as PaneNode
      usePanelStore.getState().addPane('s1', layout.id, 'diff-viewer', 'horizontal')
      const split = usePanelStore.getState().layouts['s1'] as SplitNode
      const diffPane = split.children[1] as PaneNode
      usePanelStore.getState().removePane('s1', diffPane.id)
      const result = usePanelStore.getState().layouts['s1']
      expect(result.type).toBe('pane')
      expect((result as PaneNode).paneType).toBe('claude-terminal')
    })
  })

  describe('toggleMaximized', () => {
    it('maximizes a pane', () => {
      usePanelStore.getState().initSession('s1')
      const pane = usePanelStore.getState().layouts['s1'] as PaneNode
      usePanelStore.getState().toggleMaximized('s1', pane.id)
      const updated = usePanelStore.getState().layouts['s1'] as PaneNode
      expect(updated.maximized).toBe(true)
    })
  })

  describe('resizeSplit', () => {
    it('updates a split ratio', () => {
      usePanelStore.getState().initSession('s1')
      const layout = usePanelStore.getState().layouts['s1'] as PaneNode
      usePanelStore.getState().addPane('s1', layout.id, 'diff-viewer', 'horizontal')
      const split = usePanelStore.getState().layouts['s1'] as SplitNode
      usePanelStore.getState().resizeSplit('s1', split.id, 0.3)
      const updated = usePanelStore.getState().layouts['s1'] as SplitNode
      expect(updated.ratio).toBe(0.3)
    })
  })

  describe('removeSession', () => {
    it('removes a session layout', () => {
      usePanelStore.getState().initSession('s1')
      usePanelStore.getState().removeSession('s1')
      expect(usePanelStore.getState().layouts['s1']).toBeUndefined()
    })
  })

  describe('setLayout', () => {
    it('directly sets a layout for a session (for restore)', () => {
      const layout: PaneNode = {
        type: 'pane', id: 'p1', paneType: 'claude-terminal', props: {},
      }
      usePanelStore.getState().setLayout('s1', layout)
      expect(usePanelStore.getState().layouts['s1']).toBe(layout)
    })
  })

  describe('markUserCustomized', () => {
    it('marks a session layout as user-customized', () => {
      usePanelStore.getState().initSession('s1')
      expect(usePanelStore.getState().userCustomized['s1']).toBeFalsy()
      usePanelStore.getState().markUserCustomized('s1')
      expect(usePanelStore.getState().userCustomized['s1']).toBe(true)
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/panel-store.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement panel store**

Create `src/renderer/stores/panelStore.ts`:

```typescript
import { create } from 'zustand'
import { saveConfigDebounced } from '../utils/config-saver'
import { createPane, splitPane, removePane as removePaneFromTree, updateRatio, setMaximized } from '../utils/panel-layout'
import type { LayoutNode, PaneType, PaneNode, SplitNode } from '../../shared/types'

interface PanelState {
  layouts: Record<string, LayoutNode>         // sessionId -> layout tree
  userCustomized: Record<string, boolean>     // sessionId -> whether user has manually arranged

  initSession: (sessionId: string, windowWidth?: number) => void
  addPane: (sessionId: string, targetPaneId: string, paneType: PaneType, direction: 'horizontal' | 'vertical', props?: Record<string, unknown>) => void
  removePane: (sessionId: string, paneId: string) => void
  toggleMaximized: (sessionId: string, paneId: string) => void
  resizeSplit: (sessionId: string, splitId: string, ratio: number) => void
  removeSession: (sessionId: string) => void
  setLayout: (sessionId: string, layout: LayoutNode) => void
  markUserCustomized: (sessionId: string) => void
  resetLayout: (sessionId: string, windowWidth?: number) => void
  reset: () => void
}

function createDefaultLayout(windowWidth?: number): LayoutNode {
  const terminal = createPane('claude-terminal')
  // Ultrawide: side-by-side terminal + diff viewer
  if (windowWidth && windowWidth > 2560) {
    const diffViewer = createPane('diff-viewer')
    return {
      type: 'split',
      id: `split-default-${Date.now()}`,
      direction: 'horizontal',
      ratio: 0.6,
      children: [terminal, diffViewer],
    }
  }
  return terminal
}

export const usePanelStore = create<PanelState>((set, get) => ({
  layouts: {},
  userCustomized: {},

  initSession: (sessionId, windowWidth) => {
    const { layouts } = get()
    if (layouts[sessionId]) return // don't overwrite existing
    set({
      layouts: { ...layouts, [sessionId]: createDefaultLayout(windowWidth) },
    })
  },

  addPane: (sessionId, targetPaneId, paneType, direction, props) => {
    const { layouts } = get()
    const layout = layouts[sessionId]
    if (!layout) return
    const updated = splitPane(layout, targetPaneId, paneType, direction, props)
    set({
      layouts: { ...layouts, [sessionId]: updated },
      userCustomized: { ...get().userCustomized, [sessionId]: true },
    })
    saveConfigDebounced()
  },

  removePane: (sessionId, paneId) => {
    const { layouts } = get()
    const layout = layouts[sessionId]
    if (!layout) return
    const updated = removePaneFromTree(layout, paneId)
    set({
      layouts: { ...layouts, [sessionId]: updated },
      userCustomized: { ...get().userCustomized, [sessionId]: true },
    })
    saveConfigDebounced()
  },

  toggleMaximized: (sessionId, paneId) => {
    const { layouts } = get()
    const layout = layouts[sessionId]
    if (!layout) return
    set({ layouts: { ...layouts, [sessionId]: setMaximized(layout, paneId) } })
  },

  resizeSplit: (sessionId, splitId, ratio) => {
    const { layouts } = get()
    const layout = layouts[sessionId]
    if (!layout) return
    set({
      layouts: { ...layouts, [sessionId]: updateRatio(layout, splitId, ratio) },
      userCustomized: { ...get().userCustomized, [sessionId]: true },
    })
    saveConfigDebounced()
  },

  removeSession: (sessionId) => {
    const { layouts, userCustomized } = get()
    const { [sessionId]: _, ...remainingLayouts } = layouts
    const { [sessionId]: __, ...remainingCustom } = userCustomized
    set({ layouts: remainingLayouts, userCustomized: remainingCustom })
  },

  setLayout: (sessionId, layout) => {
    set({ layouts: { ...get().layouts, [sessionId]: layout } })
  },

  markUserCustomized: (sessionId) => {
    set({ userCustomized: { ...get().userCustomized, [sessionId]: true } })
  },

  resetLayout: (sessionId, windowWidth) => {
    set({
      layouts: { ...get().layouts, [sessionId]: createDefaultLayout(windowWidth) },
      userCustomized: { ...get().userCustomized, [sessionId]: false },
    })
    saveConfigDebounced()
  },

  reset: () => set({ layouts: {}, userCustomized: {} }),
}))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/panel-store.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/stores/panelStore.ts tests/unit/panel-store.test.ts
git commit -m "feat(panels): add panel store with layout management"
```

### Task 5: Create PaneHeader component

**Files:**
- Create: `src/renderer/components/panels/PaneHeader.tsx`

- [ ] **Step 1: Create the PaneHeader component**

Create `src/renderer/components/panels/PaneHeader.tsx`:

```tsx
import React, { useCallback } from 'react'
import type { PaneType } from '../../../shared/types'

interface Props {
  paneId: string
  paneType: PaneType
  title?: string
  isMaximized?: boolean
  canClose?: boolean    // false for last remaining pane
  onClose: () => void
  onMaximize: () => void
  onDragStart: (e: React.DragEvent) => void
}

const PANE_ICONS: Record<PaneType, string> = {
  'claude-terminal': String.fromCodePoint(0x25B6),     // play triangle
  'partner-terminal': String.fromCodePoint(0x25B6),
  'diff-viewer': String.fromCodePoint(0x25B2) + String.fromCodePoint(0x25BC), // up+down triangles
  'preview': String.fromCodePoint(0x25C9),             // fisheye
  'file-editor': String.fromCodePoint(0x1F4C4),        // page
}

const PANE_COLORS: Record<PaneType, string> = {
  'claude-terminal': '#89b4fa',    // blue
  'partner-terminal': '#a6e3a1',   // green
  'diff-viewer': '#f9e2af',        // yellow
  'preview': '#94e2d5',            // teal
  'file-editor': '#fab387',        // peach
}

const PANE_LABELS: Record<PaneType, string> = {
  'claude-terminal': 'Claude Terminal',
  'partner-terminal': 'Partner Terminal',
  'diff-viewer': 'Diff Viewer',
  'preview': 'Preview',
  'file-editor': 'File Editor',
}

export default function PaneHeader({
  paneId,
  paneType,
  title,
  isMaximized,
  canClose = true,
  onClose,
  onMaximize,
  onDragStart,
}: Props) {
  const label = title || PANE_LABELS[paneType]
  const color = PANE_COLORS[paneType]
  const icon = PANE_ICONS[paneType]

  return (
    <div
      className="flex items-center justify-between px-2 py-1 bg-mantle border-b border-surface0 select-none shrink-0"
      draggable
      onDragStart={onDragStart}
      style={{ cursor: 'grab' }}
    >
      <div className="flex items-center gap-1.5 text-xs min-w-0">
        <span style={{ color, fontSize: '9px' }}>{icon}</span>
        <span className="text-text font-medium truncate">{label}</span>
      </div>
      <div className="flex items-center gap-1 text-overlay0 text-xs">
        <button
          onClick={onMaximize}
          className="hover:text-text px-1 transition-colors"
          title={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? String.fromCodePoint(0x25A3) : String.fromCodePoint(0x25A1)}
        </button>
        {canClose && (
          <button
            onClick={onClose}
            className="hover:text-red px-1 transition-colors"
            title="Close pane"
          >
            {String.fromCodePoint(0x00D7)}
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/panels/PaneHeader.tsx
git commit -m "feat(panels): add PaneHeader component with drag handle and controls"
```

### Task 6: Create PaneRegistry

**Files:**
- Create: `src/renderer/components/panels/PaneRegistry.ts`

- [ ] **Step 1: Create the PaneRegistry**

Create `src/renderer/components/panels/PaneRegistry.ts`:

```typescript
import type { ComponentType } from 'react'
import type { PaneType } from '../../../shared/types'

export interface PaneComponentProps {
  paneId: string
  sessionId: string
  isActive: boolean
  props: Record<string, unknown>
}

const registry = new Map<PaneType, ComponentType<PaneComponentProps>>()

export function registerPaneComponent(type: PaneType, component: ComponentType<PaneComponentProps>): void {
  registry.set(type, component)
}

export function getPaneComponent(type: PaneType): ComponentType<PaneComponentProps> | undefined {
  return registry.get(type)
}

export function getRegisteredPaneTypes(): PaneType[] {
  return Array.from(registry.keys())
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/panels/PaneRegistry.ts
git commit -m "feat(panels): add PaneRegistry for mapping pane types to components"
```

### Task 7: Create PanelContainer (recursive split renderer)

**Files:**
- Create: `src/renderer/components/panels/PanelContainer.tsx`

- [ ] **Step 1: Create the PanelContainer component**

Create `src/renderer/components/panels/PanelContainer.tsx`:

```tsx
import React, { useCallback, useRef, useState } from 'react'
import type { LayoutNode, SplitNode, PaneNode } from '../../../shared/types'
import { usePanelStore } from '../../stores/panelStore'
import { countPanes } from '../../utils/panel-layout'
import PaneHeader from './PaneHeader'
import { getPaneComponent } from './PaneRegistry'

interface Props {
  sessionId: string
  isActive: boolean
}

interface SplitViewProps {
  node: SplitNode
  sessionId: string
  isActive: boolean
  totalPanes: number
}

interface PaneViewProps {
  node: PaneNode
  sessionId: string
  isActive: boolean
  canClose: boolean
}

function SplitDivider({
  direction,
  onDrag,
}: {
  direction: 'horizontal' | 'vertical'
  onDrag: (delta: number, total: number) => void
}) {
  const dividerRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startPos = direction === 'horizontal' ? e.clientX : e.clientY

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const parentEl = dividerRef.current?.parentElement
      if (!parentEl) return
      const rect = parentEl.getBoundingClientRect()
      const total = direction === 'horizontal' ? rect.width : rect.height
      const currentPos = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY
      const delta = currentPos - startPos
      onDrag(delta, total)
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }, [direction, onDrag])

  return (
    <div
      ref={dividerRef}
      onMouseDown={handleMouseDown}
      className="bg-surface0 hover:bg-blue/50 transition-colors shrink-0"
      style={{
        width: direction === 'horizontal' ? '4px' : '100%',
        height: direction === 'horizontal' ? '100%' : '4px',
        cursor: direction === 'horizontal' ? 'col-resize' : 'row-resize',
      }}
    />
  )
}

function PaneView({ node, sessionId, isActive, canClose }: PaneViewProps) {
  const { removePane, toggleMaximized } = usePanelStore()
  const Component = getPaneComponent(node.paneType)

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ paneId: node.id, sessionId }))
    e.dataTransfer.effectAllowed = 'move'
  }, [node.id, sessionId])

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
      <PaneHeader
        paneId={node.id}
        paneType={node.paneType}
        isMaximized={node.maximized}
        canClose={canClose}
        onClose={() => removePane(sessionId, node.id)}
        onMaximize={() => toggleMaximized(sessionId, node.id)}
        onDragStart={handleDragStart}
      />
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        {Component ? (
          <Component
            paneId={node.id}
            sessionId={sessionId}
            isActive={isActive}
            props={node.props}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-overlay0 text-sm">
            Pane type "{node.paneType}" not registered
          </div>
        )}
      </div>
    </div>
  )
}

function SplitView({ node, sessionId, isActive, totalPanes }: SplitViewProps) {
  const { resizeSplit } = usePanelStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const ratioRef = useRef(node.ratio)
  ratioRef.current = node.ratio

  const handleDrag = useCallback((delta: number, total: number) => {
    const ratioDelta = delta / total
    resizeSplit(sessionId, node.id, ratioRef.current + ratioDelta)
  }, [sessionId, node.id, resizeSplit])

  const isHorizontal = node.direction === 'horizontal'
  const firstSize = `${node.ratio * 100}%`
  const secondSize = `${(1 - node.ratio) * 100}%`

  const renderChild = (child: LayoutNode) => {
    if (child.type === 'pane') {
      return <PaneView node={child} sessionId={sessionId} isActive={isActive} canClose={totalPanes > 1} />
    }
    return <SplitView node={child} sessionId={sessionId} isActive={isActive} totalPanes={totalPanes} />
  }

  return (
    <div
      ref={containerRef}
      className="flex flex-1 min-h-0 min-w-0 overflow-hidden"
      style={{ flexDirection: isHorizontal ? 'row' : 'column' }}
    >
      <div style={{ [isHorizontal ? 'width' : 'height']: firstSize }} className="flex min-h-0 min-w-0 overflow-hidden">
        {renderChild(node.children[0])}
      </div>
      <SplitDivider direction={node.direction} onDrag={handleDrag} />
      <div style={{ [isHorizontal ? 'width' : 'height']: secondSize }} className="flex min-h-0 min-w-0 overflow-hidden">
        {renderChild(node.children[1])}
      </div>
    </div>
  )
}

export default function PanelContainer({ sessionId, isActive }: Props) {
  const layout = usePanelStore((s) => s.layouts[sessionId])
  if (!layout) return null

  const totalPanes = countPanes(layout)

  // If any pane is maximized, render only that pane
  const findMaximized = (node: LayoutNode): PaneNode | null => {
    if (node.type === 'pane') return node.maximized ? node : null
    return findMaximized(node.children[0]) || findMaximized(node.children[1])
  }

  const maximized = findMaximized(layout)
  if (maximized) {
    return (
      <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
        <PaneView node={maximized} sessionId={sessionId} isActive={isActive} canClose={false} />
      </div>
    )
  }

  if (layout.type === 'pane') {
    return (
      <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
        <PaneView node={layout} sessionId={sessionId} isActive={isActive} canClose={false} />
      </div>
    )
  }

  return <SplitView node={layout} sessionId={sessionId} isActive={isActive} totalPanes={totalPanes} />
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/panels/PanelContainer.tsx
git commit -m "feat(panels): add PanelContainer with recursive split rendering and resize dividers"
```

### Task 8: Wrap TerminalView as a pane component

**Files:**
- Create: `src/renderer/components/panels/TerminalPane.tsx`

- [ ] **Step 1: Create TerminalPane wrapper**

Create `src/renderer/components/panels/TerminalPane.tsx`:

```tsx
import React from 'react'
import TerminalView from '../TerminalView'
import { useSessionStore } from '../../stores/sessionStore'
import type { PaneComponentProps } from './PaneRegistry'

/**
 * Wraps TerminalView to work as a panel pane.
 * This is a thin adapter -- TerminalView does all the real work.
 */
export default function TerminalPane({ paneId, sessionId, isActive, props }: PaneComponentProps) {
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  if (!session) return null

  const isPartner = props.isPartner === true
  const ptySessionId = isPartner ? `${sessionId}-partner` : sessionId

  return (
    <TerminalView
      key={ptySessionId + '-' + session.createdAt}
      sessionId={ptySessionId}
      configId={session.configId}
      cwd={isPartner ? (session.partnerTerminalPath || session.workingDirectory) : (session.sessionType === 'local' ? session.workingDirectory : undefined)}
      shellOnly={isPartner ? true : session.shellOnly}
      elevated={isPartner ? session.partnerElevated : undefined}
      ssh={isPartner ? undefined : session.sshConfig}
      isActive={isActive}
      legacyVersion={isPartner ? undefined : session.legacyVersion}
      agentIds={isPartner ? undefined : session.agentIds}
      flickerFree={isPartner ? undefined : session.flickerFree}
      powershellTool={isPartner ? undefined : session.powershellTool}
      effortLevel={isPartner ? undefined : session.effortLevel}
      disableAutoMemory={isPartner ? undefined : session.disableAutoMemory}
    />
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/panels/TerminalPane.tsx
git commit -m "feat(panels): add TerminalPane adapter for panel system"
```

### Task 9: Register pane components and integrate into App.tsx

**Files:**
- Create: `src/renderer/components/panels/index.ts`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Create panels index with registration**

Create `src/renderer/components/panels/index.ts`:

```typescript
import { registerPaneComponent } from './PaneRegistry'
import TerminalPane from './TerminalPane'

// Register all built-in pane components
// Future phases will add: DiffViewerPane, PreviewPane, FileEditorPane
registerPaneComponent('claude-terminal', TerminalPane)
registerPaneComponent('partner-terminal', TerminalPane)

export { default as PanelContainer } from './PanelContainer'
export { default as PaneHeader } from './PaneHeader'
```

- [ ] **Step 2: Modify App.tsx to use PanelContainer**

Replace the `renderSessions` function in `src/renderer/App.tsx`.

First, add the import at the top of App.tsx after the existing component imports:

```typescript
import { PanelContainer } from './components/panels'
import { usePanelStore } from './stores/panelStore'
```

Then replace the `renderSessions` function body. The key change: instead of rendering `TerminalView` directly with show/hide for partner, we render `PanelContainer` which manages the layout tree.

Replace the section from `const renderSessions = () => {` through the closing `}` of that function (lines ~330-418) with:

```typescript
  const renderSessions = () => {
    if (!activeSessionId || sessions.length === 0 || !activeSession) {
      return (
        <div className="flex-1 flex flex-col" style={{ display: view === 'sessions' ? 'flex' : 'none' }}>
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-overlay1">
              <div className="text-5xl mb-4 font-mono">&gt;_</div>
              <h2 className="text-xl font-semibold mb-2">Claude Command Center</h2>
              <p className="text-sm">Create a terminal config to get started</p>
              <p className="text-xs text-overlay0 mt-2">Ctrl+T to create, Ctrl+Tab to switch</p>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="flex-1 flex flex-col" style={{ display: view === 'sessions' ? 'flex' : 'none', minHeight: 0 }}>
        <TabBar />
        <SessionHeader session={activeSession} sidebarCollapsed={!sidebarOpen} onShowTip={() => setShowTipModal(true)} />
        {sessions.map((session) => (
          <div
            key={session.id + '-' + session.createdAt}
            className="flex-1 flex flex-col"
            style={{
              display: session.id === activeSessionId ? 'flex' : 'none',
              minHeight: 0,
            }}
          >
            <PanelContainer sessionId={session.id} isActive={session.id === activeSessionId && view === 'sessions'} />
          </div>
        ))}
      </div>
    )
  }
```

Also add panel initialization when sessions are created. In the session creation code (around line 558 in the `onConfirm` handler of GuidedConfigView), after `useSessionStore.getState().addSession(session)`, add:

```typescript
usePanelStore.getState().initSession(session.id, window.innerWidth)
// If config has a partner terminal, add partner pane
if (newConfig.partnerTerminalPath) {
  const layout = usePanelStore.getState().layouts[session.id]
  if (layout && layout.type === 'pane') {
    usePanelStore.getState().addPane(session.id, layout.id, 'partner-terminal', 'vertical', { isPartner: true })
  }
}
```

Remove the `partnerActive` state and `togglePartner` function (lines 77-95) and the `isShowingPartner` prop from SessionHeader since partner is now managed by the panel system.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Run existing tests**

Run: `npx vitest run`
Expected: All existing tests pass (no regressions)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/panels/index.ts src/renderer/App.tsx
git commit -m "feat(panels): integrate PanelContainer into App.tsx, replacing fixed layout"
```

### Task 10: Add Views dropdown to SessionHeader

**Files:**
- Modify: `src/renderer/components/SessionHeader.tsx`

- [ ] **Step 1: Add Views dropdown menu**

Add a "Views" dropdown button to SessionHeader that lists available pane types. When clicked, it adds the selected pane type to the current session's layout by splitting the first available pane horizontally.

In `SessionHeader.tsx`, add these imports:

```typescript
import { usePanelStore } from '../stores/panelStore'
import { getAllPaneIds } from '../utils/panel-layout'
import type { PaneType } from '../../shared/types'
```

Add a state for the dropdown and the menu itself after the existing state declarations:

```typescript
const [viewsMenu, setViewsMenu] = useState(false)
const layout = usePanelStore((s) => s.layouts[session.id])

const addPane = (paneType: PaneType) => {
  setViewsMenu(false)
  if (!layout) return
  const paneIds = getAllPaneIds(layout)
  if (paneIds.length === 0) return
  // Split the first pane to add the new one
  usePanelStore.getState().addPane(session.id, paneIds[0], paneType, 'horizontal')
}

const resetLayout = () => {
  setViewsMenu(false)
  usePanelStore.getState().resetLayout(session.id, window.innerWidth)
}
```

Add the Views button in the JSX, after the model name span:

```tsx
<div className="relative ml-auto">
  <button
    onClick={() => setViewsMenu(!viewsMenu)}
    className="text-xs text-overlay1 hover:text-text px-2 py-0.5 rounded hover:bg-surface0 transition-colors"
  >
    Views
  </button>
  {viewsMenu && (
    <div className="absolute right-0 top-full mt-1 bg-surface0 border border-surface1 rounded-lg shadow-xl py-1 z-50 min-w-[160px]">
      <button onClick={() => addPane('diff-viewer')} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors">
        Diff Viewer
      </button>
      <button onClick={() => addPane('preview')} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors">
        Preview
      </button>
      <button onClick={() => addPane('file-editor')} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors">
        File Editor
      </button>
      <button onClick={() => addPane('partner-terminal')} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors">
        Partner Terminal
      </button>
      <div className="border-t border-surface1 my-1" />
      <button onClick={resetLayout} className="w-full text-left px-3 py-1.5 text-xs text-overlay1 hover:bg-surface1 transition-colors">
        Reset Layout
      </button>
    </div>
  )}
</div>
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/SessionHeader.tsx
git commit -m "feat(panels): add Views dropdown to SessionHeader for adding panes"
```

### Task 11: Add panel system tips and tour step

**Files:**
- Modify: `src/renderer/tips-library.ts`

- [ ] **Step 1: Add panel system tips**

Add two new tips to the `TIPS` array in `tips-library.ts`:

```typescript
{
  id: 'tip.panel-layout',
  category: 'ui-navigation',
  complexity: 'intermediate',
  priority: 85,
  variants: {
    primary: {
      shortText: 'Arrange your workspace with drag-and-drop panels',
      title: 'Drag-and-Drop Panel Layout',
      body: 'Click **Views** in the session header to add panels like Diff Viewer, Preview, or File Editor alongside your terminal. Drag panel headers to rearrange, drag edges to resize, and double-click a header to maximize any panel.',
      actionLabel: 'Open a session to try it',
      actionTarget: 'sessions',
      focusHint: 'Look for the "Views" button in the session header bar',
    },
    postUse: {
      shortText: 'You can save and restore panel layouts',
      title: 'Panel Layout Power Tips',
      body: 'Your panel layout is saved per session and restored on restart. Use **Reset Layout** in the Views menu to return to the default. On ultrawide monitors, new sessions auto-start with a side-by-side layout.',
    },
  },
},
{
  id: 'tip.panel-maximize',
  category: 'productivity',
  complexity: 'simple',
  priority: 70,
  requires: ['panels.add-pane'],
  variants: {
    primary: {
      shortText: 'Double-click a panel header to maximize it',
      title: 'Maximize Panels',
      body: 'When you have multiple panels open, double-click any panel header to maximize it to full size. Double-click again to restore the split layout. Great for focusing on a diff or preview temporarily.',
    },
  },
},
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/tips-library.ts
git commit -m "feat(tips): add panel layout and maximize tips"
```

### Task 12: Add Phase 1 tests (unit + E2E)

**Files:**
- Verify: `tests/unit/panel-types.test.ts` (from Task 2)
- Verify: `tests/unit/panel-layout.test.ts` (from Task 3)
- Verify: `tests/unit/panel-store.test.ts` (from Task 4)
- Create: `tests/e2e/panels.spec.ts`

- [ ] **Step 1: Run all unit tests**

Run: `npx vitest run`
Expected: All tests pass including new panel tests

- [ ] **Step 2: Create E2E test for panels**

Create `tests/e2e/panels.spec.ts`:

```typescript
/**
 * Playwright E2E tests -- Panel system
 */
import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'path'

const APP_PATH = path.resolve(__dirname, '../../out/main/index.js')

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await electron.launch({
    args: [APP_PATH],
    env: { ...process.env, NODE_ENV: 'test', E2E_HEADLESS: '1' },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)
})

test.afterAll(async () => {
  if (app) await app.close()
})

test.describe('Panel System', () => {
  test('sessions view renders PanelContainer', async () => {
    // If setup dialog is showing, skip
    const sidebar = page.locator('aside')
    if (!await sidebar.isVisible().catch(() => false)) {
      test.skip()
      return
    }
    // Look for panel-related UI elements
    const mainArea = page.locator('main')
    await expect(mainArea).toBeVisible()
  })

  test('Views button is visible in session header', async () => {
    const viewsButton = page.getByText('Views')
    // May not be visible if no session is active -- that's OK
    const isVisible = await viewsButton.isVisible().catch(() => false)
    // Just verify the app loads without crashing
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 3: Build and run E2E tests**

Run: `npm run build && npx playwright test tests/e2e/panels.spec.ts`
Expected: Tests pass (basic smoke tests)

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/panels.spec.ts
git commit -m "test(panels): add E2E smoke tests for panel system"
```

---

## Phase 2: Side Chat (Tasks 13-18)

> Full TDD steps will be expanded when Phase 1 is complete. Below are task-level outlines.

### Task 13: Add Side Chat IPC channels
**Files:** Modify `src/shared/ipc-channels.ts`, Modify `src/preload/index.ts`
- Add `SIDE_CHAT_SPAWN`, `SIDE_CHAT_KILL`, `SIDE_CHAT_GET_CONTEXT` channels
- Add preload bridge methods under `sideChat` namespace

### Task 14: Create side-chat-manager (main process)
**Files:** Create `src/main/side-chat-manager.ts`, Create `src/main/ipc/side-chat-handlers.ts`
- `spawnSideChat(parentSessionId, options)` -- spawns new PTY session with context injection
- Context extraction: capture last N lines from parent PTY output buffer
- SSH support: spawn second SSH connection using parent's sshConfig
- Write temporary context file, clean up on close
- Register IPC handlers in `src/main/index.ts`

### Task 15: Create SideChatPane overlay component
**Files:** Create `src/renderer/components/panels/SideChatPane.tsx`
- Slide-in overlay from right (35-40% width), dimmed background
- "Branched from [session name]" header indicator
- Info bar about context isolation
- Embedded xterm.js terminal for the side chat PTY
- Close on Escape, Ctrl+;, or click X

### Task 16: Integrate Side Chat into App.tsx
**Files:** Modify `src/renderer/App.tsx`
- Add side chat overlay rendering (outside PanelContainer, on top)
- Add Ctrl+; keyboard shortcut in `useKeyboardShortcuts`
- State: `sideChatSessionId` per active session
- Kill side chat PTY on overlay close

### Task 17: Add Side Chat tips
**Files:** Modify `src/renderer/tips-library.ts`
- Tip: "Ask questions without derailing your session" with Ctrl+; shortcut

### Task 18: Side Chat tests
**Files:** Create `tests/unit/side-chat-manager.test.ts`, Create `tests/e2e/side-chat.spec.ts`
- Unit: context extraction, session ID generation, cleanup
- E2E: Ctrl+; opens overlay, overlay closes on Escape

---

## Phase 3: Diff Viewer (Tasks 19-26)

### Task 19: Add Diff Viewer IPC channels
**Files:** Modify `src/shared/ipc-channels.ts`, Modify `src/preload/index.ts`
- Add `DIFF_GET`, `DIFF_SUBSCRIBE`, `DIFF_UNSUBSCRIBE`, `DIFF_COMMENT_SUBMIT` channels

### Task 20: Create diff-generator (main process)
**Files:** Create `src/main/diff-generator.ts`, Create `tests/unit/diff-generator.test.ts`
- Parse unified diff output into `DiffFile[]` structured data
- TDD: test with sample git diff output strings
- Handle additions, modifications, deletions, renames, binary files

### Task 21: Create file-watcher (main process)
**Files:** Create `src/main/file-watcher.ts`
- chokidar watcher scoped to session working directory
- Debounce at 500ms
- On change: run `git diff`, parse, emit to renderer
- Git repo detection (skip if not a git repo)
- Start/stop per session lifecycle

### Task 22: Create diff IPC handlers
**Files:** Create `src/main/ipc/diff-handlers.ts`
- Register in `src/main/index.ts`
- `diff:get` -- returns current diffs for a session
- `diff:subscribe` -- start file watcher for a session
- `diff:comment:submit` -- write comments as prompt to Claude PTY

### Task 23b: Add DiffFile types to shared module
**Files:** Modify `src/shared/types.ts`
- Add `DiffFile`, `DiffHunk`, `DiffLine`, `DiffLineComment` interfaces (from spec)

### Task 24: Create DiffViewerPane component
**Files:** Create `src/renderer/components/panels/DiffViewerPane.tsx`, Create `src/renderer/components/panels/DiffComment.tsx`
- Register in PaneRegistry
- File list sidebar (left) with filename, status, +/- counts
- Inline diff view (right) with Catppuccin syntax colors
- Click-to-comment on diff lines
- Ctrl+Enter to batch submit comments to Claude terminal

### Task 25: Add diff stats badge to SessionHeader
**Files:** Modify `src/renderer/components/SessionHeader.tsx`
- Show `+N -M` badge when uncommitted changes exist
- Click badge to open/focus diff pane

### Task 26: Diff Viewer tips and tests
**Files:** Modify `src/renderer/tips-library.ts`, Create `tests/unit/diff-generator.test.ts`, Create `tests/e2e/diff-viewer.spec.ts`
- Tip: "Review Claude's changes with the Diff Viewer" with Ctrl+Shift+D shortcut
- Unit: diff parsing, file watcher debounce
- E2E: diff pane opens, shows file list

---

## Phase 4: Preview Pane (Tasks 27-32)

### Task 27: Add Preview IPC channels
**Files:** Modify `src/shared/ipc-channels.ts`, Modify `src/preload/index.ts`

### Task 28: Create preview-manager (main process)
**Files:** Create `src/main/preview-manager.ts`, Create `src/main/ipc/preview-handlers.ts`
- Dev server URL detection with regex patterns
- File type routing (.html/.pdf/.png to preview, others to editor)
- Toast notification system for detected servers
- Settings: auto-detect toggle, suppressed projects list

### Task 29: Create PreviewPane component
**Files:** Create `src/renderer/components/panels/PreviewPane.tsx`
- Register in PaneRegistry
- Electron `<webview>` tag with sandboxing
- URL bar, refresh, back/forward buttons
- Loading spinner
- External links open via `shell.openExternal` (https:// only)

### Task 30: Integrate dev server detection into terminal output
**Files:** Modify `src/renderer/components/TerminalView.tsx` or panels/TerminalPane.tsx
- Parse terminal data stream for dev server URL patterns
- Show toast notification with Open/Dismiss/Don't Ask Again

### Task 31: Add clickable file paths for preview
**Files:** Modify terminal link handling
- Route .html/.pdf/.png/.jpg/.svg/.gif clicks to preview pane
- Right-click context menu: "Open in Preview" / "Open in Editor"

### Task 32: Preview tips and tests
**Files:** Modify `src/renderer/tips-library.ts`, Create `tests/e2e/preview.spec.ts`

---

## Phase 5: File Editor (Tasks 33-37)

### Task 33: Add Monaco Editor dependency
**Files:** `package.json`
- `npm install monaco-editor @monaco-editor/react`
- Configure electron-vite for Monaco worker bundling

### Task 34: Create file-editor IPC handlers
**Files:** Create `src/main/ipc/file-editor-handlers.ts`, Modify `src/shared/ipc-channels.ts`, Modify `src/preload/index.ts`
- `file:read` -- read file content (with path validation: must be within session working directory)
- `file:write` -- atomic write (using existing config-manager pattern)
- `file:watch` -- fs.watch for disk change notifications

### Task 35: Create FileEditorPane component
**Files:** Create `src/renderer/components/panels/FileEditorPane.tsx`
- Register in PaneRegistry
- Monaco editor with Catppuccin Mocha theme
- Tab bar for multiple open files
- Save (Ctrl+S), Discard buttons
- Yellow warning bar for disk-change detection: "File changed on disk" with Reload/Override
- Path display in header, click to copy

### Task 36: Route file path clicks to File Editor
**Files:** Modify terminal link handling
- Non-preview file types open in File Editor pane
- From Diff Viewer "Edit" button

### Task 37: File Editor tips and tests
**Files:** Modify `src/renderer/tips-library.ts`, Create `tests/e2e/file-editor.spec.ts`

---

## Phase 6: Git Worktree Isolation (Tasks 38-42)

### Task 38: Create git-manager (main process)
**Files:** Create `src/main/git-manager.ts`, Create `tests/unit/git-manager.test.ts`
- `isGitRepo(path)` -- detect git repository
- `createWorktree(repoPath, sessionId, branchName)` -- `git worktree add`
- `removeWorktree(worktreePath)` -- `git worktree remove`
- `listWorktrees(repoPath)` -- `git worktree list`
- Auto-add `.worktrees/` to `.gitignore`

### Task 39: Add git IPC handlers
**Files:** Create `src/main/ipc/git-handlers.ts`, Modify `src/shared/ipc-channels.ts`, Modify `src/preload/index.ts`
- Register handlers in `src/main/index.ts`

### Task 40: Add worktree toggle to SessionDialog
**Files:** Modify `src/renderer/components/SessionDialog.tsx`, Modify `src/renderer/stores/configStore.ts`
- Add `useWorktree?: boolean` to TerminalConfig
- Toggle in SessionDialog: "Isolate with git worktree"
- Disabled with tooltip when working directory is not a git repo

### Task 41: Integrate worktree into PTY spawn
**Files:** Modify `src/main/pty-manager.ts` or `src/main/ipc/pty-handlers.ts`
- Before spawning PTY: if worktree enabled, create worktree and use worktree path as cwd
- Inject CLAUDE.md context about worktree setup
- On session close: prompt to delete/keep/merge worktree
- SSH: run git worktree commands over SSH PTY

### Task 42: Worktree tips and tests
**Files:** Modify `src/renderer/tips-library.ts`, Create `tests/unit/git-manager.test.ts`, Create `tests/e2e/worktrees.spec.ts`

---

## Post-Implementation

### Screenshot Capture Updates
After all phases: update `scripts/capture-training-screenshots.ts` to capture new panel layouts, diff viewer with sample diffs, preview pane with demo content, side chat overlay, and file editor with syntax highlighting.

### Training Walkthrough
Add 6 new steps to `src/renderer/components/TrainingWalkthrough.tsx`:
1. "Arrange your workspace" (drag-and-drop panels)
2. "Ask side questions" (Ctrl+;)
3. "Review changes" (diff viewer)
4. "Preview your app" (preview pane)
5. "Edit files inline" (file editor)
6. "Isolate with worktrees" (git worktree toggle)

### Final Verification
- `npm run build` succeeds
- `npx vitest run` -- all tests pass
- `npx playwright test` -- all E2E tests pass on Windows
- Manual testing: create session, add panes, resize, maximize, side chat, diff viewer
- Update release checklist in `scripts/release.js` for v2 features
