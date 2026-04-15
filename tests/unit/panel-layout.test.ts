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
      const outer = result as SplitNode
      expect(outer.children[0]).toBe(t)
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
      expect(result).toBe(t)
    })

    it('removes a pane from a two-pane split, returning sibling', () => {
      const t = terminal()
      const d = diff()
      const split: SplitNode = {
        type: 'split', id: 's1', direction: 'horizontal', ratio: 0.5,
        children: [t, d],
      }
      const result = removePane(split, d.id)
      expect(result).toBe(t)
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
      expect(result.children[1]).toBe(d)
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
