import React, { useState, useRef, useEffect } from 'react'
import { useMagicButtonStore } from '../stores/magicButtonStore'
import MagicButtonSettingsDialog from './MagicButtonSettingsDialog'
import WindowPickerModal from './WindowPickerModal'
import { sendImageToSession } from '../utils/imageTransfer'

interface Props {
  sessionId: string
  // sessionType is no longer needed for image transport — both local and SSH
  // sessions use the conductor-vision MCP server's fetch_host_screenshot tool.
  sessionType: 'local' | 'ssh'
}

export default function ScreenshotButton({ sessionId, sessionType }: Props) {
  const color = useMagicButtonStore((s) => s.settings.screenshotColor)
  const [showDropdown, setShowDropdown] = useState(false)
  const [dropdownPos, setDropdownPos] = useState<{ left: number; bottom: number } | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showWindowPicker, setShowWindowPicker] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDropdown) return
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showDropdown])

  const toggleDropdown = () => {
    if (!showDropdown && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setDropdownPos({ left: rect.left, bottom: window.innerHeight - rect.top + 4 })
    }
    setShowDropdown(!showDropdown)
  }

  const handleRectangle = async () => {
    setShowDropdown(false)
    setCapturing(true)
    try {
      const path = await window.electronAPI.screenshot.captureRectangle()
      if (path) {
        sendImageToSession(sessionId, path, 'I just snapped a region of my screen — please view it.', sessionType)
      }
    } finally {
      setCapturing(false)
    }
  }

  const handleWindowCapture = async (sourceId: string) => {
    setShowWindowPicker(false)
    setCapturing(true)
    try {
      const path = await window.electronAPI.screenshot.captureWindow(sourceId)
      if (path) {
        sendImageToSession(sessionId, path, 'I just captured a window from my screen — please view it.', sessionType)
      }
    } finally {
      setCapturing(false)
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setShowDropdown(false)
    setShowSettings(true)
  }

  return (
    <>
      <div className="relative">
        <button
          ref={buttonRef}
          onClick={toggleDropdown}
          onContextMenu={handleContextMenu}
          disabled={capturing}
          className="flex items-center gap-1.5 px-2 py-0.5 text-xs rounded bg-surface0/60 border border-surface1/80 hover:bg-surface1 text-overlay1 hover:text-text transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          title="Take Screenshot (right-click for settings)"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="5" height="5" rx="0.5" />
            <rect x="9" y="2" width="5" height="5" rx="0.5" />
            <rect x="2" y="9" width="5" height="5" rx="0.5" />
            <rect x="9" y="9" width="5" height="5" rx="0.5" />
          </svg>
          {capturing ? '...' : 'Snap'}
        </button>

        {showDropdown && dropdownPos && (
          <div
            ref={dropdownRef}
            className="fixed bg-mantle border border-surface0 rounded shadow-lg py-1 min-w-[160px] z-50"
            style={{ left: dropdownPos.left, bottom: dropdownPos.bottom }}
          >
            <button
              onClick={handleRectangle}
              className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface0 flex items-center gap-2"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-overlay1 shrink-0">
                <rect x="2" y="2" width="12" height="12" rx="1" strokeDasharray="3 2" />
              </svg>
              Rectangle
            </button>
            <button
              onClick={() => { setShowDropdown(false); setShowWindowPicker(true) }}
              className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface0 flex items-center gap-2"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-overlay1 shrink-0">
                <rect x="1" y="3" width="14" height="10" rx="1.5" />
                <line x1="1" y1="6" x2="15" y2="6" />
              </svg>
              Window
            </button>
          </div>
        )}
      </div>

      {showWindowPicker && (
        <WindowPickerModal
          onCapture={handleWindowCapture}
          onCancel={() => setShowWindowPicker(false)}
        />
      )}

      {showSettings && (
        <MagicButtonSettingsDialog onClose={() => setShowSettings(false)} />
      )}
    </>
  )
}
