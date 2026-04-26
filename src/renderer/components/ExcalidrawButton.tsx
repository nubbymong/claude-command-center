import React, { useState, lazy, Suspense } from 'react'

// Lazy-load Excalidraw — its bundle is heavy (~1.5 MB) and isn't needed
// until the user actually opens the scratchpad.
const ExcalidrawModal = lazy(() => import('./ExcalidrawModal'))

export default function ExcalidrawButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-2 py-0.5 text-xs rounded bg-surface0/60 border border-surface1/80 hover:bg-surface1 text-overlay1 hover:text-text transition-colors whitespace-nowrap shrink-0"
        title="Open Excalidraw scratchpad"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          {/* Pencil / sketch glyph */}
          <path d="M11.5 2.5l2 2-7 7H4.5v-2z" />
          <path d="M2 14h12" />
        </svg>
        Draw
      </button>
      {open && (
        <Suspense fallback={null}>
          <ExcalidrawModal onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  )
}
