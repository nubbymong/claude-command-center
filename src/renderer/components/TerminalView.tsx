import React, { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useSessionStore } from '../stores/sessionStore'
import { hasSpawned, markSpawned, killSessionPty } from '../ptyTracker'
import CommandBar from './CommandBar'
import { shouldUseResumePicker } from '../utils/resumePicker'
import { stripCursorSequences } from '../utils/terminalFormatting'
import { THEME } from './terminal/terminalTheme'
import { ContextBar, ScrollToBottomButton } from './terminal'
import { useStatuslineSubscription } from '../hooks/useStatuslineSubscription'
import { useCompactionInterrupt } from '../hooks/useCompactionInterrupt'
import { useVisionLifecycle } from '../hooks/useVisionLifecycle'
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
    url?: string
    headless?: boolean
  }
  legacyVersion?: {
    enabled: boolean
    version: string
  }
  agentIds?: string[]
}

export default function TerminalView({ sessionId, configId, cwd, shellOnly, elevated, ssh, isActive = true, partnerEnabled, isPartnerActive, onTogglePartner, partnerSessionId, visionConfig, legacyVersion, agentIds }: Props) {
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
  useCompactionInterrupt(sessionId)
  useVisionLifecycle(sessionId, visionConfig)
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

      // Fit and spawn PTY
      requestAnimationFrame(() => {
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
          window.electronAPI.pty.spawn(sessionId, { cwd, cols, rows, ssh, shellOnly, elevated, configLabel, useResumePicker, visionConfig, legacyVersion, agentsConfig })
        }
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

      // Receive PTY output
      unsubData = window.electronAPI.pty.onData(sessionId, (data) => {
        const filtered = shellOnly ? data : stripCursorSequences(data) + '\x1b[?25l'
        term?.write(filtered)

        if (!isScrolledUpRef.current) {
          term?.scrollToBottom()
        } else if (term) {
          if (refreshTimer) clearTimeout(refreshTimer)
          refreshTimer = setTimeout(() => {
            refreshTimer = null
            try { term.refresh(0, term.rows - 1) } catch { /* ignore */ }
          }, 150)
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

      // Track scroll position
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

      scrollCheckInterval = setInterval(() => {
        if (disposed || !term) return
        try {
          const buf = term.buffer.active
          const atBottom = buf.viewportY >= buf.baseY
          if (atBottom) updateScrollState(false)
        } catch { /* terminal may be disposed */ }
      }, 500)

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
      resizeObserver?.disconnect()
      if (scrollCheckInterval) clearInterval(scrollCheckInterval)
      unsubData?.()
      unsubExit?.()
      // DON'T kill PTY here - it survives HMR remounts.
      term?.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId])

  const needsAttention = session?.needsAttention ?? false

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
      {session && session.contextPercent != null && (
        <ContextBar
          modelName={session.modelName}
          inputTokens={session.inputTokens}
          contextWindowSize={session.contextWindowSize}
          contextPercent={session.contextPercent}
          costUsd={session.costUsd}
          linesAdded={session.linesAdded}
          linesRemoved={session.linesRemoved}
          totalDurationMs={session.totalDurationMs}
          rateLimitCurrent={session.rateLimitCurrent}
          rateLimitCurrentResets={session.rateLimitCurrentResets}
          rateLimitWeekly={session.rateLimitWeekly}
          rateLimitWeeklyResets={session.rateLimitWeeklyResets}
          rateLimitExtra={session.rateLimitExtra}
        />
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
        visionUrl={visionConfig?.url}
        visionHeadless={visionConfig?.headless}
      />
    </div>
  )
}
