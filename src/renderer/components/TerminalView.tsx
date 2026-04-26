import React, { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { useSessionStore } from '../stores/sessionStore'
import { hasSpawned, markSpawned, killSessionPty } from '../ptyTracker'
import CommandBar from './CommandBar'
import SshFlowOverlay from './SshFlowOverlay'
import { shouldUseResumePicker } from '../utils/resumePicker'
import { stripCursorSequences } from '../utils/terminalFormatting'
import { THEME, getTerminalTheme } from './terminal/terminalTheme'
import { useSettingsStore, DEFAULT_TERMINAL_SETTINGS } from '../stores/settingsStore'
import { ContextBar, ScrollToBottomButton } from './terminal'
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
    connectionFlow?: 'auto' | 'manual'
  }
  isActive?: boolean
  partnerEnabled?: boolean
  isPartnerActive?: boolean
  onTogglePartner?: () => void
  partnerSessionId?: string
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

export default function TerminalView({ sessionId, configId, cwd, shellOnly, elevated, ssh, isActive = true, partnerEnabled, isPartnerActive, onTogglePartner, partnerSessionId, legacyVersion, agentIds, flickerFree, powershellTool, effortLevel, disableAutoMemory }: Props) {
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

  // Repaint the terminal whenever the resolved theme changes.
  // Watching data-theme on <html> via MutationObserver covers BOTH:
  //   - explicit user flips through ThemeToggle (settings.theme changes)
  //   - OS prefers-color-scheme changes while in 'system' mode (the
  //     useThemeController hook mutates data-theme directly in that case
  //     without touching settings.theme)
  // term.options.theme = X only colours new writes, so we also call
  // term.refresh(0, rows-1) to repaint existing scrollback. requestAnimationFrame
  // gives the browser a tick to recompute CSS variables before we read them.
  useEffect(() => {
    const term = terminalRef.current
    if (!term) return

    const apply = () => {
      const raf = requestAnimationFrame(() => {
        if (!terminalRef.current) return
        const live = getTerminalTheme()
        term.options.theme = shellOnly
          ? live
          : { ...live, cursor: live.background, cursorAccent: live.background }
        try {
          term.refresh(0, term.rows - 1)
        } catch {
          /* terminal may have been disposed mid-flip */
        }
        // Theme flip can recreate the cursor canvas; re-stamp the
        // inline hide for Claude sessions. Cheap & idempotent.
        if (!shellOnly && term.element) {
          term.element.querySelectorAll('.xterm-cursor-layer').forEach((el) => {
            const node = el as HTMLElement
            node.style.setProperty('display', 'none', 'important')
            node.style.setProperty('visibility', 'hidden', 'important')
            node.style.setProperty('opacity', '0', 'important')
          })
        }
      })
      return raf
    }

    let pendingRaf = apply()
    const observer = new MutationObserver(() => {
      if (pendingRaf !== undefined) cancelAnimationFrame(pendingRaf)
      pendingRaf = apply()
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    return () => {
      observer.disconnect()
      if (pendingRaf !== undefined) cancelAnimationFrame(pendingRaf)
    }
  }, [shellOnly])

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

      // Claude's TUI draws its own input cursor as a coloured cell at
      // the prompt position, and leaves xterm's real cursor wherever
      // its last write landed — usually somewhere off-screen for the
      // user. So in Claude sessions we hide xterm's cursor entirely
      // (theme paints it in the background colour, plus a CSS class
      // hides any focused-row cursor span). The user still sees
      // Claude's own input cursor; only the redundant xterm one is
      // suppressed. Shell sessions keep the normal visible cursor.
      const liveTheme = getTerminalTheme()
      const termTheme = shellOnly
        ? liveTheme
        : { ...liveTheme, cursor: liveTheme.background, cursorAccent: liveTheme.background }
      if (!shellOnly) {
        container.classList.add('claude-session')
      }

      const ts = useSettingsStore.getState().settings.terminal || DEFAULT_TERMINAL_SETTINGS
      const fontFallbacks = "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace"
      const fontFamily = ts.fontFamily ? `'${ts.fontFamily}', ${fontFallbacks}` : fontFallbacks

      term = new Terminal({
        theme: termTheme,
        fontFamily,
        fontSize: ts.fontSize || 14,
        lineHeight: ts.lineHeight || 1.2,
        cursorBlink: ts.cursorBlink ?? false,
        cursorStyle: ts.cursorStyle || 'bar',
        cursorWidth: 1,
        cursorInactiveStyle: 'none',
        scrollback: 10000,
        allowTransparency: true,
      })

      fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.loadAddon(new WebLinksAddon())

      term.open(container)

      // Load WebGL renderer (Codex recommendation #2). This swaps
      // xterm's default 2D-canvas glyph rendering for GPU-textured
      // glyphs — different cursor draw path, different glyph
      // fallback, and uniform across platforms. Fails gracefully if
      // WebGL is unavailable in the Electron renderer.
      try {
        const webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => webglAddon.dispose())
        term.loadAddon(webglAddon)
      } catch (e) {
        // Stay on default renderer — WebGL not available in this env.
      }

      // Belt-and-braces hide for xterm's caret in Claude sessions.
      // The .claude-session class + global CSS rule should already
      // hide it, but xterm sets inline styles on the cursor canvas
      // each time it (re)creates the layer — on open, theme flip,
      // resize — and inline styles can race the CSS class. So we
      // also walk the DOM and stamp display:none directly with
      // !important. Idempotent and cheap.
      const hideClaudeCursorLayer = () => {
        if (shellOnly) return
        container.querySelectorAll('.xterm-cursor-layer').forEach((el) => {
          const node = el as HTMLElement
          node.style.setProperty('display', 'none', 'important')
          node.style.setProperty('visibility', 'hidden', 'important')
          node.style.setProperty('opacity', '0', 'important')
        })
        container.querySelectorAll('.xterm-screen [class*="cursor"]').forEach((el) => {
          const node = el as HTMLElement
          node.style.setProperty('background', 'transparent', 'important')
          node.style.setProperty('color', 'inherit', 'important')
          node.style.setProperty('border', '0', 'important')
          node.style.setProperty('outline', '0', 'important')
        })
      }
      hideClaudeCursorLayer()

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

      // Forward xterm keyboard input to PTY. User typing also resets the
      // attention-acked flag — we treat keystrokes as "user is kicking off
      // new work", so when Claude next hits a prompt we should re-surface
      // it if they've tabbed away by then.
      term.onData((data) => {
        attentionAckedRef.current = false
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

          // Attention detection. Ack is reset by user keystrokes (above)
          // — NOT by output. Previously any burst with >2 visible chars
          // reset ack, which meant Claude Code's spinner animation
          // (`✢ Mulling…` frames) kept wiping the ack while the user was
          // on a different tab, so the pulsing came back every time they
          // left even though nothing had actually changed. Tying the
          // reset to user input instead matches the user's mental model:
          // "I've seen this prompt; don't tell me again until I've
          // started a new task."
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

      // Receive PTY output. Pass through with minimal mutation —
      // Claude Code's TUI in alternate-screen mode (CLAUDE_CODE_NO_FLICKER=1)
      // handles its own cursor visibility / repaint; xterm renders
      // faithfully on top of ConPTY. The narrow stripCursorSequences
      // call still fights cursor blink and DECSCUSR styles that would
      // override our settings, but no longer touches reverse video,
      // backgrounds, or spinner glyphs.
      unsubData = window.electronAPI.pty.onData(sessionId, (data) => {
        const filtered = shellOnly ? data : stripCursorSequences(data)
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
          // xterm recreates / resizes the cursor canvas after fit;
          // re-stamp the inline hide so the caret stays gone.
          hideClaudeCursorLayer()
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
      handleContextMenu = async (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        const sel = term?.getSelection()
        if (sel) {
          try {
            await navigator.clipboard.writeText(sel)
          } catch {
            // clipboard access denied (insecure context / not focused)
          }
          return
        }
        try {
          const text = await navigator.clipboard.readText()
          if (!text) return
          // Route through xterm's paste() so bracketed-paste mode is
          // respected. Writing the raw text straight to the PTY skipped
          // the \x1b[200~...\x1b[201~ wrapping that apps like Claude
          // Code CLI use to distinguish pastes from keystrokes, causing
          // embedded \n to submit the first line and strand the rest
          // in the input buffer. xterm emits the (possibly wrapped)
          // payload via onData, which already forwards to pty.write.
          term?.paste(text)
        } catch {
          // clipboard access denied (insecure context / not focused)
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

  const needsAttention = session?.needsAttention ?? false

  return (
    <div className="flex-1 flex flex-col titlebar-no-drag overflow-hidden relative" style={{ minHeight: 0 }}>
      <div
        ref={xtermContainerRef}
        className="flex-1 bg-base p-1 overflow-hidden"
        style={{ minHeight: 0 }}
      />
      {ssh && (ssh.connectionFlow ?? 'manual') === 'manual' && (
        <SshFlowOverlay
          sessionId={sessionId}
          hasPostCommand={!!ssh.postCommand}
          shellOnly={!!shellOnly}
          enabled
        />
      )}
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
          isPeak={session.isPeak}
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
      />
    </div>
  )
}
