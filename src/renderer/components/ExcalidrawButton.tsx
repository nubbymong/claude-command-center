import React from 'react'
import { useExcalidrawStore } from '../stores/excalidrawStore'

interface Props {
  sessionId: string
}

/**
 * Tool button next to Snap/Web. Toggles the per-session Excalidraw
 * pane in place of the active terminal pane (instead of overlaying a
 * fixed modal across the entire app — that prior modal blew past the
 * Claude/Partner content area and trapped the user).
 */
export default function ExcalidrawButton({ sessionId }: Props) {
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
      title={isOpen ? 'Hide Excalidraw scratchpad' : 'Open Excalidraw scratchpad'}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {/* Pencil / sketch glyph */}
        <path d="M11.5 2.5l2 2-7 7H4.5v-2z" />
        <path d="M2 14h12" />
      </svg>
      Draw
    </button>
  )
}
