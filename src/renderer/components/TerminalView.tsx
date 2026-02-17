import React, { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { hasSpawned, markSpawned, killSessionPty } from '../ptyTracker'
import CommandBar from './CommandBar'
import ScreenshotContextMenu from './ScreenshotContextMenu'
import { shouldUseResumePicker } from '../App'
import { getScreenshotPathForSession } from '../utils/screenshotPath'

// Re-export for consumers
export { killSessionPty } from '../ptyTracker'

interface Props {
  sessionId: string
  configId?: string
  cwd?: string
  shellOnly?: boolean
  elevated?: boolean
  ssh?: {
    host: string
    port: number
    username: string
    remotePath: string
    password?: string
    postCommand?: string
    sudoPassword?: string
    startClaudeAfter?: boolean
    dockerContainer?: string
  }
  isActive?: boolean
  partnerEnabled?: boolean
  isPartnerActive?: boolean
  onTogglePartner?: () => void
  partnerSessionId?: string
  visionConfig?: {
    enabled: boolean
    browser: 'chrome' | 'edge'
    debugPort: number
  }
}

// Platform v9 dark theme
const THEME = {
  background: '#0f1218',
  foreground: '#f0f4fc',
  cursor: '#f0f4fc',  // Make cursor same as foreground (bar cursor, subtle)
  cursorAccent: '#0f1218',
  selectionBackground: '#1e2530',
  selectionForeground: '#f0f4fc',
  black: '#1e2530',
  red: '#F38BA8',
  green: '#A6E3A1',
  yellow: '#F9E2AF',
  blue: '#89B4FA',
  magenta: '#CBA6F7',
  cyan: '#94E2D5',
  white: '#b8c5d6',
  brightBlack: '#2a3342',
  brightRed: '#F38BA8',
  brightGreen: '#A6E3A1',
  brightYellow: '#F9E2AF',
  brightBlue: '#89B4FA',
  brightMagenta: '#CBA6F7',
  brightCyan: '#94E2D5',
  brightWhite: '#94a3b8',
}

// Inject CSS to hide xterm's cursor layer completely (we use input bar for typing)
const GLOBAL_STYLES_ID = 'claude-multi-terminal-styles'
function injectGlobalStyles() {
  if (document.getElementById(GLOBAL_STYLES_ID)) return
  const style = document.createElement('style')
  style.id = GLOBAL_STYLES_ID
  style.textContent = `
    .xterm-cursor-layer {
      display: none !important;
    }
  `
  document.head.appendChild(style)
}
injectGlobalStyles()

/**
 * Strip cursor-related escape sequences from terminal data.
 * This removes the yellow block cursor that Claude's TUI renders.
 *
 * Two layers of defense:
 * 1. Remove cursor control sequences (show/hide/blink/style)
 * 2. Replace yellow background colors with default background.
 *    Claude's TUI paints a yellow block cursor using yellow bg (SGR 43/103)
 *    or 256-color/truecolor yellow bg sequences. We replace them with
 *    default bg (SGR 49) so the cursor block becomes invisible.
 */
function stripCursorSequences(data: string): string {
  return data
    .replace(/\x1b\[\?25h/g, '')        // strip cursor SHOW only (keep hide sequences)
    .replace(/\x1b\[\?12[hl]/g, '')     // blink on/off
    .replace(/\x1b\[\d+ q/g, '')        // cursor style
    // Strip reverse video (SGR 7) from ANY SGR sequence — Claude's TUI uses it for block cursor.
    // Handles standalone \x1b[7m and combined like \x1b[7;33m, \x1b[1;7m, \x1b[7;38;2;...m
    .replace(/\x1b\[([0-9;]*)m/g, (_match, params: string) => {
      if (!params) return _match
      const parts = params.split(';')
      const filtered = parts.filter(p => p !== '7' && p !== '27')
      if (filtered.length === parts.length) return _match  // no reverse video, keep as-is
      if (filtered.length === 0) return ''  // was only reverse video
      return '\x1b[' + filtered.join(';') + 'm'
    })
    // Yellow/bright-yellow background → default background
    .replace(/\x1b\[(?:43|103)m/g, '\x1b[49m')
    // 256-color yellow/orange backgrounds
    .replace(/\x1b\[48;5;(?:3|11|178|179|180|184|185|186|187|190|191|192|208|214|220|221|226|227|228|229)m/g, '\x1b[49m')
    // Truecolor yellow/orange/amber backgrounds (R>150, G>100, B<100)
    .replace(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g, (_match, r, g, b) => {
      const ri = parseInt(r), gi = parseInt(g), bi = parseInt(b)
      if (ri > 150 && gi > 100 && bi < 100) return '\x1b[49m'
      return _match
    })
}


function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'm'
  if (n >= 1000) return Math.round(n / 1000) + 'k'
  return n.toString()
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function formatResetTime(iso: string): string {
  try {
    const d = new Date(iso)
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()
    if (isToday) {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  } catch { return '' }
}

function RateLimitBar({ label, pct, resets }: { label: string; pct: number; resets?: string }) {
  const barWidth = 10
  const filled = Math.round(pct * barWidth / 100)
  const color = pct >= 90 ? '#F38BA8' : pct >= 70 ? '#F9E2AF' : pct >= 50 ? '#FAB387' : '#A6E3A1'
  return (
    <span className="flex items-center gap-1" title={resets ? `Resets: ${formatResetTime(resets)}` : undefined}>
      <span className="text-subtext0">{label}:</span>
      <span style={{ letterSpacing: '-1px' }}>
        {Array.from({ length: barWidth }, (_, i) => (
          <span key={i} style={{ color: i < filled ? color : '#2a3342', fontSize: '9px' }}>{String.fromCodePoint(0x25CF)}</span>
        ))}
      </span>
      <span className="text-subtext0">{pct}%</span>
    </span>
  )
}

export default function TerminalView({ sessionId, configId, cwd, shellOnly, elevated, ssh, isActive = true, partnerEnabled, isPartnerActive, onTogglePartner, partnerSessionId, visionConfig }: Props) {
  const xtermContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const attentionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attentionAckedRef = useRef(false)
  const [inputValue, setInputValue] = useState('')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [isScrolledUp, setIsScrolledUp] = useState(false)
  const isScrolledUpRef = useRef(false)
  const updateSession = useSessionStore((s) => s.updateSession)
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId))

  useEffect(() => {
    const container = xtermContainerRef.current
    if (!container) return

    let term: Terminal | null = null
    let fitAddon: FitAddon | null = null
    let resizeObserver: ResizeObserver | null = null
    let unsubData: (() => void) | null = null
    let unsubExit: (() => void) | null = null
    let handleKeyDownCopy: ((e: KeyboardEvent) => void) | null = null
    let handleContextMenu: ((e: MouseEvent) => void) | null = null
    let disposed = false
    let scrollCheckInterval: ReturnType<typeof setInterval> | null = null
    let parseTimer: ReturnType<typeof setTimeout> | null = null
    let pendingParseData = ''
    let refreshTimer: ReturnType<typeof setTimeout> | null = null

    const initTerminal = () => {
      if (disposed) return

      const rect = container.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) {
        requestAnimationFrame(initTerminal)
        return
      }

      // For Claude terminals: make cursor completely invisible (background color)
      // For shell-only: keep cursor visible
      const termTheme = shellOnly
        ? THEME
        : { ...THEME, cursor: '#0f1218', cursorAccent: '#0f1218' }

      term = new Terminal({
        theme: termTheme,
        fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
        fontSize: 14,
        lineHeight: 1.2,
        cursorBlink: false,
        cursorStyle: 'bar',
        cursorWidth: 1,
        cursorInactiveStyle: 'none',
        scrollback: 100000,
        allowTransparency: true,
      })

      fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.loadAddon(new WebLinksAddon())

      term.open(container)

      // Only hide cursor for Claude terminals — shell-only terminals need visible cursor
      if (!shellOnly) {
        term.write('\x1b[?25l')
      }

      terminalRef.current = term
      fitAddonRef.current = fitAddon

      // Fit and spawn PTY (only if not already spawned)
      requestAnimationFrame(() => {
        if (disposed || !fitAddon || !term) return
        try { fitAddon.fit() } catch { /* ignore */ }

        if (!hasSpawned(sessionId)) {
          markSpawned(sessionId)
          const cols = term.cols
          const rows = term.rows
          const configLabel = session?.label || 'default'
          const useResumePicker = shouldUseResumePicker(sessionId)
          window.electronAPI.pty.spawn(sessionId, { cwd, cols, rows, ssh, shellOnly, elevated, configLabel, useResumePicker, visionConfig })
        }
      })

      // Forward xterm keyboard input to PTY
      term.onData((data) => {
        window.electronAPI.pty.write(sessionId, data)
      })

      // Click in terminal to focus it
      container.addEventListener('mouseup', () => {
        setTimeout(() => term?.focus(), 0)
      })

      // Accumulation buffer for context regex parsing (handles chunked terminal data)
      let contextBuffer = ''
      const CONTEXT_BUFFER_MAX = 2000

      // Debounced parsing of context/cost/attention from PTY output.
      // Runs at most every 250ms to avoid blocking during rapid output (e.g. menu navigation).
      function scheduleParse() {
        if (parseTimer) return
        parseTimer = setTimeout(() => {
          parseTimer = null
          const data = pendingParseData
          pendingParseData = ''
          if (!data) return

          const stripped = data
            .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')   // CSI sequences
            .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
            .replace(/\x1b[()][A-Z0-9]/g, '')         // Charset selection
            .replace(/\x1b[=>]/g, '')                  // Keypad modes

          // Accumulate stripped data for context parsing (handles chunked SSH data)
          contextBuffer += stripped
          if (contextBuffer.length > CONTEXT_BUFFER_MAX) {
            contextBuffer = contextBuffer.slice(-CONTEXT_BUFFER_MAX)
          }

          const contextMatch = contextBuffer.match(/(\d+(?:\.\d+)?)%\s*(?:context|of context|used|remaining|ctx)/i)
            || contextBuffer.match(/context[:\s]+(\d+(?:\.\d+)?)%/i)
            || contextBuffer.match(/(\d+(?:\.\d+)?)%\s*\|\s*\$/i)
          if (contextMatch) {
            const pct = parseFloat(contextMatch[1])
            const updates: Record<string, any> = {}
            if (pct >= 0 && pct <= 100) {
              updates.contextPercent = pct
            }

            const costMatch = contextBuffer.match(/\$(\d+(?:\.\d+)?)/)
            if (costMatch) {
              updates.costUsd = parseFloat(costMatch[1])
            }
            const rl5hMatch = contextBuffer.match(/5h[:\s]*(\d+)%/)
            if (rl5hMatch) {
              updates.rateLimitCurrent = parseInt(rl5hMatch[1])
            }
            const rl7dMatch = contextBuffer.match(/7d[:\s]*(\d+)%/)
            if (rl7dMatch) {
              updates.rateLimitWeekly = parseInt(rl7dMatch[1])
            }

            if (Object.keys(updates).length > 0) {
              updateSession(sessionId, updates)
            }
            contextBuffer = ''
          }

          // Attention detection: prompt patterns suggest waiting for input
          // Only reset ack when there's substantial visible text (not just control sequences)
          const visibleText = stripped.replace(/\s+/g, '')
          if (visibleText.length > 2) {
            attentionAckedRef.current = false
          }
          if (attentionTimerRef.current) clearTimeout(attentionTimerRef.current)
          const promptPattern = /[❯$#>]\s*$|\(y\/n\)\s*$|\?\s*$|Do you want|Yes\/No|Accept\?|approve/i
          if (promptPattern.test(stripped.trim()) && !attentionAckedRef.current) {
            attentionTimerRef.current = setTimeout(() => {
              attentionTimerRef.current = null
              const state = useSessionStore.getState()
              if (state.activeSessionId !== sessionId) {
                updateSession(sessionId, { needsAttention: true })
              }
            }, 2000)
          }
        }, 250)
      }

      // Receive PTY output — write to terminal immediately, defer parsing
      unsubData = window.electronAPI.pty.onData(sessionId, (data) => {
        // For Claude terminals: strip cursor sequences and append hide-cursor atomically
        // so xterm never renders a frame with cursor visible between two writes.
        // For shell-only: pass data through unmodified
        const filtered = shellOnly ? data : stripCursorSequences(data) + '\x1b[?25l'
        term?.write(filtered)

        // Force scroll to bottom if user hasn't manually scrolled up
        if (!isScrolledUpRef.current) {
          term?.scrollToBottom()
        } else if (term) {
          // Debounced refresh while scrolled up — fixes canvas renderer corruption
          // when new data is written below the visible viewport
          if (refreshTimer) clearTimeout(refreshTimer)
          refreshTimer = setTimeout(() => {
            refreshTimer = null
            try { term.refresh(0, term.rows - 1) } catch { /* ignore */ }
          }, 150)
        }

        // Queue data for debounced context/attention parsing
        pendingParseData += data
        scheduleParse()
      })

      unsubExit = window.electronAPI.pty.onExit(sessionId, (exitCode) => {
        term?.writeln(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m`)
      })

      // Handle resize
      resizeObserver = new ResizeObserver(() => {
        if (disposed || !fitAddon || !term) return
        try {
          fitAddon.fit()
          window.electronAPI.pty.resize(sessionId, term.cols, term.rows)
        } catch { /* ignore */ }
      })
      resizeObserver.observe(container)

      // Track scroll position to show/hide "scroll to bottom" button
      const updateScrollState = (scrolledUp: boolean) => {
        isScrolledUpRef.current = scrolledUp
        setIsScrolledUp(scrolledUp)
      }

      term.onScroll(() => {
        if (disposed || !term) return
        try {
          const buf = term.buffer.active
          const atBottom = buf.viewportY >= buf.baseY
          updateScrollState(!atBottom)
        } catch { /* terminal may be disposed */ }
      })

      // Periodic check to sync scroll state (onScroll doesn't fire for auto-scroll)
      const checkScrollAfterWrite = () => {
        if (disposed || !term) return
        try {
          const buf = term.buffer.active
          const atBottom = buf.viewportY >= buf.baseY
          if (atBottom) updateScrollState(false)
        } catch { /* terminal may be disposed */ }
      }
      // Use a periodic check since onScroll doesn't fire for auto-scroll
      scrollCheckInterval = setInterval(checkScrollAfterWrite, 500)

      // Ctrl+Shift+C to copy selected text
      handleKeyDownCopy = (e: KeyboardEvent) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'C') {
          e.preventDefault()
          const sel = term?.getSelection()
          if (sel) navigator.clipboard.writeText(sel)
        }
      }
      document.addEventListener('keydown', handleKeyDownCopy)

      // Right-click in terminal: copy selection if text selected, otherwise paste from clipboard
      handleContextMenu = (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        const sel = term?.getSelection()
        if (sel) {
          navigator.clipboard.writeText(sel)
        } else {
          // Paste clipboard text into input bar
          navigator.clipboard.readText().then((text) => {
            if (text && inputRef.current) {
              // Insert text at cursor position in input bar
              const input = inputRef.current
              const start = input.selectionStart ?? input.value.length
              const end = input.selectionEnd ?? input.value.length
              const newValue = input.value.slice(0, start) + text + input.value.slice(end)
              setInputValue(newValue)
              // Set cursor after pasted text
              requestAnimationFrame(() => {
                input.selectionStart = input.selectionEnd = start + text.length
                input.focus()
              })
            }
          })
        }
      }
      container.addEventListener('contextmenu', handleContextMenu, true)

      // Focus the input bar
      inputRef.current?.focus()
    }

    requestAnimationFrame(initTerminal)

    return () => {
      disposed = true
      if (attentionTimerRef.current) clearTimeout(attentionTimerRef.current)
      if (parseTimer) clearTimeout(parseTimer)
      if (refreshTimer) clearTimeout(refreshTimer)
      if (handleKeyDownCopy) document.removeEventListener('keydown', handleKeyDownCopy)
      if (handleContextMenu) container.removeEventListener('contextmenu', handleContextMenu, true)
      resizeObserver?.disconnect()
      if (scrollCheckInterval) clearInterval(scrollCheckInterval)
      unsubData?.()
      unsubExit?.()
      // DON'T kill PTY here - it survives HMR remounts.
      // PTY is killed via killSessionPty() when session is explicitly removed.
      term?.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId])

  // Clear attention and force terminal redraw when this tab becomes active
  useEffect(() => {
    if (isActive) {
      updateSession(sessionId, { needsAttention: false })
      // Mark attention as acknowledged — prevents re-triggering from buffered data
      attentionAckedRef.current = true
      if (attentionTimerRef.current) {
        clearTimeout(attentionTimerRef.current)
        attentionTimerRef.current = null
      }
      // Force full redraw — fixes canvas renderer corruption after data was written while hidden/scrolled
      const term = terminalRef.current
      if (term) {
        requestAnimationFrame(() => {
          try { term.refresh(0, term.rows - 1) } catch { /* ignore */ }
        })
      }
    }
  }, [isActive, sessionId])

  // Hide cursor layer — always hidden for Claude terminals, toggle for shell-only
  useEffect(() => {
    const container = xtermContainerRef.current
    if (!container) return
    const cursorLayer = container.querySelector('.xterm-cursor-layer') as HTMLElement
    if (cursorLayer) {
      cursorLayer.style.display = shellOnly && isActive ? '' : 'none'
    }
  }, [isActive, shellOnly])

  // Subscribe to statusline API updates (works for local sessions directly;
  // SSH sessions also subscribe in case remote statusline is configured)
  useEffect(() => {
    const unsub = window.electronAPI.statusline.onUpdate((data) => {
      if (data.sessionId !== sessionId) return
      const updates: Record<string, unknown> = {}
      if (data.contextUsedPercent != null) updates.contextPercent = data.contextUsedPercent
      if (data.costUsd != null) updates.costUsd = data.costUsd
      if (data.model) updates.modelName = data.model
      if (data.linesAdded != null) updates.linesAdded = data.linesAdded
      if (data.linesRemoved != null) updates.linesRemoved = data.linesRemoved
      if (data.contextWindowSize != null) updates.contextWindowSize = data.contextWindowSize
      if (data.inputTokens != null) updates.inputTokens = data.inputTokens
      if (data.outputTokens != null) updates.outputTokens = data.outputTokens
      if (data.totalDurationMs != null) updates.totalDurationMs = data.totalDurationMs
      if (data.rateLimitCurrent != null) updates.rateLimitCurrent = data.rateLimitCurrent
      if (data.rateLimitCurrentResets) updates.rateLimitCurrentResets = data.rateLimitCurrentResets
      if (data.rateLimitWeekly != null) updates.rateLimitWeekly = data.rateLimitWeekly
      if (data.rateLimitWeeklyResets) updates.rateLimitWeeklyResets = data.rateLimitWeeklyResets
      if (data.rateLimitExtra) updates.rateLimitExtra = data.rateLimitExtra
      if (Object.keys(updates).length > 0) {
        updateSession(sessionId, updates)
      }
    })
    return unsub
  }, [sessionId])

  // Compaction Interrupt: auto-Escape when context exceeds threshold
  const { settings: appSettings } = useSettingsStore()
  useEffect(() => {
    if (!session?.compactionInterrupt) return
    if (session.compactionInterruptTriggered) return
    if (session.contextPercent == null) return

    const threshold = appSettings.compactionInterruptThreshold
    if (session.contextPercent >= threshold) {
      // Send Escape to stop Claude
      window.electronAPI.pty.write(sessionId, '\x1b')
      updateSession(sessionId, { compactionInterruptTriggered: true })
      console.log(`[CI] Session ${sessionId}: context ${session.contextPercent}% >= ${threshold}%, sent Escape`)
    }
  }, [session?.contextPercent, session?.compactionInterrupt, session?.compactionInterruptTriggered, appSettings.compactionInterruptThreshold, sessionId])

  // Vision status subscription + cleanup.
  // Vision is started in pty:spawn (before PTY) so env vars are available.
  // This effect subscribes to status changes (heartbeat reconnect/disconnect) and cleans up on unmount.
  useEffect(() => {
    if (!visionConfig?.enabled) return

    const unsub = window.electronAPI.vision.onStatusChanged((data) => {
      if (data.sessionId !== sessionId) return
      updateSession(sessionId, { visionConnected: data.connected, visionPort: data.proxyPort })
    })

    return () => {
      unsub()
      window.electronAPI.vision.stop(sessionId)
      updateSession(sessionId, { visionConnected: undefined, visionPort: undefined })
    }
  }, [sessionId, visionConfig?.enabled])

  // Debounce image paste to prevent double-sends
  const lastImagePasteRef = useRef<number>(0)

  // Handle paste: intercept image pastes, save as resized JPEG, paste file path.
  // Text pastes proceed normally.
  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return

    // Check if clipboard contains an image
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        // Debounce: don't send another image within 3 seconds
        const now = Date.now()
        if (now - lastImagePasteRef.current < 3000) return
        lastImagePasteRef.current = now
        // Save clipboard image as resized JPEG and get the path
        const imagePath = await window.electronAPI.clipboard.saveImage()
        if (imagePath) {
          const sessionPath = getScreenshotPathForSession(imagePath, ssh ? 'ssh' : 'local')
          window.electronAPI.pty.write(sessionId, sessionPath + '\r')
        }
        return
      }
    }
    // Text paste — let default behavior handle it
  }

  // Resizable input bar — drag handle + per-session height memory
  const inputBarHeight = session?.inputBarHeight ?? 0  // 0 means auto (single line)
  const isResizingRef = useRef(false)
  const resizeStartYRef = useRef(0)
  const resizeStartHeightRef = useRef(0)

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    isResizingRef.current = true
    resizeStartYRef.current = e.clientY
    resizeStartHeightRef.current = inputBarHeight || (inputRef.current?.offsetHeight ?? 24)

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return
      const delta = resizeStartYRef.current - ev.clientY  // dragging up = bigger
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

  // Apply stored height when session becomes active
  useEffect(() => {
    if (inputRef.current && inputBarHeight > 0) {
      inputRef.current.style.height = inputBarHeight + 'px'
    }
  }, [sessionId])

  // Auto-resize textarea to fit content (only when no manual height set)
  const autoResizeInput = (el: HTMLTextAreaElement) => {
    if (inputBarHeight > 0) return  // Manual height set, don't auto-resize
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  const needsAttention = session?.needsAttention ?? false

  // Input bar key handler
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const val = inputValue.trim()

      // When Claude is asking a question (needsAttention), only allow single-char responses
      // like y/n or 1/2/3. Block multi-char text to prevent losing typed content.
      if (needsAttention && val.length > 1) {
        // Flash the input bar border to indicate blocked
        if (inputRef.current) {
          inputRef.current.style.borderColor = '#F38BA8'
          setTimeout(() => {
            if (inputRef.current) inputRef.current.style.borderColor = ''
          }, 1000)
        }
        return
      }

      // For single-char inputs (menu selections like 1,2,3 or y/n), send just the char
      // This prevents issues with Claude's interactive menus
      if (val.length === 1 && /^[0-9a-zA-Z]$/.test(val)) {
        window.electronAPI.pty.write(sessionId, val + '\r')
      } else {
        window.electronAPI.pty.write(sessionId, inputValue + '\r')
      }
      setInputValue('')
      // Reset textarea height after clearing (keep manual height if set)
      if (inputRef.current) {
        if (inputBarHeight > 0) {
          inputRef.current.style.height = inputBarHeight + 'px'
        } else {
          inputRef.current.style.height = 'auto'
        }
      }
      // Always scroll terminal to bottom when sending input
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
      // If text is selected in the input bar, copy it instead of sending SIGINT
      const textarea = e.currentTarget
      if (textarea.selectionStart !== textarea.selectionEnd) {
        // Let the browser handle the native copy
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
      // Forward Alt+V to PTY — Claude handles image paste natively
      e.preventDefault()
      // Debounce: don't send another image within 3 seconds
      const now = Date.now()
      if (now - lastImagePasteRef.current < 3000) return
      lastImagePasteRef.current = now
      window.electronAPI.pty.write(sessionId, '\x1bv')
    }
  }

  return (
    <div className="flex-1 flex flex-col titlebar-no-drag overflow-hidden relative" style={{ minHeight: 0 }}>
      <div
        ref={xtermContainerRef}
        className="flex-1 bg-base p-1 overflow-hidden"
        style={{ minHeight: 0 }}
      />
      {/* Scroll to bottom button - shown when user has scrolled up */}
      {isScrolledUp && (
        <button
          onClick={() => {
            terminalRef.current?.scrollToBottom()
            isScrolledUpRef.current = false
            setIsScrolledUp(false)
          }}
          className="absolute right-4 bottom-24 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue/90 text-crust text-xs font-medium shadow-lg hover:bg-blue transition-colors cursor-pointer"
          title="Scroll to bottom"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          Live
        </button>
      )}
      {/* Context bar - shows statusline data */}
      {session && session.contextPercent != null && (
        <div className="flex flex-col shrink-0 bg-crust border-t border-surface0 text-xs font-mono">
          {/* Row 1: Context + model + cost + lines */}
          <div className="flex items-center gap-3 px-2 py-1">
            {session.modelName && (
              <span className="text-blue font-medium">{session.modelName}</span>
            )}
            <div className="flex items-center gap-1.5">
              {session.inputTokens != null && session.contextWindowSize ? (
                <span className="text-peach">{formatTokens(session.inputTokens)} / {formatTokens(session.contextWindowSize)}</span>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-20 h-1.5 bg-surface1 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${session.contextPercent}%`,
                    backgroundColor: session.contextPercent > 80 ? '#F38BA8'
                      : session.contextPercent > 50 ? '#F9E2AF'
                      : '#A6E3A1'
                  }}
                />
              </div>
              <span className="text-subtext0">{Math.round(session.contextPercent)}%</span>
            </div>
            <div className="flex-1" />
            {session.costUsd != null && (
              <span className="text-yellow" title="API equivalent cost (not billed on Max plan)">API eq ${session.costUsd.toFixed(4)}</span>
            )}
            {session.linesAdded != null && (
              <span className="text-green">+{session.linesAdded}</span>
            )}
            {session.linesRemoved != null && session.linesRemoved > 0 && (
              <span className="text-red">-{session.linesRemoved}</span>
            )}
            {session.totalDurationMs != null && (
              <span className="text-overlay0">{formatDuration(session.totalDurationMs)}</span>
            )}
          </div>
          {/* Row 2: Rate limits (only shown when data available) */}
          {session.rateLimitCurrent != null && (
            <div className="flex items-center gap-3 px-2 py-0.5 border-t border-surface0/50">
              <RateLimitBar label="5h" pct={session.rateLimitCurrent} resets={session.rateLimitCurrentResets} />
              {session.rateLimitWeekly != null && (
                <RateLimitBar label="7d" pct={session.rateLimitWeekly} resets={session.rateLimitWeeklyResets} />
              )}
              {session.rateLimitExtra?.enabled && (
                <span className="text-overlay0">
                  extra: <span className={session.rateLimitExtra.utilization > 80 ? 'text-red' : 'text-teal'}>${session.rateLimitExtra.usedUsd.toFixed(2)}</span>
                  <span className="text-overlay0">/${session.rateLimitExtra.limitUsd.toFixed(0)}</span>
                </span>
              )}
              <div className="flex-1" />
              {session.rateLimitCurrentResets && (
                <span className="text-overlay0" title="5h window resets">resets {formatResetTime(session.rateLimitCurrentResets)}</span>
              )}
            </div>
          )}
        </div>
      )}
      <CommandBar
        sessionId={sessionId}
        configId={configId}
        sessionType={ssh ? 'ssh' : 'local'}
        partnerEnabled={partnerEnabled}
        isPartnerActive={isPartnerActive}
        onTogglePartner={onTogglePartner}
        partnerSessionId={partnerSessionId}
        visionEnabled={visionConfig?.enabled}
        visionConnected={session?.visionConnected}
        visionBrowser={visionConfig?.browser}
        visionDebugPort={visionConfig?.debugPort}
      />
      {/* Drag handle for resizing input bar */}
      <div
        onMouseDown={handleResizeStart}
        onDoubleClick={() => {
          // Double-click resets to auto height
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
          className={`flex-1 bg-transparent text-text text-sm outline-none font-mono resize-none overflow-y-auto border ${needsAttention ? 'border-blue/50' : 'border-transparent'} rounded transition-colors`}
          style={{ maxHeight: '400px', ...(inputBarHeight > 0 ? { height: inputBarHeight + 'px' } : {}) }}
          placeholder={needsAttention
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
          sessionType={ssh ? 'ssh' : 'local'}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
