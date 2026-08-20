import React from 'react'
import { useExcalidrawStore } from '../stores/excalidrawStore'
import { useCanvasStore } from '../stores/canvasStore'

interface Props {
  sessionId: string
}

/**
 * Tool button next to Snap/Web — the Agent Canvas entry (spec D2: the old
 * per-session Draw button became the canvas; the classic Excalidraw
 * scratchpad lives on as the canvas's empty state, so pane visibility still
 * lives in excalidrawStore and nothing the Draw button did is lost).
 *
 * When the agent renders while the pane is closed — the hand-back moment —
 * the button pulses until the user opens it (canvasStore.unseenRender).
 */
export default function AgentCanvasButton({ sessionId }: Props) {
  const isOpen = useExcalidrawStore((s) => !!s.bySessionId[sessionId]?.isOpen)
  const togglePane = useExcalidrawStore((s) => s.togglePane)
  const unseen = useCanvasStore((s) => !!s.bySessionId[sessionId]?.unseenRender)

  const attention = unseen && !isOpen

  // OPEN state names the DESTINATION, not the current pane — the same rule the
  // Partner toggle already follows ("Partner" -> "Claude"). This pane REPLACES
  // the terminal, and a button still reading "Canvas" gave a new user nothing to
  // aim at: the only cue that it was a toggle was a faint tint on one button in
  // a row of five identical ones, and "Hide Agent Canvas" lived in a tooltip
  // they had to already suspect to hover. Accent-tinted while open so leaving
  // the terminal is visible without hovering anything.
  return (
    <button
      onClick={() => togglePane(sessionId)}
      className={`relative flex items-center gap-1.5 px-2 py-0.5 text-xs rounded border whitespace-nowrap shrink-0 transition-colors ${
        isOpen
          ? 'bg-mauve/20 border-mauve/70 text-mauve hover:bg-mauve/30'
          : attention
            ? 'bg-mauve/10 border-mauve/60 text-mauve hover:bg-mauve/20'
            : 'bg-surface0/60 border-surface1/80 hover:bg-surface1 text-overlay1 hover:text-text'
      }`}
      title={attention ? 'The agent rendered something new — open the Agent Canvas' : isOpen ? 'Back to the terminal (closes the Agent Canvas)' : 'Open Agent Canvas'}
    >
      {isOpen ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5M11 18l-6-6 6-6" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          {/* Framed-canvas + pen glyph */}
          <rect x="1.5" y="2.5" width="13" height="9" rx="1" />
          <path d="M10.8 5.2l1.6 1.6-3.4 3.4H7.4V8.6z" />
          <path d="M5 14h6" />
        </svg>
      )}
      {isOpen ? 'Terminal' : 'Canvas'}
      {attention && (
        <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5" data-testid="canvas-attention-dot">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-mauve opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-mauve" />
        </span>
      )}
    </button>
  )
}
