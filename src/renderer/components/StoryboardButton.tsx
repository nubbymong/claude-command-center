import React, { useState, useRef, useEffect, useCallback } from 'react'
import StoryboardModal from './StoryboardModal'

interface Props {
  sessionId: string
  sessionType: 'local' | 'ssh'
}

const INTERVAL_OPTIONS = [
  { label: '1s', ms: 1000 },
  { label: '2s', ms: 2000 },
  { label: '3s', ms: 3000 },
  { label: '5s', ms: 5000 },
]

export default function StoryboardButton({ sessionId, sessionType }: Props) {
  const [recording, setRecording] = useState(false)
  const [frameCount, setFrameCount] = useState(0)
  const [showDropdown, setShowDropdown] = useState(false)
  const [dropdownPos, setDropdownPos] = useState<{ left: number; bottom: number } | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [capturedFrames, setCapturedFrames] = useState<string[]>([])

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDropdown) return
    const handleClick = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showDropdown])

  // Cleanup interval on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [])

  const toggleDropdown = () => {
    if (!showDropdown && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setDropdownPos({ left: rect.left, bottom: window.innerHeight - rect.top + 4 })
    }
    setShowDropdown(!showDropdown)
  }

  const handleStart = async (intervalMs: number) => {
    setShowDropdown(false)

    // Show region selection overlay
    const region = await window.electronAPI.storyboard.start()
    if (!region) return // User cancelled

    setRecording(true)
    setFrameCount(0)

    // Capture first frame immediately
    const firstFrame = await window.electronAPI.storyboard.captureFrame()
    if (firstFrame) setFrameCount(1)

    // Start interval for subsequent frames
    intervalRef.current = setInterval(async () => {
      const path = await window.electronAPI.storyboard.captureFrame()
      if (path) {
        setFrameCount((prev) => prev + 1)
      }
    }, intervalMs)
  }

  const handleStop = useCallback(async () => {
    // Stop the renderer interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }

    // Stop the backend and get frame paths
    const frames = await window.electronAPI.storyboard.stop()
    setRecording(false)
    setFrameCount(0)

    if (frames.length > 0) {
      setCapturedFrames(frames)
      setShowModal(true)
    }
  }, [])

  const handleSend = useCallback((lines: string[]) => {
    setShowModal(false)
    setCapturedFrames([])

    // Send lines to PTY with delays for chunked writing
    let idx = 0
    const sendNext = () => {
      if (idx >= lines.length) {
        // Final newline to submit
        window.electronAPI.pty.write(sessionId, '\r')
        return
      }
      const line = lines[idx]
      idx++
      window.electronAPI.pty.write(sessionId, line + '\n')
      setTimeout(sendNext, 100)
    }
    sendNext()
  }, [sessionId])

  const handleModalCancel = useCallback(() => {
    setShowModal(false)
    setCapturedFrames([])
  }, [])

  return (
    <>
      <div className="relative">
        {recording ? (
          <button
            ref={buttonRef}
            onClick={handleStop}
            className="flex items-center gap-1.5 px-2 py-0.5 text-xs rounded border border-red/40 bg-red/15 text-red hover:bg-red/25 transition-colors whitespace-nowrap shrink-0"
            title="Stop storyboard recording"
          >
            {/* Recording dot */}
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red"></span>
            </span>
            Stop ({frameCount})
          </button>
        ) : (
          <button
            ref={buttonRef}
            onClick={toggleDropdown}
            className="flex items-center gap-1.5 px-2 py-0.5 text-xs rounded bg-surface0/60 border border-surface1/80 hover:bg-surface1 text-overlay1 hover:text-text transition-colors whitespace-nowrap shrink-0"
            title="Capture storyboard (periodic screenshots)"
          >
            {/* Film strip icon */}
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="3" width="4" height="10" rx="0.5" />
              <rect x="6" y="3" width="4" height="10" rx="0.5" />
              <rect x="11" y="3" width="4" height="10" rx="0.5" />
            </svg>
            Storyboard
          </button>
        )}

        {/* Interval selection dropdown */}
        {showDropdown && dropdownPos && (
          <div
            ref={dropdownRef}
            className="fixed bg-mantle border border-surface0 rounded shadow-lg py-1 min-w-[140px] z-50"
            style={{ left: dropdownPos.left, bottom: dropdownPos.bottom }}
          >
            <div className="px-3 py-1 text-[10px] text-overlay0 uppercase tracking-wide">
              Capture interval
            </div>
            {INTERVAL_OPTIONS.map((opt) => (
              <button
                key={opt.ms}
                onClick={() => handleStart(opt.ms)}
                className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface0 flex items-center gap-2"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-overlay1 shrink-0">
                  <circle cx="8" cy="8" r="6" />
                  <line x1="8" y1="4" x2="8" y2="8" />
                  <line x1="8" y1="8" x2="11" y2="10" />
                </svg>
                Every {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Storyboard review modal */}
      {showModal && capturedFrames.length > 0 && (
        <StoryboardModal
          frames={capturedFrames}
          sessionId={sessionId}
          sessionType={sessionType}
          onSend={handleSend}
          onCancel={handleModalCancel}
        />
      )}
    </>
  )
}
