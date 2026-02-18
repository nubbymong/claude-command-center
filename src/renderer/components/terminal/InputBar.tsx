import React, { useRef, useEffect } from 'react'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { getScreenshotPathForSession } from '../../utils/screenshotPath'
import ScreenshotContextMenu from '../ScreenshotContextMenu'

interface InputBarProps {
  sessionId: string
  sessionType: 'ssh' | 'local'
  needsAttention: boolean
  claudeWaiting: boolean
  inputBarHeight: number
  terminalRef: React.RefObject<Terminal | null>
  isScrolledUpRef: React.MutableRefObject<boolean>
  setIsScrolledUp: (v: boolean) => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  inputValue: string
  setInputValue: (v: string) => void
}

// Forward ref not needed — parent passes inputRef directly
export default function InputBar({
  sessionId, sessionType, needsAttention, claudeWaiting, inputBarHeight,
  terminalRef, isScrolledUpRef, setIsScrolledUp,
  inputRef, inputValue, setInputValue
}: InputBarProps) {
  const updateSession = useSessionStore((s) => s.updateSession)
  const maxInputHeight = useSettingsStore((s) => s.settings.inputBarMaxHeight) || 400
  const [contextMenu, setContextMenu] = React.useState<{ x: number; y: number } | null>(null)
  const lastImagePasteRef = useRef<number>(0)
  const isResizingRef = useRef(false)
  const resizeStartYRef = useRef(0)
  const resizeStartHeightRef = useRef(0)

  // Apply stored height when session becomes active
  useEffect(() => {
    if (inputRef.current && inputBarHeight > 0) {
      inputRef.current.style.height = inputBarHeight + 'px'
    }
  }, [sessionId])

  const autoResizeInput = (el: HTMLTextAreaElement) => {
    if (inputBarHeight > 0) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, maxInputHeight) + 'px'
  }

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    isResizingRef.current = true
    resizeStartYRef.current = e.clientY
    resizeStartHeightRef.current = inputBarHeight || (inputRef.current?.offsetHeight ?? 24)

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return
      const delta = resizeStartYRef.current - ev.clientY
      const newHeight = Math.max(24, Math.min(400, resizeStartHeightRef.current + delta))
      updateSession(sessionId, { inputBarHeight: newHeight })
      if (inputRef.current) {
        inputRef.current.style.height = newHeight + 'px'
      }
    }

    const onMouseUp = () => {
      isResizingRef.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const now = Date.now()
        if (now - lastImagePasteRef.current < 3000) return
        lastImagePasteRef.current = now
        const imagePath = await window.electronAPI.clipboard.saveImage()
        if (imagePath) {
          const sessionPath = getScreenshotPathForSession(imagePath, sessionType)
          window.electronAPI.pty.write(sessionId, sessionPath + '\r')
        }
        return
      }
    }
  }

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const val = inputValue.trim()

      // When Claude is waiting for input, block multi-char sends (text stays in InputBar)
      if (claudeWaiting && val.length > 1) {
        return
      }

      if (val.length === 1 && /^[0-9a-zA-Z]$/.test(val)) {
        window.electronAPI.pty.write(sessionId, val + '\r')
      } else {
        window.electronAPI.pty.write(sessionId, inputValue + '\r')
      }
      // Clear claudeWaiting after user responds
      if (claudeWaiting) {
        updateSession(sessionId, { claudeWaiting: false })
      }
      setInputValue('')
      if (inputRef.current) {
        if (inputBarHeight > 0) {
          inputRef.current.style.height = inputBarHeight + 'px'
        } else {
          inputRef.current.style.height = 'auto'
        }
      }
      terminalRef.current?.scrollToBottom()
      isScrolledUpRef.current = false
      setIsScrolledUp(false)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      window.electronAPI.pty.write(sessionId, '\x1b')
    } else if (e.key === 'ArrowUp' && !inputValue.includes('\n')) {
      e.preventDefault()
      window.electronAPI.pty.write(sessionId, '\x1b[A')
    } else if (e.key === 'ArrowDown' && !inputValue.includes('\n')) {
      e.preventDefault()
      window.electronAPI.pty.write(sessionId, '\x1b[B')
    } else if (e.key === 'Tab') {
      e.preventDefault()
      window.electronAPI.pty.write(sessionId, inputValue + '\t')
      setInputValue('')
      if (inputRef.current) inputRef.current.style.height = 'auto'
    } else if (e.ctrlKey && e.key === 'c') {
      const textarea = e.currentTarget
      if (textarea.selectionStart !== textarea.selectionEnd) {
        return
      }
      e.preventDefault()
      window.electronAPI.pty.write(sessionId, '\x03')
      setInputValue('')
      if (inputRef.current) inputRef.current.style.height = 'auto'
      terminalRef.current?.scrollToBottom()
      isScrolledUpRef.current = false
      setIsScrolledUp(false)
    } else if (e.ctrlKey && e.key === 'd') {
      e.preventDefault()
      window.electronAPI.pty.write(sessionId, '\x04')
    } else if (e.ctrlKey && e.key === 'l') {
      e.preventDefault()
      window.electronAPI.pty.write(sessionId, '\x0c')
    } else if (e.altKey && e.key === 'v') {
      e.preventDefault()
      const now = Date.now()
      if (now - lastImagePasteRef.current < 3000) return
      lastImagePasteRef.current = now
      window.electronAPI.pty.write(sessionId, '\x1bv')
    }
  }

  return (
    <>
      {/* Drag handle for resizing input bar */}
      <div
        onMouseDown={handleResizeStart}
        onDoubleClick={() => {
          updateSession(sessionId, { inputBarHeight: 0 })
          if (inputRef.current) {
            inputRef.current.style.height = 'auto'
            autoResizeInput(inputRef.current)
          }
        }}
        className="h-1 bg-surface0 border-t border-surface1 cursor-ns-resize hover:bg-surface1 transition-colors shrink-0"
        title="Drag to resize input bar (double-click to reset)"
      />
      <div className="flex items-start gap-2 px-2 py-1.5 bg-surface0 shrink-0">
        <span className="text-xs text-overlay0 font-mono mt-0.5">$</span>
        <textarea
          ref={inputRef}
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value)
            autoResizeInput(e.target)
          }}
          onKeyDown={handleInputKeyDown}
          onPaste={handlePaste}
          onContextMenu={(e) => {
            e.preventDefault()
            setContextMenu({ x: e.clientX, y: e.clientY })
          }}
          rows={1}
          className={`flex-1 text-text text-sm outline-none font-mono resize-none overflow-y-auto border rounded transition-colors ${claudeWaiting ? 'border-red/50 bg-red/10' : needsAttention ? 'border-blue/50 bg-transparent' : 'border-transparent bg-transparent'}`}
          style={{ maxHeight: maxInputHeight + 'px', ...(inputBarHeight > 0 ? { height: inputBarHeight + 'px' } : {}) }}
          placeholder={claudeWaiting
            ? "Claude is waiting \u2014 type y/n/1-9 here, or click terminal for longer responses"
            : needsAttention
            ? "Claude is waiting for input \u2014 type 1-9/y/n here, or click terminal for other responses"
            : "Type here, Enter to send, Shift+Enter for newline | Right-click for screenshots"
          }
          autoFocus
        />
      </div>
      {contextMenu && (
        <ScreenshotContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          sessionId={sessionId}
          sessionType={sessionType}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  )
}
