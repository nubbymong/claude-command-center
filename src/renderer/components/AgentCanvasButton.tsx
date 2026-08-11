import React from 'react'
import { useExcalidrawStore } from '../stores/excalidrawStore'

interface Props {
  sessionId: string
}

/**
 * Tool button next to Snap/Web — the Agent Canvas entry (spec D2: the old
 * per-session Draw button became the canvas; the classic Excalidraw
 * scratchpad lives on as the canvas's empty state, so pane visibility still
 * lives in excalidrawStore and nothing the Draw button did is lost).
 */
export default function AgentCanvasButton({ sessionId }: Props) {
  const isOpen = useExcalidrawStore((s) => !!s.bySessionId[sessionId]?.isOpen)
  const togglePane = useExcalidrawStore((s) => s.togglePane)

  return (
    <button
      onClick={() => togglePane(sessionId)}
      className={`flex items-center gap-1.5 px-2 py-0.5 text-xs rounded border whitespace-nowrap shrink-0 transition-colors ${
        isOpen
          ? 'bg-surface1 border-surface1 text-text'
          : 'bg-surface0/60 border-surface1/80 hover:bg-surface1 text-overlay1 hover:text-text'
      }`}
      title={isOpen ? 'Hide Agent Canvas' : 'Open Agent Canvas'}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {/* Framed-canvas + pen glyph */}
        <rect x="1.5" y="2.5" width="13" height="9" rx="1" />
        <path d="M10.8 5.2l1.6 1.6-3.4 3.4H7.4V8.6z" />
        <path d="M5 14h6" />
      </svg>
      Canvas
    </button>
  )
}
