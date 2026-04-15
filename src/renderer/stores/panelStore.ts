import { create } from 'zustand'
import { saveConfigDebounced } from '../utils/config-saver'
import { createPane, splitPane, removePane as removePaneFromTree, updateRatio, setMaximized } from '../utils/panel-layout'
import type { LayoutNode, PaneType, PaneNode, SplitNode } from '../../shared/types'

interface PanelState {
  layouts: Record<string, LayoutNode>
  userCustomized: Record<string, boolean>

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
  if (windowWidth && windowWidth > 2560) {
    const diffViewer = createPane('diff-viewer')
    return {
      type: 'split',
      id: `split-default-${Date.now()}`,
      direction: 'horizontal',
      ratio: 0.6,
      children: [terminal, diffViewer],
    } as SplitNode
  }
  return terminal
}

export const usePanelStore = create<PanelState>((set, get) => ({
  layouts: {},
  userCustomized: {},

  initSession: (sessionId, windowWidth) => {
    const { layouts } = get()
    if (layouts[sessionId]) return
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
