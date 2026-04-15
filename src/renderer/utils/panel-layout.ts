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
