import React, { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { installWebglWithRecovery } from './terminal/terminalWebgl'
import { useSessionStore } from '../stores/sessionStore'
import { persistLastUsedAccount } from '../session-persistence'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useAccountGateStore, GATE_CANCELLED } from '../stores/accountGateStore'
import { hasSpawned, markSpawned, killSessionPty } from '../ptyTracker'
import SshFlowOverlay from './SshFlowOverlay'
import { shouldUseResumePicker } from '../utils/resumePicker'
import { shouldGateAccountChoice, formatSpawnError } from '../utils/sessionLaunch'
import { stripCursorSequences } from '../utils/terminalFormatting'
import { isControlReportOnly, decideContextMenuAction } from '../utils/terminalInput'
import { decideFollow } from '../utils/terminalScroll'
import { getTerminalTheme } from './terminal/terminalTheme'
import { useSettingsStore, DEFAULT_TERMINAL_SETTINGS } from '../stores/settingsStore'
import { ScrollToBottomButton } from './terminal'
import { useStatuslineSubscription } from '../hooks/useStatuslineSubscription'
import { useEffortSubscription } from '../hooks/useEffortSubscription'
import { useAccountIdentitySubscription } from '../hooks/useAccountIdentitySubscription'
import { useActiveTabEffect } from '../hooks/useActiveTabEffect'
import { useCursorLayerVisibility } from '../hooks/useCursorLayerVisibility'
import { useAgentLibraryStore, BUILTIN_TEMPLATES } from '../stores/agentLibraryStore'
import type { ProviderId, CodexOptions } from '../../shared/types'

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
  }
  isActive?: boolean
  legacyVersion?: {
    enabled: boolean
    version: string
  }
  agentIds?: string[]
  effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode'
  disableAutoMemory?: boolean
  /** P6: when true, the spawned Claude PTY is registered into the
   *  codex_review opt-in set in conductor-mcp-server. Mirrors
   *  disableAutoMemory's lifecycle (claudeOptions sparse boolean). */
  enableCodexReview?: boolean
  /** T16: per-session CCC indexing opt-out. DEFAULT-TRUE (undefined = on).
   *  Forwarded to the main process shouldRegisterRun predicate. */
  loggingEnabled?: boolean
  /** Per-session model override (sonnet | opus | haiku | ''). Empty
   * string means "use whatever the CLI picks". Forwarded to claude as
   * `--model <name>` when set. */
  model?: string
  /** Provider discriminator. Defaults to 'claude' if unspecified. */
  provider?: ProviderId
  /** Codex sub-options (only meaningful when provider === 'codex'). */
  codexOptions?: CodexOptions
}

