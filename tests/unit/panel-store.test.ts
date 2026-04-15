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
