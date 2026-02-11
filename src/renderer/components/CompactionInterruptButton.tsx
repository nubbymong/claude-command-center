import React, { useState, useRef, useEffect } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'

interface Props {
  sessionId: string
}

export default function CompactionInterruptButton({ sessionId }: Props) {
  const { settings, updateSettings } = useSettingsStore()
  const { getSession, updateSession } = useSessionStore()
  const session = getSession(sessionId)
  const enabled = session?.compactionInterrupt ?? false
  const threshold = settings.compactionInterruptThreshold

  const [showThresholdMenu, setShowThresholdMenu] = useState(false)
  const [editValue, setEditValue] = useState(String(threshold))
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!showThresholdMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        setShowThresholdMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showThresholdMenu])

  const toggle = () => {
    updateSession(sessionId, {
      compactionInterrupt: !enabled,
      compactionInterruptTriggered: false,
    })
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setEditValue(String(threshold))
    setShowThresholdMenu(true)
  }

  const applyThreshold = () => {
    const val = parseInt(editValue, 10)
    if (val >= 10 && val <= 99) {
      updateSettings({ compactionInterruptThreshold: val })
      // Reset triggered flag for all sessions when threshold changes
    }
    setShowThresholdMenu(false)
  }

  const triggered = session?.compactionInterruptTriggered ?? false

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={toggle}
        onContextMenu={handleContextMenu}
        className={`flex items-center gap-1.5 px-2 py-0.5 text-xs rounded border transition-colors whitespace-nowrap shrink-0 ${
          triggered
            ? 'bg-red/20 border-red/40 text-red'
            : enabled
              ? 'bg-yellow/20 border-yellow/40 text-yellow'
              : 'bg-surface0/60 border-surface1/80 text-overlay1 hover:bg-surface1 hover:text-text'
        }`}
        title={`Compaction Interrupt: ${enabled ? 'ON' : 'OFF'} (${threshold}%) — Right-click to change threshold`}
      >
        {/* Shield/interrupt icon */}
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 1L2 4v4c0 3.5 2.5 6.5 6 7.5 3.5-1 6-4 6-7.5V4L8 1z" />
          {enabled && <path d="M5.5 8h5" strokeWidth="2" />}
        </svg>
        CI{enabled ? ` ${threshold}%` : ''}
      </button>

      {showThresholdMenu && (
        <div
          ref={menuRef}
          className="absolute bottom-full left-0 mb-1 bg-surface0 border border-surface1 rounded-lg shadow-xl p-2 z-50 min-w-[180px]"
        >
          <div className="text-xs text-overlay1 mb-1.5">Context % threshold to interrupt</div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={10}
              max={99}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyThreshold() }}
              className="w-16 bg-base border border-surface1 rounded px-2 py-0.5 text-xs text-text outline-none focus:border-blue"
              autoFocus
            />
            <span className="text-xs text-overlay0">%</span>
            <button
              onClick={applyThreshold}
              className="px-2 py-0.5 text-xs bg-blue/20 border border-blue/40 text-blue rounded hover:bg-blue/30"
            >
              Set
            </button>
          </div>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {[60, 70, 80, 90].map(pct => (
              <button
                key={pct}
                onClick={() => { updateSettings({ compactionInterruptThreshold: pct }); setShowThresholdMenu(false) }}
                className={`px-1.5 py-0.5 text-xs rounded border ${
                  threshold === pct
                    ? 'bg-blue/20 border-blue/40 text-blue'
                    : 'bg-surface0/60 border-surface1/80 text-overlay0 hover:text-text'
                }`}
              >
                {pct}%
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
