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
