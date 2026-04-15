import React, { useCallback, useEffect, useRef } from 'react'
import type { LayoutNode, SplitNode, PaneNode } from '../../../shared/types'
import { usePanelStore } from '../../stores/panelStore'
import { countPanes, findMaximizedPane } from '../../utils/panel-layout'
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
  onDragUpdate,
}: {
  direction: 'horizontal' | 'vertical'
  onDragUpdate: (newRatio: number) => void
}) {
  const dividerRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const parentEl = dividerRef.current?.parentElement
      if (!parentEl) return
      const rect = parentEl.getBoundingClientRect()
      const total = direction === 'horizontal' ? rect.width : rect.height
      const offset = direction === 'horizontal'
        ? moveEvent.clientX - rect.left
        : moveEvent.clientY - rect.top
      onDragUpdate(offset / total)
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
  }, [direction, onDragUpdate])

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
            Pane type &quot;{node.paneType}&quot; not registered
          </div>
        )}
      </div>
    </div>
  )
}

function SplitView({ node, sessionId, isActive, totalPanes }: SplitViewProps) {
  const { resizeSplit } = usePanelStore()

  const handleDragUpdate = useCallback((newRatio: number) => {
    resizeSplit(sessionId, node.id, newRatio)
  }, [sessionId, node.id, resizeSplit])

  const isHorizontal = node.direction === 'horizontal'
  // Subtract 2px from each side to account for the 4px divider
  const firstSize = `calc(${node.ratio * 100}% - 2px)`
  const secondSize = `calc(${(1 - node.ratio) * 100}% - 2px)`

  const renderChild = (child: LayoutNode) => {
    if (child.type === 'pane') {
      return <PaneView node={child} sessionId={sessionId} isActive={isActive} canClose={totalPanes > 1} />
    }
    return <SplitView node={child} sessionId={sessionId} isActive={isActive} totalPanes={totalPanes} />
  }

  return (
    <div
      className="flex flex-1 min-h-0 min-w-0 overflow-hidden"
      style={{ flexDirection: isHorizontal ? 'row' : 'column' }}
    >
      <div style={{ [isHorizontal ? 'width' : 'height']: firstSize }} className="flex min-h-0 min-w-0 overflow-hidden">
        {renderChild(node.children[0])}
      </div>
      <SplitDivider direction={node.direction} onDragUpdate={handleDragUpdate} />
      <div style={{ [isHorizontal ? 'width' : 'height']: secondSize }} className="flex min-h-0 min-w-0 overflow-hidden">
        {renderChild(node.children[1])}
      </div>
    </div>
  )
}

export default function PanelContainer({ sessionId, isActive }: Props) {
  const layout = usePanelStore((s) => s.layouts[sessionId])

  // Self-initialize: if no layout exists for this session, create one.
  // This handles all session creation paths (Sidebar, ProjectBrowser, restore, etc.)
  // without requiring each callsite to explicitly init the panel store.
  useEffect(() => {
    if (!layout) {
      usePanelStore.getState().initSession(sessionId, window.innerWidth)
    }
  }, [sessionId, layout])

  if (!layout) return null

  const totalPanes = countPanes(layout)

  const maximized = findMaximizedPane(layout)
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
