import React, { useState, useEffect, useRef } from 'react'
import { formatTimestamp } from '../utils/screenshotPath'
import { sendStoryboardToSession } from '../utils/imageTransfer'
import { DialogButton } from './ui/Dialog'
import { isContextMenuGesture } from '../lib/pointer'

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
    // mousedown (not click) so the dismiss cannot be triggered by a synthetic
    // click event -- Ctrl+C in a terminal fires one, and a click-dismissed
    // backdrop ate this menu. A context-menu gesture dismisses inertly instead
    // of falling through to the terminal underneath (see lib/pointer.ts).
    <div
      className="fixed inset-0 z-50"
      onMouseDown={(e) => {
        if (isContextMenuGesture(e)) return
        onClose()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
    >
      <div
        ref={menuRef}
        className="rounded-lg shadow-xl w-[360px] max-h-[400px] flex flex-col"
        style={{ ...menuStyle, opacity: positioned ? 1 : 0, background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
        onMouseDown={(e) => e.stopPropagation()}
        // Right-clicking a thumbnail inside the menu must not reach the
        // backdrop's contextmenu dismiss and close the menu under the pointer.
        onContextMenu={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Screenshots</span>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="text-center py-4 text-xs" style={{ color: 'var(--text-muted)' }}>Loading...</div>
          ) : screenshots.length === 0 ? (
            <div className="text-center py-4 text-xs" style={{ color: 'var(--text-muted)' }}>No screenshots yet</div>
          ) : (
            <div className="space-y-1">
              {screenshots.map((ss) => (
                <label
                  key={ss.filename}
                  className={`flex items-center gap-2 p-1.5 rounded cursor-pointer transition-colors ${
                    selected.has(ss.filename) ? 'bg-[var(--surface-overlay)]' : 'hover:bg-[color-mix(in_srgb,var(--surface-overlay)_50%,transparent)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(ss.filename)}
                    onChange={() => toggleSelect(ss.filename)}
                    className="rounded border-[var(--border-subtle)] shrink-0"
                  />
                  {ss.thumbnail && (
                    <img
                      src={`data:image/png;base64,${ss.thumbnail}`}
                      alt={ss.filename}
                      className="w-[120px] h-[90px] object-contain rounded shrink-0"
                      style={{ background: 'var(--surface-sunken)' }}
                    />
                  )}
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-xs truncate" style={{ color: 'var(--text-primary)' }}>{ss.filename}</span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{formatTimestamp(ss.timestamp)}</span>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {screenshots.length > 0 && (
          <div className="px-3 py-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <DialogButton
              variant="primary"
              block
              onClick={handleInsert}
              disabled={selected.size === 0}
            >
              Insert Selected ({selected.size})
            </DialogButton>
          </div>
        )}
      </div>
    </div>
  )
}
