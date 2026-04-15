import React, { useEffect, useState } from 'react'
import TerminalView from '../TerminalView'

interface Props {
  parentSessionId: string
  sideChatSessionId: string
  parentLabel: string
  onClose: () => void
}

export default function SideChatPane({ parentSessionId: _parentSessionId, sideChatSessionId, parentLabel, onClose }: Props) {
  const [isVisible, setIsVisible] = useState(false)
  const [isClosing, setIsClosing] = useState(false)

  // Trigger slide-in animation on mount
  useEffect(() => {
    const timer = requestAnimationFrame(() => setIsVisible(true))
    return () => cancelAnimationFrame(timer)
  }, [])

  // Close with animation
  const handleClose = () => {
    setIsClosing(true)
    setTimeout(() => onClose(), 200) // Match animation duration
  }

  // Escape key closes
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        handleClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  const slideClass = isVisible && !isClosing ? 'translate-x-0' : 'translate-x-full'

  return (
    <div className="absolute inset-0 z-40 flex">
      {/* Dimmed backdrop */}
      <div
        className="flex-1 transition-opacity duration-200"
        style={{ backgroundColor: isVisible && !isClosing ? 'rgba(0,0,0,0.5)' : 'transparent' }}
        onClick={handleClose}
      />

      {/* Side Chat Panel */}
      <div
        className={`w-[38%] min-w-[360px] max-w-[600px] flex flex-col bg-base border-l-2 border-mauve shadow-2xl transition-transform duration-200 ease-out ${slideClass}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 bg-mantle border-b border-surface0 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-mauve font-semibold text-xs">Side Chat</span>
            <span className="text-overlay0 text-xs truncate">
              branched from &quot;{parentLabel}&quot;
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-overlay0 text-xs">
              {navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'}+;
            </span>
            <button
              onClick={handleClose}
              className="text-overlay0 hover:text-red text-sm px-1 transition-colors"
              title="Close side chat"
            >
              {String.fromCodePoint(0x00d7)}
            </button>
          </div>
        </div>

        {/* Info bar */}
        <div className="px-3 py-1.5 bg-surface0 text-xs text-subtext0 border-b border-surface1 shrink-0 flex items-center gap-1.5">
          <span className="text-mauve">{String.fromCodePoint(0x24d8)}</span>
          Reading context from main session. Changes here won&apos;t affect the main thread.
        </div>

        {/* Terminal */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <TerminalView
            sessionId={sideChatSessionId}
            isActive={true}
            shellOnly={false}
          />
        </div>
      </div>
    </div>
  )
}
