import React, { useEffect, useState } from 'react'

interface Props {
  sidebarOpen: boolean
  onToggleSidebar: () => void
}

export default function TitleBar({ sidebarOpen, onToggleSidebar }: Props) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    window.electronAPI.window.isMaximized().then(setMaximized)
    const unsub = window.electronAPI.window.onMaximizedChanged(setMaximized)
    return unsub
  }, [])

  return (
    <div className="titlebar-drag flex items-center h-10 bg-crust px-3 shrink-0">
      <div className="titlebar-no-drag flex items-center gap-1 mr-3">
        <button
          onClick={onToggleSidebar}
          className="p-1.5 rounded hover:bg-surface0 text-overlay1 hover:text-text transition-colors"
          title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="2" width="14" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <line x1="5.5" y1="2" x2="5.5" y2="14" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>

      <div className="flex-1 text-center text-xs text-overlay1 font-medium">
        Claude Conductor <span className="text-yellow/70">Beta</span>
      </div>

      <div className="titlebar-no-drag flex items-center">
        <button
          onClick={() => window.electronAPI.window.minimize()}
          className="p-2 hover:bg-surface0 rounded transition-colors text-overlay1 hover:text-text"
        >
          <svg width="12" height="12" viewBox="0 0 12 12"><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
        <button
          onClick={() => window.electronAPI.window.maximize()}
          className="p-2 hover:bg-surface0 rounded transition-colors text-overlay1 hover:text-text"
        >
          {maximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="3.5" width="7" height="7" rx="0.5" stroke="currentColor" strokeWidth="1.2" fill="none"/><path d="M3.5 3.5V2.5C3.5 2.22 3.72 2 4 2H9.5C9.78 2 10 2.22 10 2.5V8C10 8.28 9.78 8.5 9.5 8.5H9" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="0.5" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>
          )}
        </button>
        <button
          onClick={() => window.electronAPI.window.close()}
          className="p-2 hover:bg-red rounded transition-colors text-overlay1 hover:text-white"
        >
          <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
      </div>
    </div>
  )
}
