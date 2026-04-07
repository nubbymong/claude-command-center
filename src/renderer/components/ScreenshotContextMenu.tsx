import React, { useState, useEffect, useRef } from 'react'
import { formatTimestamp } from '../utils/screenshotPath'
import { sendStoryboardToSession } from '../utils/imageTransfer'

interface ScreenshotEntry {
  filename: string
  path: string
  timestamp: number
  thumbnail: string
}

interface Props {
  x: number
  y: number
  sessionId: string
  sessionType: 'local' | 'ssh'
  onClose: () => void
}

export default function ScreenshotContextMenu({ x, y, sessionId, sessionType: _sessionType, onClose }: Props) {
  const [screenshots, setScreenshots] = useState<ScreenshotEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.electronAPI.screenshot.listRecent().then((list) => {
      setScreenshots(list)
      setLoading(false)
    })
  }, [])

  // Position menu above the click point (since input is at bottom)
  // Also clamp to viewport
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    zIndex: 60,
  }

  // We'll calculate position after render using a ref
  const [positioned, setPositioned] = useState(false)
  useEffect(() => {
    if (!menuRef.current || loading) return
    const rect = menuRef.current.getBoundingClientRect()
    const viewportH = window.innerHeight
    const viewportW = window.innerWidth

    // Position above the click point
    let top = y - rect.height - 8
    let left = x

    // Clamp to viewport
    if (top < 4) top = 4
    if (left + rect.width > viewportW - 4) left = viewportW - rect.width - 4
    if (left < 4) left = 4

    menuRef.current.style.top = `${top}px`
    menuRef.current.style.left = `${left}px`
    setPositioned(true)
  }, [loading, screenshots.length])

  const toggleSelect = (filename: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(filename)) next.delete(filename)
      else next.add(filename)
      return next
    })
  }

  const handleInsert = () => {
    const paths = screenshots
      .filter((s) => selected.has(s.filename))
      .map((s) => s.path)

    if (paths.length > 0) {
      // Both local and SSH sessions use the conductor MCP fetch_host_screenshot
      // tool — Claude calls it once per filename to load each image inline.
      sendStoryboardToSession(sessionId, paths, 'Please look at the following screenshots from my host machine.')
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        ref={menuRef}
        className="bg-mantle border border-surface0 rounded-lg shadow-xl w-[360px] max-h-[400px] flex flex-col"
        style={{ ...menuStyle, opacity: positioned ? 1 : 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-surface0">
          <span className="text-xs text-overlay0 font-medium">Screenshots</span>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="text-center text-overlay1 py-4 text-xs">Loading...</div>
          ) : screenshots.length === 0 ? (
            <div className="text-center text-overlay1 py-4 text-xs">No screenshots yet</div>
          ) : (
            <div className="space-y-1">
              {screenshots.map((ss) => (
                <label
                  key={ss.filename}
                  className={`flex items-center gap-2 p-1.5 rounded cursor-pointer transition-colors ${
                    selected.has(ss.filename) ? 'bg-surface0' : 'hover:bg-surface0/50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(ss.filename)}
                    onChange={() => toggleSelect(ss.filename)}
                    className="rounded border-surface1 shrink-0"
                  />
                  {ss.thumbnail && (
                    <img
                      src={`data:image/png;base64,${ss.thumbnail}`}
                      alt={ss.filename}
                      className="w-[120px] h-[90px] object-contain rounded bg-crust shrink-0"
                    />
                  )}
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-xs text-text truncate">{ss.filename}</span>
                    <span className="text-xs text-overlay0">{formatTimestamp(ss.timestamp)}</span>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {screenshots.length > 0 && (
          <div className="px-3 py-2 border-t border-surface0">
            <button
              onClick={handleInsert}
              disabled={selected.size === 0}
              className="w-full px-3 py-1.5 text-xs bg-blue text-crust rounded hover:bg-blue/80 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Insert Selected ({selected.size})
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
