import React, { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useSessionStore } from '../stores/sessionStore'
import { hasSpawned, markSpawned, killSessionPty } from '../ptyTracker'
import { shouldUseResumePicker } from '../utils/resumePicker'
import { stripCursorSequences } from '../utils/terminalFormatting'
import { THEME } from './terminal/terminalTheme'
import { ScrollToBottomButton } from './terminal'
import { useStatuslineSubscription } from '../hooks/useStatuslineSubscription'
import { useActiveTabEffect } from '../hooks/useActiveTabEffect'
import { useCursorLayerVisibility } from '../hooks/useCursorLayerVisibility'
import { useAgentLibraryStore, BUILTIN_TEMPLATES } from '../stores/agentLibraryStore'

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
    postCommand?: string
    startClaudeAfter?: boolean
    dockerContainer?: string
  }
  isActive?: boolean
  legacyVersion?: {
    enabled: boolean
    version: string
  }
  agentIds?: string[]
  flickerFree?: boolean
  powershellTool?: boolean
  effortLevel?: 'low' | 'medium' | 'high'
  disableAutoMemory?: boolean
}

export default function TerminalView({ sessionId, configId, cwd, shellOnly, elevated, ssh, isActive = true, legacyVersion, agentIds, flickerFree, powershellTool, effortLevel, disableAutoMemory }: Props) {
  const xtermContainerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const attentionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attentionAckedRef = useRef(false)
  const [isScrolledUp, setIsScrolledUp] = useState(false)
  const isScrolledUpRef = useRef(false)
  const updateSession = useSessionStore((s) => s.updateSession)
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId))

  // Extracted hooks
  useStatuslineSubscription(sessionId)
  useActiveTabEffect(sessionId, isActive, terminalRef, attentionTimerRef, attentionAckedRef)
  useCursorLayerVisibility(xtermContainerRef, isActive, shellOnly)

  // Core terminal initialization + PTY wiring
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
    let parseTimer: ReturnType<typeof setTimeout> | null = null
    let pendingParseData = ''
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    let handleWheel: ((e: WheelEvent) => void) | null = null

    const initTerminal = () => {
      if (disposed) return

      const rect = container.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) {
        requestAnimationFrame(initTerminal)
        return
      }

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
        scrollback: 10000,
        allowTransparency: true,
      })

      fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.loadAddon(new WebLinksAddon())

      term.open(container)

      if (!shellOnly) {
        term.write('\x1b[?25l')
      }

      terminalRef.current = term
      fitAddonRef.current = fitAddon

      // Wait for custom fonts to load BEFORE computing cols/rows.
      // xterm.js measures character width using the currently-loaded font.
      // If we fit() before Cascadia Code loads, cols is computed against
      // a fallback font with different metrics — result: Claude Code's TUI
      // thinks it has N cols but xterm displays fewer, causing line wrap
      // artifacts and text fragments on the right edge.
      const fitAndSpawn = () => {
        if (disposed || !fitAddon || !term) return
        try { fitAddon.fit() } catch { /* ignore */ }

        if (!hasSpawned(sessionId)) {
          markSpawned(sessionId)
          const cols = term.cols
          const rows = term.rows
          const configLabel = session?.label || 'default'
          const useResumePicker = shouldUseResumePicker(sessionId)
          // Resolve agent template IDs to config objects for --agents flag
          let agentsConfig: Array<{ name: string; description: string; prompt: string; model?: string; tools?: string[] }> | undefined
          if (agentIds && agentIds.length > 0) {
            const allTemplates = [...useAgentLibraryStore.getState().templates, ...BUILTIN_TEMPLATES]
            agentsConfig = agentIds
              .map(id => allTemplates.find(t => t.id === id))
              .filter((t): t is NonNullable<typeof t> => !!t)
              .map(t => ({
                name: t.name,
                description: t.description,
                prompt: t.prompt,
                model: t.model !== 'inherit' ? t.model : undefined,
                tools: t.tools.length > 0 ? t.tools : undefined,
              }))
            if (agentsConfig.length === 0) agentsConfig = undefined
          }
          window.electronAPI.pty.spawn(sessionId, { cwd, cols, rows, ssh, shellOnly, elevated, configId, configLabel, useResumePicker, legacyVersion, agentsConfig, flickerFree, powershellTool, effortLevel, disableAutoMemory })
        }
      }

      // Wait for custom fonts, then fit + spawn. document.fonts.ready resolves
      // immediately if all fonts are already loaded, so no delay for subsequent sessions.
      document.fonts.ready.then(() => {
        // One more frame to let the browser apply the font to the terminal element
        requestAnimationFrame(fitAndSpawn)
      })

      // Forward xterm keyboard input to PTY
      term.onData((data) => {
        window.electronAPI.pty.write(sessionId, data)
      })

      container.addEventListener('mouseup', () => {
        setTimeout(() => term?.focus(), 0)
      })

      // Debounced parsing of context/cost/attention from PTY output
      let contextBuffer = ''
      const CONTEXT_BUFFER_MAX = 2000

      function scheduleParse() {
        if (parseTimer) return
        parseTimer = setTimeout(() => {
          parseTimer = null
          const data = pendingParseData
          pendingParseData = ''
          if (!data) return

          const stripped = data
            .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
            .replace(/\x1b[()][A-Z0-9]/g, '')
            .replace(/\x1b[=>]/g, '')

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
            if (costMatch) updates.costUsd = parseFloat(costMatch[1])
            const rl5hMatch = contextBuffer.match(/5h[:\s]*(\d+)%/)
            if (rl5hMatch) updates.rateLimitCurrent = parseInt(rl5hMatch[1])
            const rl7dMatch = contextBuffer.match(/7d[:\s]*(\d+)%/)
            if (rl7dMatch) updates.rateLimitWeekly = parseInt(rl7dMatch[1])

            if (Object.keys(updates).length > 0) {
              updateSession(sessionId, updates)
            }
            contextBuffer = ''
          }

          // Attention detection
          const visibleText = stripped.replace(/\s+/g, '')
          if (visibleText.length > 2) {
            attentionAckedRef.current = false
          }
          if (attentionTimerRef.current) clearTimeout(attentionTimerRef.current)
          const promptPattern = /[❯$#>]\s*$|\(y\/n\)\s*$|\?\s*$|Do you want|Yes\/No|Accept\?|approve/i
          if (promptPattern.test(stripped.trim()) && !attentionAckedRef.current) {
            attentionTimerRef.current = setTimeout(() => {
              attentionTimerRef.current = null
              // needsAttention: only for inactive tabs (controls tab notification dot)
              const state = useSessionStore.getState()
              if (state.activeSessionId !== sessionId) {
                updateSession(sessionId, { needsAttention: true })
              }
            }, 2000)
          }
        }, 250)
      }

      // --- Scroll state management ---
      // Use wheel events to detect intentional user scroll, not onScroll
      // (which fires spuriously during term.write and causes pull-down)
      const updateScrollState = (scrolledUp: boolean) => {
        isScrolledUpRef.current = scrolledUp
        setIsScrolledUp(scrolledUp)
      }

      handleWheel = () => {
        if (!term) return
        // After the wheel event settles, check viewport position
        if (refreshTimer) clearTimeout(refreshTimer)
        refreshTimer = setTimeout(() => {
          refreshTimer = null
          if (!term) return
          try {
            const buf = term.buffer.active
            const atBottom = buf.viewportY >= buf.baseY
            if (atBottom) {
              updateScrollState(false)
            } else {
              updateScrollState(true)
              // Fix scroll corruption by refreshing viewport
              term.refresh(0, term.rows - 1)
            }
          } catch { /* terminal may be disposed */ }
        }, 80)
      }
      container.addEventListener('wheel', handleWheel)

      // Only use onScroll to detect when user scrolls back to bottom
      // (e.g. via keyboard PageDown or scrollbar drag)
      term.onScroll(() => {
        if (disposed || !term || !isScrolledUpRef.current) return
        try {
          const buf = term.buffer.active
          const atBottom = buf.viewportY >= buf.baseY
          if (atBottom) updateScrollState(false)
        } catch { /* terminal may be disposed */ }
      })

      // Receive PTY output
      unsubData = window.electronAPI.pty.onData(sessionId, (data) => {
        const filtered = shellOnly ? data : stripCursorSequences(data) + '\x1b[?25l'
        term?.write(filtered)

        // Only auto-scroll if user hasn't scrolled up
        if (!isScrolledUpRef.current) {
          term?.scrollToBottom()
        }

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

      // Ctrl+Shift+C to copy selected text
      handleKeyDownCopy = (e: KeyboardEvent) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'C') {
          e.preventDefault()
          const sel = term?.getSelection()
          if (sel) navigator.clipboard.writeText(sel)
        }
      }
      document.addEventListener('keydown', handleKeyDownCopy)

      // Right-click: copy selection or paste from clipboard
      handleContextMenu = (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        const sel = term?.getSelection()
        if (sel) {
          navigator.clipboard.writeText(sel)
        } else {
          navigator.clipboard.readText().then((text) => {
            if (text) {
              // Paste directly into the PTY (like real Claude Code terminal)
              window.electronAPI.pty.write(sessionId, text)
            }
          })
        }
      }
      container.addEventListener('contextmenu', handleContextMenu, true)
    }

    requestAnimationFrame(initTerminal)

    return () => {
      disposed = true
      if (attentionTimerRef.current) clearTimeout(attentionTimerRef.current)
      if (parseTimer) clearTimeout(parseTimer)
      if (refreshTimer) clearTimeout(refreshTimer)
      if (handleKeyDownCopy) document.removeEventListener('keydown', handleKeyDownCopy)
      if (handleContextMenu) container.removeEventListener('contextmenu', handleContextMenu, true)
      if (handleWheel) container.removeEventListener('wheel', handleWheel)
      resizeObserver?.disconnect()
      unsubData?.()
      unsubExit?.()
      // DON'T kill PTY here - it survives HMR remounts.
      term?.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId])

  return (
    <div className="flex-1 flex flex-col titlebar-no-drag overflow-hidden relative" style={{ minHeight: 0 }}>
      <div
        ref={xtermContainerRef}
        className="flex-1 bg-base p-1 overflow-hidden"
        style={{ minHeight: 0 }}
      />
      {isScrolledUp && (
        <ScrollToBottomButton
          onClick={() => {
            terminalRef.current?.scrollToBottom()
            isScrolledUpRef.current = false
            setIsScrolledUp(false)
          }}
        />
      )}
    </div>
  )
}
