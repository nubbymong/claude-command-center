import React, { useCallback, useEffect, useRef, useState } from 'react'
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
  focusedPaneId: string | undefined
}

interface PaneViewProps {
  node: PaneNode
  sessionId: string
  isActive: boolean
  canClose: boolean
  isFocused: boolean
}

// Snap points for divider dragging
const SNAP_POINTS = [0.25, 0.333, 0.5, 0.667, 0.75]
const SNAP_THRESHOLD = 0.02

function snapRatio(ratio: number, shiftHeld: boolean): number {
  if (shiftHeld) return ratio
  for (const snap of SNAP_POINTS) {
    if (Math.abs(ratio - snap) < SNAP_THRESHOLD) return snap
  }
  return ratio
}

function SplitDivider({
  direction,
  onDragUpdate,
}: {
  direction: 'horizontal' | 'vertical'
  onDragUpdate: (newRatio: number) => void
}) {
  const dividerRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragRatio, setDragRatio] = useState<number | null>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const parentEl = dividerRef.current?.parentElement
      if (!parentEl) return
      const rect = parentEl.getBoundingClientRect()
      const total = direction === 'horizontal' ? rect.width : rect.height
      const offset = direction === 'horizontal'
        ? moveEvent.clientX - rect.left
        : moveEvent.clientY - rect.top
      const raw = offset / total
      const snapped = snapRatio(raw, moveEvent.shiftKey)
      setDragRatio(snapped)
      onDragUpdate(snapped)
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setIsDragging(false)
      setDragRatio(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }, [direction, onDragUpdate])

  return (
    <div className="relative shrink-0" style={{ width: direction === 'horizontal' ? '4px' : '100%', height: direction === 'horizontal' ? '100%' : '4px' }}>
      <div
        ref={dividerRef}
        onMouseDown={handleMouseDown}
        className="absolute inset-0 transition-colors duration-150"
        style={{
          background: isDragging ? 'rgba(137,180,250,0.5)' : '#313244',
          cursor: direction === 'horizontal' ? 'col-resize' : 'row-resize',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(137,180,250,0.3)' }}
        onMouseLeave={(e) => { if (!isDragging) e.currentTarget.style.background = '#313244' }}
      />
      {/* Snap percentage label while dragging */}
      {isDragging && dragRatio !== null && (
        <div
          className="absolute z-50 bg-surface0 text-text text-xs px-2 py-0.5 rounded shadow-lg pointer-events-none"
          style={{
            [direction === 'horizontal' ? 'top' : 'left']: '50%',
            [direction === 'horizontal' ? 'left' : 'top']: '50%',
            transform: 'translate(-50%, -50%)',
          }}
        >
          {Math.round(dragRatio * 100)}%
        </div>
      )}
    </div>
  )
}

function PaneView({ node, sessionId, isActive, canClose, isFocused }: PaneViewProps) {
  const removePane = usePanelStore((s) => s.removePane)
  const toggleMaximized = usePanelStore((s) => s.toggleMaximized)
  const setFocusedPane = usePanelStore((s) => s.setFocusedPane)
  const Component = getPaneComponent(node.paneType)
  const [mounted, setMounted] = useState(false)

  // Animate mount
  useEffect(() => {
    requestAnimationFrame(() => setMounted(true))
  }, [])

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ paneId: node.id, sessionId }))
    e.dataTransfer.effectAllowed = 'move'
  }, [node.id, sessionId])

  return (
    <div
      className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden transition-all duration-200"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'scale(1)' : 'scale(0.97)',
      }}
      onPointerDown={() => setFocusedPane(sessionId, node.id)}
    >
      <PaneHeader
        paneId={node.id}
        paneType={node.paneType}
        isMaximized={node.maximized}
        isFocused={isFocused}
        canClose={canClose}
        onClose={() => removePane(sessionId, node.id)}
        onMaximize={() => toggleMaximized(sessionId, node.id)}
        onDragStart={handleDragStart}
        onFocus={() => setFocusedPane(sessionId, node.id)}
      />
      <div
        className="flex-1 min-h-0 min-w-0 overflow-hidden transition-opacity duration-150"
        style={{ opacity: isFocused ? 1 : 0.85 }}
      >
        {Component ? (
          <Component
            paneId={node.id}
            paneType={node.paneType}
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

function SplitView({ node, sessionId, isActive, totalPanes, focusedPaneId }: SplitViewProps) {
  const resizeSplit = usePanelStore((s) => s.resizeSplit)

  const handleDragUpdate = useCallback((newRatio: number) => {
    resizeSplit(sessionId, node.id, newRatio)
  }, [sessionId, node.id, resizeSplit])

  const isHorizontal = node.direction === 'horizontal'
  // Subtract 2px from each side to account for the 4px divider
  const firstSize = `calc(${node.ratio * 100}% - 2px)`
  const secondSize = `calc(${(1 - node.ratio) * 100}% - 2px)`

  const renderChild = (child: LayoutNode) => {
    if (child.type === 'pane') {
      return (
        <PaneView
          node={child}
          sessionId={sessionId}
          isActive={isActive}
          canClose={totalPanes > 1}
          isFocused={focusedPaneId === child.id}
        />
      )
    }
    return <SplitView node={child} sessionId={sessionId} isActive={isActive} totalPanes={totalPanes} focusedPaneId={focusedPaneId} />
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
  const focusedPaneId = usePanelStore((s) => s.focusedPaneId[sessionId])

  // Self-initialize: if no layout exists for this session, create one.
  useEffect(() => {
    if (!layout) {
      usePanelStore.getState().initSession(sessionId, window.innerWidth)
    }
  }, [sessionId, layout])

  // Auto-focus first pane if none focused
  useEffect(() => {
    if (layout && !focusedPaneId) {
      if (layout.type === 'pane') {
        usePanelStore.getState().setFocusedPane(sessionId, layout.id)
      }
    }
  }, [sessionId, layout, focusedPaneId])

  if (!layout) return null

  const totalPanes = countPanes(layout)

  const maximized = findMaximizedPane(layout)
  if (maximized) {
    return (
      <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
        <PaneView node={maximized} sessionId={sessionId} isActive={isActive} canClose={false} isFocused={true} />
      </div>
    )
  }

  if (layout.type === 'pane') {
    return (
      <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
        <PaneView node={layout} sessionId={sessionId} isActive={isActive} canClose={false} isFocused={true} />
      </div>
    )
  }

  return <SplitView node={layout} sessionId={sessionId} isActive={isActive} totalPanes={totalPanes} focusedPaneId={focusedPaneId} />
}