export default function TerminalView({ sessionId, configId, cwd, shellOnly, elevated, ssh, isActive = true, legacyVersion, agentIds, effortLevel, disableAutoMemory, enableCodexReview, loggingEnabled, model, provider, codexOptions }: Props) {
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
  useEffortSubscription(sessionId)
  useAccountIdentitySubscription(sessionId)
  useActiveTabEffect(sessionId, isActive, terminalRef, attentionTimerRef, attentionAckedRef)
  useCursorLayerVisibility(xtermContainerRef, isActive, shellOnly)

  // SSH-specific: when the SshFlowOverlay's Launch Claude button is the
  // last thing the user clicked, focus stays on it. The overlay unmounts
  // on `claude-running` → focus falls back to <body> → the trust-this-
  // folder prompt's Enter goes to nothing. Subscribe to the flow state
  // here and pull focus into xterm the moment Claude is up. Skipped
  // when a modal is open so the walkthrough's focus trap wins.
  useEffect(() => {
    if (!ssh) return
    return window.electronAPI.ssh.onFlowState(sessionId, (msg) => {
      if (msg.state !== 'claude-running') return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      // requestAnimationFrame so React has time to unmount the overlay
      // and yield the focus stack before we grab it.
      requestAnimationFrame(() => {
        try { terminalRef.current?.focus() } catch { /* ignore */ }
      })
    })
  }, [sessionId, ssh])

  // Repaint the terminal whenever the resolved theme changes.
  // Watching data-theme on <html> via MutationObserver covers BOTH:
  //   - explicit user flips through ThemeToggle (settings.theme changes)
  //   - OS prefers-color-scheme changes while in 'system' mode (the
  //     useThemeController hook mutates data-theme directly in that case
  //     without touching settings.theme)
  // term.options.theme = X only colours new writes, so we also call
  // term.refresh(0, rows-1) to repaint existing scrollback. requestAnimationFrame
  // gives the browser a tick to recompute CSS variables before we read them.
  // Re-run on `terminalReady` flips — the init effect below sets this
  // to true after `terminalRef.current = term`, so the MutationObserver
  // attaches on first paint instead of returning early when the ref
  // was still null. Without this gate, theme flips never repainted.
  const [terminalReady, setTerminalReady] = useState(false)
  useEffect(() => {
    if (!terminalReady) return
    const term = terminalRef.current
    if (!term) return

    const apply = () => {
      const raf = requestAnimationFrame(() => {
        const live = terminalRef.current
        if (!live) return
        const palette = getTerminalTheme(useSettingsStore.getState().settings.terminal?.background)
        live.options.theme = shellOnly
          ? palette
          : { ...palette, cursor: palette.background, cursorAccent: palette.background }
        // Keep the light-mode contrast floor in lockstep with the theme flip
        // (see constructor): on in light, off in dark.
        live.options.minimumContrastRatio = document.documentElement.getAttribute('data-theme') === 'light' ? 4.5 : 1
        try {
          live.refresh(0, live.rows - 1)
        } catch {
          /* terminal may have been disposed mid-flip */
        }
        // Theme flip can recreate the cursor canvas; re-stamp the
        // inline hide for Claude sessions. Cheap & idempotent.
        if (!shellOnly && live.element) {
          live.element.querySelectorAll('.xterm-cursor-layer').forEach((el) => {
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
  }, [shellOnly, terminalReady])

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

    // PTY-integrity instrumentation (scoped to this session's mount; resets on
    // sessionId change because the effect re-runs).
    let bytesReceived = 0, bytesWritten = 0, strippedBytes = 0, ptyResizeCount = 0
    let lastSentCols: number | null = null, lastSentRows: number | null = null
    let reportTimer: ReturnType<typeof setTimeout> | null = null
    let resizeDebounce: ReturnType<typeof setTimeout> | null = null
    // Post-resume settle nudge (resume terminal corruption). A `claude --resume`
    // replays the whole prior transcript in one giant burst; on ConPTY that can
    // leave Claude's TUI and xterm disagreeing about geometry/viewport by a row,
    // so every later delta-redraw lands offset — stray `─`/text fragments overlay
    // the input line and PERSIST while typing. After a burst settles (600ms of
    // PTY silence), nudge the PTY rows-1 → rows: Claude re-lays-out its whole TUI
    // at the reconfirmed geometry, then term.refresh repaints xterm. Armed only
    // for resume-flavoured spawns, as a small self-extinguishing shot counter:
    // 2 for a direct --resume (first settle = post-replay), 3 for the resume
    // picker. Two traps this design must dodge: (a) each nudge's own repaint
    // output would re-arm the settle timer and CHAIN-FIRE the remaining shots —
    // hence a post-nudge suppression window; (b) the picker path settles many
    // times (UI paint, arrow-key echo) before the replay — hence picker shots
    // only spend on a replay-SIZED burst.
    let resumeNudgesLeft = 0
    let resumeNudgeGated = false          // picker path: only replay-sized bursts consume a shot
    let resumeNudgeBurstBytes = 0         // bytes accumulated since the last settle evaluation
    let resumeNudgeSuppressUntil = 0      // epoch ms; ignore re-arms right after our own nudge
    let resumeNudgeShrunk = false         // rows-1 shrink in flight, restore pending
    let resumeNudgeTimer: ReturnType<typeof setTimeout> | null = null
    let resumeNudgeRestoreTimer: ReturnType<typeof setTimeout> | null = null
    const reportIntegrity = () => {
      if (reportTimer) return
      reportTimer = setTimeout(() => {
        reportTimer = null
        window.electronAPI.ptyIntegrity?.report({
          sessionId,
          bytesReceived, bytesWritten, strippedBytes,
          cols: lastSentCols ?? 0, rows: lastSentRows ?? 0,
          resizeCount: ptyResizeCount,
        })
      }, 1000)
    }

    const initTerminal = () => {
      if (disposed) return

      const rect = container.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) {
        requestAnimationFrame(initTerminal)
        return
      }

      const ts = useSettingsStore.getState().settings.terminal || DEFAULT_TERMINAL_SETTINGS
      const fontFallbacks = "'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', Consolas, monospace"
      const fontFamily = ts.fontFamily ? `'${ts.fontFamily}', ${fontFallbacks}` : fontFallbacks

      // Claude's TUI draws its own input cursor as a coloured cell at
      // the prompt position, and leaves xterm's real cursor wherever
      // its last write landed -- usually somewhere off-screen for the
      // user. So in Claude sessions we hide xterm's cursor entirely
      // (theme paints it in the background colour, plus a CSS class
      // hides any focused-row cursor span). The user still sees
      // Claude's own input cursor; only the redundant xterm one is
      // suppressed. Shell sessions keep the normal visible cursor.
      const liveTheme = getTerminalTheme(ts.background)
      const termTheme = shellOnly
        ? liveTheme
        : { ...liveTheme, cursor: liveTheme.background, cursorAccent: liveTheme.background }
      if (!shellOnly) {
        container.classList.add('claude-session')
      }

      term = new Terminal({
        theme: termTheme,
        fontFamily,
        fontSize: ts.fontSize || 13,
        // 450 is a variable-font instance; if it renders unreliably in packaged
        // Electron, fall back to 400 after visual testing (spec section 2).
        fontWeight: (ts.fontWeight || 450) as import('@xterm/xterm').FontWeight,
        fontWeightBold: 700,
        lineHeight: ts.lineHeight || 1.2,
        cursorBlink: ts.cursorBlink ?? false,
        cursorStyle: ts.cursorStyle || 'bar',
        cursorWidth: 1,
        cursorInactiveStyle: 'none',
        scrollback: 10000,
        allowTransparency: true,
        // Light mode only: enforce a minimum contrast ratio so Claude's dim,
        // dark-theme-tuned greys (e.g. "Shell cwd was reset") stay readable on
        // the light terminal background. xterm darkens only text that fails the
        // ratio; the background and already-readable colours are untouched.
        // 1 (off) in dark mode, where Claude's colours already contrast well, so
        // dark rendering is unchanged. Kept in lockstep on theme flips below.
        minimumContrastRatio: document.documentElement.getAttribute('data-theme') === 'light' ? 4.5 : 1,
      })

      fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.loadAddon(new WebLinksAddon())

      term.open(container)

      // Load WebGL renderer (Codex recommendation #2). This swaps
      // xterm's default DOM glyph rendering for GPU-textured
      // glyphs — different cursor draw path, different glyph
      // fallback, and uniform across platforms. Fails gracefully if
      // WebGL is unavailable in the Electron renderer.
      //
      // On context loss (GPU crash / OOM / driver preempt > 3 s) the
      // addon disposes itself (xterm falls back to the DOM renderer automatically)
      // then we try ONE recreate in the next frame (GPU-blip recovery).
      // If recreate fails, we force term.refresh so the DOM renderer
      // repaints the viewport the dead WebGL canvas left garbled.
      installWebglWithRecovery(term, {
        WebglAddonCtor: WebglAddon,
        raf: requestAnimationFrame,
        isDisposed: () => disposed,
      })

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
      // Tell the theme-observer effect the terminal is live now so it
      // can attach the MutationObserver — refs alone don't trigger
      // effects, this state flip does.
      setTerminalReady(true)
      // Initial focus — when the terminal mounts as the active session
      // (typical case: user just clicked a config to launch a session,
      // or a fresh app with one session restored), nothing else routes
      // keyboard focus into xterm. Without this, the very first prompt
      // (Claude's "trust this folder?" in SSH, shell PS1) silently
      // eats keystrokes that hit the body element instead of the
      // terminal. Skipped while a modal is up so the tour / config
      // dialogs keep their focus trap.
      if (isActive && !document.querySelector('[role="dialog"][aria-modal="true"]')) {
        requestAnimationFrame(() => {
          try { term?.focus() } catch { /* ignore */ }
        })
      }

      // Wait for custom fonts to load BEFORE computing cols/rows.
      // xterm.js measures character width using the currently-loaded font.
      // If we fit() before JetBrains Mono loads, cols is computed against
      // a fallback font with different metrics -- result: Claude Code's TUI
      // thinks it has N cols but xterm displays fewer, causing line wrap
      // artifacts and text fragments on the right edge.
      const fitAndSpawn = () => {
        if (disposed || !fitAddon || !term) return
        try { fitAddon.fit() } catch { /* ignore */ }
        // Seed the integrity geometry from the initial (font-aware) fit so the
        // first throttled report carries the real cols/rows instead of 0 — and
        // so the ResizeObserver's "changed" guard has a correct baseline.
        if (term.cols > 0 && term.rows > 0) { lastSentCols = term.cols; lastSentRows = term.rows }

        if (!hasSpawned(sessionId)) {
          const gate = useAccountGateStore.getState()
          // Re-entry guard: a gate modal is already up for this session, so a
          // re-run of this effect must not open a second one or double-spawn.
          if (gate.isPending(sessionId)) return
          const cols = term.cols
          const rows = term.rows
          // Prefer the custom work name so a restored/pre-named session's log
          // carries the name from its first run (#119 rename → logs durability).
          const configLabel = session?.customName?.trim() || session?.label || 'default'
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
          // markSpawned only fires at the real spawn, so an unanswered/aborted
          // account gate leaves the session unspawned and re-gates on remount.
          const doSpawn = (resolvedProfileId: string | undefined) => {
            markSpawned(sessionId)
            // T8b (bug #5): app-relaunch ONLY. A restored session carries the
            // persisted exact-conversation target; pass it as `resume` so the
            // first spawn resumes THAT conversation (cwd-overridden in main).
            // In-session restart/switch leave `resume` undefined -- main
            // self-captures the live conversation. Consume the persisted target
            // after this spawn so a later in-session restart doesn't re-send a
            // stale relaunch uuid that would shadow main's self-capture.
            const resume =
              !shellOnly && session?.resumeUuid && session?.resumeCwd
                ? { uuid: session.resumeUuid, cwd: session.resumeCwd }
                : undefined
            if (resume) {
              updateSession(sessionId, { resumeUuid: undefined, resumeCwd: undefined })
              resumeNudgesLeft = 2
            } else if (useResumePicker && !shellOnly) {
              resumeNudgesLeft = 3
              resumeNudgeGated = true
            }
            window.electronAPI.pty
              .spawn(sessionId, { cwd, cols, rows, ssh, shellOnly, elevated, configId, configLabel, useResumePicker, legacyVersion, agentsConfig, effortLevel, disableAutoMemory, enableCodexReview, loggingEnabled, model, provider, codexOptions, profileId: resolvedProfileId, resume })
              .catch((err: unknown) => {
                // BUG-2: spawn was fire-and-forget, so a main-process throw (e.g.
                // "Codex CLI not found on PATH") became a silent unhandled
                // rejection + blank terminal. Surface the real cause in-terminal.
                console.error('[TerminalView] pty.spawn failed', err)
                term?.writeln(`\r\n\x1b[31mFailed to launch session: ${formatSpawnError(err)}\x1b[0m`)
              })
          }
          // Pre-spawn account gate: on a session's first spawn this run, ask which
          // account to launch under (multi-account on + >=1 profile), unless a
          // restart/switch already predetermined it. FAIL-OPEN: any error spawns
          // with the session's last-used account so a session never gets stuck.
          const profilesCount = useAccountProfilesStore.getState().profiles.length
          // Only provider sessions that actually authenticate are eligible. Skip
          // shell-only panes -- the partner terminal (its sessionId has no store
          // record), user "shell only" sessions, and the add-account login shell
          // (which already carries an explicit profileId) -- and skip when there
          // is no real session record.
          // BUG-1: account isolation is Claude-only (Codex auth lives in
          // ~/.codex, not profile-scoped), so the picker must never fire for a
          // Codex launch even when >=2 Claude account profiles exist.
          const eligible = shouldGateAccountChoice({ shellOnly, hasSession: !!session, profileCount: profilesCount, provider, isSsh: !!session?.sshConfig })
          // Consume the predetermined flag only for eligible sessions so a
          // restart/switch re-spawn skips the gate and uses its chosen account.
          const predetermined = eligible && gate.consumePredetermined(sessionId)
          const needGate = eligible && !predetermined
          if (!needGate) {
            doSpawn(session?.profileId)
          } else {
            gate
              .requestChoice(sessionId, session?.label || '', session?.profileId)
              .then((chosen) => {
                if (chosen === GATE_CANCELLED) {
                  // User aborted the launch: no PTY exists yet (the gate blocks
                  // before doSpawn), so closing is just removing the tab.
                  useSessionStore.getState().removeSession(sessionId)
                  return
                }
                // Persist the chosen account eagerly so a crash can't lose it
                // (the gate pre-selects session.profileId on the next launch).
                void persistLastUsedAccount(sessionId, chosen)
                if (!disposed) {
                  doSpawn(chosen)
                } else {
                  // View unmounted while the gate was open: the choice is saved,
                  // so the remount spawns it without re-prompting.
                  gate.markPredetermined(sessionId)
                }
              })
              .catch(() => doSpawn(session?.profileId))
          }
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
        // #406: focus in/out + cursor/mouse reports arrive via onData too. Only a real
        // keystroke/paste should un-ack the attention pulse, else leaving a session
        // re-arms the pulse without the user typing anything.
        // Shell-only sessions have no Claude hooks, so the attention flasher still
        // comes from PTY output; un-ack on real keystrokes. Provider sessions use
        // the hook-driven attention source (attention-source.ts) instead.
        if (shellOnly && !isControlReportOnly(data)) attentionAckedRef.current = false
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
          if (shellOnly && promptPattern.test(stripped.trim()) && !attentionAckedRef.current) {
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
        bytesReceived += data.length
        strippedBytes += data.length - filtered.length
        bytesWritten += filtered.length

        // Sticky-bottom follow (issue #73): sample the LIVE viewport position
        // BEFORE this chunk lays out and decide from THAT — not from the
        // wheel-set latch, which scrollbar-thumb drags and keyboard scrolling
        // never touched, so live output kept yanking the viewport back down.
        // onData chunks run atomically, so viewportY is the user's current
        // position. Keeps the scrolled-up latch (the scroll-to-bottom button)
        // in sync with where the user actually is, every chunk.
        const preWriteBuf = term?.buffer.active
        const follow = decideFollow({
          viewportY: preWriteBuf?.viewportY ?? 0,
          baseY: preWriteBuf?.baseY ?? 0,
        })

        term?.write(filtered)

        if (follow.scrollToBottom) term?.scrollToBottom()
        if (follow.scrolledUp !== isScrolledUpRef.current) updateScrollState(follow.scrolledUp)

        // Post-resume settle nudge: every chunk re-arms the timer; it fires only
        // once a burst has gone quiet for 600ms, and only while shots remain.
        // Suppressed right after our own nudge so its repaint can't chain-fire
        // the next shot. See the declaration comment for the full picture.
        if (resumeNudgesLeft > 0 && Date.now() >= resumeNudgeSuppressUntil) {
          resumeNudgeBurstBytes += data.length
          if (resumeNudgeTimer) clearTimeout(resumeNudgeTimer)
          resumeNudgeTimer = setTimeout(() => {
            resumeNudgeTimer = null
            if (disposed || !term || resumeNudgesLeft <= 0) return
            const burst = resumeNudgeBurstBytes
            resumeNudgeBurstBytes = 0
            // Picker sessions settle repeatedly before the replay (UI paint,
            // arrow-key echo) — only a replay-sized burst is worth a shot. 32KB
            // is far above a one-screen repaint and far below any real replay;
            // a tiny transcript may slip under it, but tiny replays are also the
            // least corruption-prone.
            if (resumeNudgeGated && burst < 32_768) return
            resumeNudgesLeft -= 1
            resumeNudgeSuppressUntil = Date.now() + 1500
            const c = term.cols, r = term.rows
            if (c > 0 && r > 2) {
              ptyResizeCount += 2
              resumeNudgeShrunk = true
              window.electronAPI.pty.resize(sessionId, c, r - 1)
              resumeNudgeRestoreTimer = setTimeout(() => {
                resumeNudgeRestoreTimer = null
                resumeNudgeShrunk = false
                if (disposed || !term) return
                // Re-read geometry AT FIRE TIME: a real user resize can land inside
                // the 60ms shrink window, and restoring the stale capture would
                // stomp it — PTY and xterm would disagree until the next resize.
                const c2 = term.cols, r2 = term.rows
                window.electronAPI.pty.resize(sessionId, c2, r2)
                lastSentCols = c2
                lastSentRows = r2
                try { term.refresh(0, r2 - 1) } catch { /* disposed mid-nudge */ }
                reportIntegrity()
              }, 60)
            }
          }, 600)
        }

        reportIntegrity()
        pendingParseData += data
        scheduleParse()
      })

      unsubExit = window.electronAPI.pty.onExit(sessionId, (exitCode) => {
        term?.writeln(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m`)
      })

      // Handle resize
      resizeObserver = new ResizeObserver(() => {
        // Trailing debounce: coalesce resize storms (a ConPTY-reflow aggravator)
        // into a single fit + resize.
        if (resizeDebounce) clearTimeout(resizeDebounce)
        resizeDebounce = setTimeout(() => {
          resizeDebounce = null
          if (disposed || !fitAddon || !term) return
          try {
            fitAddon.fit()
            const cols = term.cols, rows = term.rows
            // Guard: only resize on a valid, CHANGED geometry (skip failed/no-op fits).
            if (cols > 0 && rows > 0 && (cols !== lastSentCols || rows !== lastSentRows)) {
              lastSentCols = cols
              lastSentRows = rows
              ptyResizeCount += 1
              window.electronAPI.pty.resize(sessionId, cols, rows)
              reportIntegrity()
            }
            // xterm recreates / resizes the cursor canvas after fit;
            // re-stamp the inline hide so the caret stays gone.
            hideClaudeCursorLayer()
          } catch { /* ignore */ }
        }, 80)
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

      // Right-click: context-aware copy or paste depending on mode.
      //
      // Classic mode (classicTerminalCopyPaste, the default): CC's mouse
      // tracking is disabled so xterm owns selection. Right-click copies
      // the current selection when text is selected, or pastes from the
      // clipboard when nothing is selected. Route paste through xterm's
      // paste() so bracketed-paste mode (\x1b[200~...\x1b[201~) is respected.
      //
      // Non-classic mode: CC's copy-on-select already copied text on
      // mouse-up, so right-click always pastes (never re-copies).
      handleContextMenu = async (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        const classicMode = useSettingsStore.getState().settings.classicTerminalCopyPaste !== false
        const action = decideContextMenuAction(!!term?.getSelection(), classicMode)
        if (action === 'copy') {
          const sel = term?.getSelection()
          if (sel) {
            try {
              await navigator.clipboard.writeText(sel)
              term?.clearSelection()
            } catch {
              // clipboard write denied (insecure context / not focused)
            }
          }
          return
        }
        // action === 'paste'
        try {
          const text = await navigator.clipboard.readText()
          if (!text) return
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
      if (reportTimer) clearTimeout(reportTimer)
      if (resizeDebounce) clearTimeout(resizeDebounce)
      if (resumeNudgeTimer) clearTimeout(resumeNudgeTimer)
      if (resumeNudgeRestoreTimer) clearTimeout(resumeNudgeRestoreTimer)
      if (resumeNudgeShrunk && lastSentCols && lastSentRows) {
        // Unmount raced the 60ms shrink→restore gap: the session's PTY outlives
        // this view one row short — restore it best-effort with the last real
        // geometry so a remount doesn't inherit a desynced terminal.
        try { window.electronAPI.pty.resize(sessionId, lastSentCols, lastSentRows) } catch { /* main gone */ }
      }
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
      setTerminalReady(false)
    }
  }, [sessionId])

  const needsAttention = session?.needsAttention ?? false
  const needsLogin = session?.needsLogin ?? false

  return (
    <div className="flex-1 flex flex-col titlebar-no-drag overflow-hidden relative" style={{ minHeight: 0 }}>
      {needsLogin && (
        <div className="bg-blue/10 border-b border-blue/30 text-lavender text-xs px-3 py-1.5 shrink-0">
          Setting up a new account. Run claude, type /login, and choose the account. We&apos;ll detect it automatically.
        </div>
      )}
      <div
        ref={xtermContainerRef}
        className="flex-1 overflow-hidden"
        style={{
          minHeight: 0,
          padding: '8px 10px 8px 18px',
          // content-box: FitAddon reads getComputedStyle(container).height,
          // which under border-box (Tailwind global default) includes the
          // 8px top + 8px bottom padding → FitAddon over-counts by ~1 row,
          // causing the last terminal row to render over the status bar.
          // With content-box, getComputedStyle returns only the content
          // height (padding excluded), so FitAddon measures the exact
          // usable area. Flex sizing is unaffected: flex-1 stretches the
          // *total* element size regardless of box-sizing.
          boxSizing: 'content-box',
          background: 'linear-gradient(90deg, var(--surface-stage-gutter) 0, var(--surface-stage-gutter) 12px, var(--surface-stage) 12px)',
          boxShadow: 'inset 16px 0 20px -16px rgba(0,0,0,.5)',
        }}
      />
      {ssh && (
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
    </div>
  )
}
