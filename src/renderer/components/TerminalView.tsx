import React, { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { installWebglWithRecovery, createAtlasResync, type WebglHandle } from './terminal/terminalWebgl'
import { atlasCoordinator } from './terminal/atlasCoordinator'
import {
  createStaleGlyphRepainter,
  shouldRepaintOnOutput,
  shouldSoftRepaintOnOutput,
  outputRepaintIntervalMs,
  ACTIVATION_MAX_STALE_MS,
  WHEEL_ACTIVE_MS,
  type StaleGlyphRepainter,
} from './terminal/staleGlyphRepaint'
import { useSessionStore } from '../stores/sessionStore'
import { useRestartSession } from '../hooks/useRestartSession'
import { persistLastUsedAccount } from '../session-persistence'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useAccountGateStore, GATE_CANCELLED } from '../stores/accountGateStore'
import { forgetSessionBrowserProfile } from '../stores/sshCloseStore'
import { hasSpawned, markSpawned, clearSpawned, killSessionPty } from '../ptyTracker'
import SshFlowOverlay from './SshFlowOverlay'
import { shouldUseResumePicker } from '../utils/resumePicker'
import { shouldGateAccountChoice, formatSpawnError } from '../utils/sessionLaunch'
import { stripCursorSequences } from '../utils/terminalFormatting'
import { isControlReportOnly, resolveContextMenuIntent, blindPasteNeedsMenu, sanitizeClipboardForPaste, sanitizePasteIntoTerminal, isMouseTracking, isOrdinaryEditable } from '../utils/terminalInput'
import TerminalContextMenu from './TerminalContextMenu'
import { decideFollow } from '../utils/terminalScroll'
import { getTerminalTheme } from './terminal/terminalTheme'
import { installTerminalKeybindings } from './terminal/terminalKeybindings'
import { registerRepainter } from './terminal/repaintRegistry'
import { useSettingsStore, DEFAULT_TERMINAL_SETTINGS, gpuRenderingEnabled } from '../stores/settingsStore'
import { usePasteHintStore } from '../stores/pasteHintStore'
import { installInputDiagnostics, describeBytes } from '../utils/inputDiagnostics'
import { ScrollToBottomButton } from './terminal'
import { useStatuslineSubscription } from '../hooks/useStatuslineSubscription'
import { useEffortSubscription } from '../hooks/useEffortSubscription'
import { useWatchdogSubscription } from '../hooks/useWatchdogSubscription'
import { useAccountIdentitySubscription } from '../hooks/useAccountIdentitySubscription'
import { useActiveTabEffect } from '../hooks/useActiveTabEffect'
import { useCursorLayerVisibility } from '../hooks/useCursorLayerVisibility'
import { useAgentLibraryStore, BUILTIN_TEMPLATES } from '../stores/agentLibraryStore'
import type { ProviderId, CodexOptions, TerminalOptions } from '../../shared/types'

// Re-export for consumers
export { killSessionPty } from '../ptyTracker'

// Main-process clipboard read first (focus-independent, retried for Windows
// delayed-render), renderer API as a fallback if IPC is unavailable. Shared by
// the keybinding paste, the classic right-click paste, and the context menu — so
// sanitizeClipboardForPaste here is the single chokepoint that strips paste-mode
// breakout sequences and readline-submitting controls out of EVERY paste route
// before the text can reach term.paste() and the PTY.
async function readClipboardText(): Promise<string> {
  let raw = ''
  try {
    raw = (await window.electronAPI.clipboard.readText()) || ''
  } catch { /* fall through */ }
  if (!raw) {
    try {
      raw = await navigator.clipboard.readText()
    } catch {
      raw = ''
    }
  }
  return sanitizeClipboardForPaste(raw)
}

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
  /** Per-session permission mode -> claude `--permission-mode`. '' / 'default' = no flag. */
  permissionMode?: string
  /** Advanced: extra CLI args appended verbatim to the claude launch command. */
  extraArgs?: string
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
  /** Terminal-only launcher options (only meaningful when shellOnly). The secret
   *  VALUE is never carried here — main resolves it from the keychain at spawn. */
  terminalOptions?: TerminalOptions
}

export default function TerminalView({ sessionId, configId, cwd, shellOnly, elevated, ssh, isActive = true, legacyVersion, agentIds, effortLevel, permissionMode, extraArgs, disableAutoMemory, enableCodexReview, loggingEnabled, model, provider, codexOptions, terminalOptions }: Props) {
  const xtermContainerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const attentionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attentionAckedRef = useRef(false)
  const [isScrolledUp, setIsScrolledUp] = useState(false)
  const isScrolledUpRef = useRef(false)
  /** The live repainter, so effects outside the init effect can ask for a
   *  repaint — see the tab-activation repaint below. */
  const repainterRef = useRef<StaleGlyphRepainter | null>(null)
  /** This terminal's atlas-resync callback, so the activation effect can ask the
   *  coordinator whether it is behind. Null until the terminal is built. */
  const atlasResyncRef = useRef<(() => void) | null>(null)
  // The LIVE WebGL handle for this terminal, or null when it is drawing on the
  // DOM renderer. A ref rather than a local in the mount effect because the
  // addon is now attached and detached as the pane comes and goes, which is a
  // different lifetime from the terminal's.
  const webglHandleRef = useRef<WebglHandle | null>(null)
  // Mirror of the isActive prop for `document`-level listeners installed by the
  // init effect (which keys on session identity, not activation) — reading the
  // captured prop there would go stale on tab switches. See the paste handler.
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  // Whether #145 input diagnostics are on, readable from the init effect's
  // long-lived onData closure.
  const inputDiagRef = useRef(false)
  // Explicit right-click menu (Copy/Paste). Opened by the contextmenu handler
  // whenever a blind copy-or-paste decision would be unsafe; null = closed.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null)
  // Close the menu the instant this tab is deactivated. Every TerminalView stays
  // mounted (App renders inactive ones display:none), and the menu arms a
  // document-level capture Escape listener — a menu left open in a hidden session
  // would swallow the ACTIVE session's Escape (a missed Claude interrupt) and
  // reappear as a ghost on tab-back. A keyboard tab-switch never fires the
  // backdrop's mousedown-close, so it must be closed here.
  useEffect(() => {
    if (!isActive) setCtxMenu(null)
  }, [isActive])

  // Rebuild the glyph atlas when this terminal becomes the active tab.
  //
  // This is the best repaint moment in the app and it comes from the observation
  // that a mouse wheel clears the corruption: switching to a session is exactly
  // when someone is about to READ that viewport, and the pane is appearing
  // anyway, so the rebuild is invisible here in a way it never is mid-stream.
  // Inactive sessions render display:none, so a session left streaming in the
  // background is the most likely one to have gone stale unseen.
  //
  // Deliberately NOT a synthetic wheel event: a real scroll moves the viewport
  // and would yank the view of anyone who had scrolled up to read something.
  // This fires the repaint the wheel would have caused, and nothing else.
  //
  // No `terminalReady` dependency: before the repainter exists there is nothing
  // to rebuild and the atlas is new anyway, so the mount pass is a deliberate
  // no-op. Every later activation is what this is for.
  useEffect(() => {
    if (!isActive) return
    // Catch up with any atlas rebuild this terminal missed, BEFORE deciding to
    // start another one. The frame-scheduled pass only reaches terminals that
    // were registered and alive in that frame; this is the backstop for the
    // ones it could not, and it is a no-op when already current (#311).
    //
    // Ordered first deliberately: strongIfStale may clear the shared atlas
    // itself, and resyncing against the atlas we are about to replace would be
    // one wasted repaint and a frame of the wrong pixels.
    if (atlasResyncRef.current) atlasCoordinator.resyncIfBehind(atlasResyncRef.current)
    repainterRef.current?.strongIfStale(ACTIVATION_MAX_STALE_MS)
  }, [isActive])
  const updateSession = useSessionStore((s) => s.updateSession)
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  // item 5 (resume cascade): the overlay's "no host" Retry re-spawns the whole
  // session (a dead PTY can't be recovered by re-writing the claude command).
  const { restart: sshRestart } = useRestartSession(session)

  // Extracted hooks
  useStatuslineSubscription(sessionId)
  useEffortSubscription(sessionId)
  useWatchdogSubscription(sessionId)
  useAccountIdentitySubscription(sessionId)
  useActiveTabEffect(sessionId, isActive, terminalRef, attentionTimerRef, attentionAckedRef)
  useCursorLayerVisibility(xtermContainerRef, isActive, shellOnly)

  // SSH-specific: when the SshFlowOverlay's Launch Claude button is the
  // last thing the user clicked, focus stays on it. The overlay unmounts
  // on `claude-running` → focus falls back to <body> → the trust-this-
  // folder prompt's Enter goes to nothing. Subscribe to the flow state
  // here and pull focus into xterm the moment Claude is up. Skipped
  // when a modal is open so the walkthrough's focus trap wins.
  // SSH tmux enhancement (items 8/9/10): persistence status + remote account,
  // pushed by main. Merged into the session store so the sidebar icon + header
  // pills reflect them for the session's whole life (this TerminalView stays
  // mounted per session, hidden when inactive). Renderer-only fields, never
  // persisted -- re-established by main's push on each spawn.
  useEffect(() => {
    if (!ssh) return
    return window.electronAPI.ssh.onSessionInfo(sessionId, (msg) => {
      const patch: { sshTmuxPersistent?: boolean; sshRemoteAccount?: string } = {}
      if (typeof msg.tmuxPersistent === 'boolean') patch.sshTmuxPersistent = msg.tmuxPersistent
      if (typeof msg.remoteAccount === 'string' && msg.remoteAccount) patch.sshRemoteAccount = msg.remoteAccount
      if (Object.keys(patch).length > 0) updateSession(sessionId, patch)
    })
  }, [sessionId, ssh, updateSession])

  useEffect(() => {
    if (!ssh) return
    return window.electronAPI.ssh.onFlowState(sessionId, (msg) => {
      if (msg.state !== 'claude-running') return
      // #242 tier 5: latch "this session has reached claude-running at
      // least once" so a LATER respawn (Restart after a dropped
      // connection) can pass SSHOptions.reconnect -- read back in doSpawn
      // below. Set unconditionally on every claude-running emit (already
      // idempotent: setting true to true is a no-op re-render at worst),
      // not just the first, since no earlier code path clears it.
      updateSession(sessionId, { sshReachedClaudeRunning: true })
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      // requestAnimationFrame so React has time to unmount the overlay
      // and yield the focus stack before we grab it.
      requestAnimationFrame(() => {
        try { terminalRef.current?.focus() } catch { /* ignore */ }
      })
    })
  }, [sessionId, ssh, updateSession])

  // Restore terminal focus when the WINDOW regains focus (#145).
  //
  // Terminal focus was previously re-grabbed only on session activation, overlay
  // unmount, and mouseup inside the terminal — never on window focus. An external
  // tool that steals focus and then synthesizes *typed characters* (rather than a
  // paste command) needs the xterm helper textarea focused, or the keystrokes land
  // on <body> and vanish. The paste handler above is focus-independent by design;
  // this covers the typing case.
  //
  // Only the active session, and never over a modal's focus trap.
  useEffect(() => {
    if (!isActive) return
    const onWindowFocus = () => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      // Don't yank focus out of a real input the user is working in.
      if (isOrdinaryEditable(document.activeElement as HTMLElement | null)) return
      requestAnimationFrame(() => {
        try { terminalRef.current?.focus() } catch { /* ignore */ }
      })
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [isActive])

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

  /**
   * WebGL is attached only while this pane is ON SCREEN, and detached the moment
   * it is not.
   *
   * Two separate limits make a hidden terminal's GPU context actively harmful,
   * and neither is visible while you look at one terminal:
   *
   *  1. Chromium allows roughly SIXTEEN WebGL contexts per renderer and evicts
   *     the oldest beyond that. Every session in this app keeps its TerminalView
   *     mounted -- that is what makes switching tabs instant and what keeps
   *     scrollback alive -- so a seventeenth session did not just fail to get a
   *     context, it took one away from a terminal that was using it. Eviction
   *     arrives as a context loss, i.e. as the storm the recovery code exists to
   *     survive.
   *  2. `@xterm/addon-webgl` keeps ONE glyph atlas per PROCESS. Every additional
   *     live context is one more terminal that someone else's atlas rebuild can
   *     blank. With a single live context there is no "someone else".
   *
   * A terminal that is not on screen renders nothing, so it is paying both of
   * those for no benefit whatsoever.
   *
   * The detach costs a re-raster when you come back to the tab -- but that tab
   * has to repaint on becoming visible anyway, so the work overlaps with a
   * repaint that was already going to happen.
   *
   * The atlas coordinator registration lives here too, not in the mount effect:
   * a terminal with no context has nothing to resync, and leaving it registered
   * would have it doing model-clearing work on behalf of an atlas it is not
   * drawing from.
   */
  useEffect(() => {
    const term = terminalRef.current
    if (!terminalReady || !term) return
    if (!isActive) return
    if (!gpuRenderingEnabled(useSettingsStore.getState().settings.terminal || DEFAULT_TERMINAL_SETTINGS)) return

    const handle = installWebglWithRecovery(term, {
      WebglAddonCtor: WebglAddon,
      raf: requestAnimationFrame,
      // The mount effect owns terminal teardown; this effect's own cleanup runs
      // first on unmount, so by the time anything here could fire the handle is
      // already detached.
      isDisposed: () => terminalRef.current !== term,
    })
    webglHandleRef.current = handle
    const resync = atlasResyncRef.current
    const unregister = resync ? atlasCoordinator.register(resync, sessionId) : null

    return () => {
      unregister?.()
      webglHandleRef.current = null
      handle.dispose()
    }
  }, [isActive, terminalReady])


  // Input diagnostics (#145), opt-in via CCC_INPUT_DEBUG=1. Active session only,
  // so one dictation run yields one readable trace rather than N interleaved
  // copies. Answers what an external tool ACTUALLY sends — see
  // inputDiagnostics.ts for why measuring had to replace reasoning here.
  useEffect(() => {
    if (!isActive || !terminalReady) return
    const container = xtermContainerRef.current
    if (!container) return
    let dispose: (() => void) | null = null
    let cancelled = false
    void window.electronAPI.inputDebug.enabled().then((on) => {
      if (!on || cancelled) return
      inputDiagRef.current = true
      dispose = installInputDiagnostics(container, (line) => window.electronAPI.inputDebug.log(`[${sessionId}] ${line}`))
    }).catch(() => { /* diagnostics are never load-bearing */ })
    return () => { cancelled = true; inputDiagRef.current = false; dispose?.() }
  }, [isActive, terminalReady, sessionId])

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
    let disposeKeybindings: (() => void) | null = null
    let handleContextMenu: ((e: MouseEvent) => void) | null = null
    let handlePaste: ((e: ClipboardEvent) => void) | null = null
    let disposed = false
    let parseTimer: ReturnType<typeof setTimeout> | null = null
    let pendingParseData = ''
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    let handleWheel: ((e: WheelEvent) => void) | null = null
    // #273 stale-glyph repaint: force a full WebGL repaint (clearTextureAtlas +
    // term.refresh) on the triggers that correlate with the ghosting — scroll and
    // streaming output — throttled so a firehose costs at most a few repaints/sec.
    let repainter: StaleGlyphRepainter | null = null
    /** Undo the #379 fix-E registration; see registerRepainter below. */
    let unregisterRepainter: (() => void) | null = null
    let lastWheelAt = Number.NEGATIVE_INFINITY

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
        cursorBlink: ts.cursorBlink ?? true,
        cursorStyle: ts.cursorStyle || 'bar',
        // 1px is a HiDPI hairline that reads as "no caret"; 2px is a visible bar.
        cursorWidth: 2,
        // Shell terminals show a hollow caret when unfocused so the input point
        // stays visible after focus shifts to the sidebar/config/input bar.
        // Claude/TUI sessions keep the caret fully hidden (they draw their own).
        cursorInactiveStyle: shellOnly ? 'outline' : 'none',
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
      // The GPU renderer is OPT-IN: only a literal `true` enables it (see
      // settingsStore.gpuRenderingEnabled). `@xterm/addon-webgl` keeps ONE glyph
      // atlas per PROCESS, so a clearTextureAtlas() from ANY terminal empties the
      // texture every OTHER terminal drawing from it. Only ONE terminal holds a
      // context at a time now (see the attach effect above), so "every other" is
      // currently nobody -- which is the point of doing it that way. The setting
      // is read when a pane ATTACHES rather than once at mount, so switching it
      // off takes effect on the next tab switch instead of needing a new session.
      // Repaint this terminal's viewport from the (shared) glyph atlas.
      const domRefresh = () => { try { term?.refresh(0, term.rows - 1) } catch { /* disposed */ } }
      // Drop THIS terminal's render model without touching the shared texture.
      //
      // A same-value theme reassignment is the only public API that does it: the
      // options setter fires xterm's `_handleColorChange`, which calls
      // `_clearModel(true)` on this terminal's renderer alone. Nothing about the
      // theme actually changes — the spread is what makes the setter fire.
      //
      // It has to be this and not `clearTextureAtlas()`, which would re-empty the
      // SHARED texture and hand the corruption to the next terminal; N terminals
      // clearing in response to each other never settles.
      const clearOwnModel = () => {
        try { if (term) term.options.theme = { ...term.options.theme } } catch { /* disposed */ }
      }
      // The coordinator's view of this terminal: drop the stale model, then
      // repaint — and only while WebGL is actually live here. The SAME reference
      // must go to both register() and notifyCleared() below; the coordinator
      // identifies the terminal that cleared by callback identity.
      const atlasResync = createAtlasResync(() => webglHandleRef.current, clearOwnModel, domRefresh)
      atlasResyncRef.current = atlasResync
      // WebGL is NOT attached here. Attaching lives in its own effect below,
      // keyed on whether this pane is on screen: a hidden terminal holding a
      // GPU context buys nothing and costs two things that both bite (the
      // ~16-context-per-renderer ceiling, and one more terminal exposed to the
      // process-wide glyph atlas). See the attach effect for the whole
      // argument.
      // #273 / #311: reproduces the window-resize repaint (clearTextureAtlas +
      // refresh) against whichever addon is currently live. The glyph atlas is
      // shared across every terminal, so a clear here empties it for all of them.
      // The coordinator (#311) refreshes the others, which is necessary but does
      // NOT make the clear safe — a victim keeps its old render model, so the
      // refresh repaints it blank. Only relevant when the opt-in GPU renderer is
      // on; inert on the DOM path (clearAtlas() returns false — nothing to clear).
      repainter = createStaleGlyphRepainter({
        // Rebuild the shared atlas; when it actually happened (WebGL live), tell
        // the coordinator so every OTHER terminal repaints — otherwise they
        // render against the atlas this clear just emptied (#311). Returns
        // whether the atlas was cleared; false on the DOM fallback / unrecovered
        // context loss, so the repainter skips its own refresh too.
        clearAtlas: () => {
          const cleared = webglHandleRef.current?.clearTextureAtlas() ?? false
          if (cleared) atlasCoordinator.notifyCleared(atlasResync)
          return cleared
        },
        atlasActive: () => webglHandleRef.current?.isActive() ?? false,
        refresh: domRefresh,
        now: Date.now,
        setTimer: (cb, ms) => setTimeout(cb, ms),
        clearTimer: (h) => clearTimeout(h),
      })
      repainterRef.current = repainter

      // #379 fix E: publish this terminal's repainter so the command bar can ask
      // for a full repaint after a GUI-subsystem tool has written over the pane.
      // That text never passes through the pty stream, so xterm cannot know its
      // model is stale — only an unconditional repaint puts the two back in
      // agreement.
      unregisterRepainter = registerRepainter(sessionId, {
        settleStrong: (quietMs, intervalMs) => repainter?.settleStrong(quietMs, intervalMs),
      })

      // #119: cursor options passed to the Terminal constructor do NOT reliably
      // initialize the WebGL renderer's cursor layer — the caret stays absent
      // even while focused/typing (xterm.js #1194 "initial cursorBlink has no
      // effect", #891 "cursor not visible initially"; the WebGL cursor is a
      // separate 2D canvas that this gap leaves empty). Re-assigning the options
      // at runtime after the addon loads forces the layer to build and draw.
      // Shell sessions only — Claude/TUI sessions intentionally hide the caret.
      if (shellOnly) {
        term.options.cursorBlink = ts.cursorBlink ?? true
        term.options.cursorStyle = ts.cursorStyle || 'bar'
        term.options.cursorWidth = 2
        term.options.cursorInactiveStyle = 'outline'
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
            // Ask Conductor's opening question. Read off the session record for
            // the same reason `resume` is: it is one-shot launch state, not
            // configuration. Consumed immediately below so a later in-session
            // Restart (which re-runs this spawn) never re-submits it. Only ever
            // set on a local, non-shell Claude session -- the SSH path does not
            // set CCC_ASK_PROMPT and Codex ignores it.
            const askPrompt = !shellOnly ? session?.askPrompt : undefined
            if (askPrompt) updateSession(sessionId, { askPrompt: undefined })
            if (resume) {
              updateSession(sessionId, { resumeUuid: undefined, resumeCwd: undefined })
              resumeNudgesLeft = 2
            } else if (useResumePicker && !shellOnly) {
              resumeNudgesLeft = 3
              resumeNudgeGated = true
            }
            // #242 tier 5: `reconnect` is computed here, not carried on the
            // `ssh` prop itself -- it reflects THIS session's own history
            // (sshReachedClaudeRunning, latched by the flow-state
            // subscription above), not anything the caller configured.
            // Merging it into a copy of `ssh` keeps that prop's shape a
            // pure reflection of the session's SAVED config.
            const sshWithReconnect = ssh ? { ...ssh, reconnect: !!session?.sshReachedClaudeRunning } : ssh
            window.electronAPI.pty
              .spawn(sessionId, { cwd, cols, rows, ssh: sshWithReconnect, shellOnly, elevated, terminalOptions, configId, configLabel, useResumePicker, legacyVersion, agentsConfig, effortLevel, permissionMode, extraArgs, disableAutoMemory, enableCodexReview, loggingEnabled, model, provider, codexOptions, profileId: resolvedProfileId, resume, askPrompt, isAsk: session?.kind === 'ask' })
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
                  // before doSpawn), so closing is just removing the tab. The
                  // tab is gone for good, so its browser profile goes with it —
                  // a no-op for a session that never opened a pane (#371).
                  forgetSessionBrowserProfile(sessionId)
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
        // #145 diagnostics: record what actually leaves for the PTY. The write path
        // is identical for shell and Claude sessions, so when the same dictation
        // lands in PowerShell but not in Claude, this line is what proves whether
        // the bytes handed to claude.exe were correct and complete. Control reports
        // are skipped — they'd bury the real input.
        if (inputDiagRef.current && !isControlReportOnly(data)) {
          window.electronAPI.inputDebug.log(
            `[${sessionId}] pty:write ${shellOnly ? 'shell' : 'claude'} ${describeBytes(data)}`,
          )
        }
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
        // #273: record the scroll and bust any stale glyphs now. Normal buffer
        // only — the alternate screen (TUI apps) owns its own repaints.
        lastWheelAt = Date.now()
        if (term.buffer.active.type !== 'alternate') repainter?.schedule()
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

        // #273: streaming output is when stale WebGL glyphs accumulate — at the
        // bottom with no scroll too (follow-up: a slicer's stderr ghosted and
        // stayed ghosted). Every normal-buffer chunk repaints, paced 4/sec while
        // scrolled up / wheel-active and 1/sec for steady at-bottom streaming,
        // and one settle repaint clears the last chunk's ghost once the stream
        // goes quiet. The repainter skips the refresh when WebGL isn't active.
        //
        // beta.14: only the scrolled-up / wheel-active case rebuilds the glyph
        // ATLAS. At-bottom streaming gets a refresh-only repaint, because Claude
        // Code renders in the normal buffer, so a rebuild-per-chunk ran for the
        // entire life of every session — continuous flashing and frames drawn
        // against a half-rebuilt atlas (the beta.13 regression).
        if (term && repainter) {
          const repaintState = {
            alternateBuffer: term.buffer.active.type === 'alternate',
            scrolledUp: isScrolledUpRef.current,
            msSinceWheel: Date.now() - lastWheelAt,
            wheelActiveMs: WHEEL_ACTIVE_MS,
          }
          const strong = shouldRepaintOnOutput(repaintState)
          if (strong || shouldSoftRepaintOnOutput(repaintState)) {
            const paceMs = outputRepaintIntervalMs(repaintState)
            repainter.schedule(paceMs, strong)
            // Settle at the SAME pace: a between-chunks settle on a steady
            // at-bottom stream must not repaint faster than the stream (it would
            // defeat the 1/sec bound); when output truly stops it still clears
            // the final ghost within one interval.
            repainter.settle(undefined, paceMs, strong)
            // ...and one STRONG rebuild once output actually stops. The atlas
            // goes stale on its own (#273: new glyph variety in the stream is
            // enough), and only a rebuild fixes it — which is why a window
            // resize clears it by hand. Doing it in the GAP means the user never
            // has to: nothing is moving, so it is not competing with a stream of
            // new frames, and the text they are about to read is corrected.
            repainter.settleStrong()
            // ...and a backstop, because settleStrong is DEBOUNCED: a stream
            // that never leaves an 800ms gap pushes it out indefinitely, so the
            // atlas stays stale for the whole length of a long build log or
            // Claude Code response and the mouse wheel is the only way out.
            // This only fires once the atlas has been stale that long anyway.
            repainter.strongIfStale()
          }
        }

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
        // The session object outlives the process, and until now nothing in the
        // renderer recorded that. A caller that finds the session and writes to
        // it -- Ask Conductor did exactly this -- has its bytes buffered into a
        // pendingWrites map that only a spawn drains, and a spawn CLEARS that
        // buffer before it fills it. So the write is not delayed, it is lost.
        // clearSpawned too, so a remount is allowed to respawn this id.
        useSessionStore.getState().updateSession(sessionId, { ptyExited: true })
        clearSpawned(sessionId)
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

      // Clipboard keybindings (copy + paste). The wiring lives in
      // terminalKeybindings.ts so the event-phase registration is unit-testable —
      // the #145 bug was a bubble-phase listener that xterm beat to the keystroke,
      // and no predicate test could see it (#154).
      //
      // `isActive` is passed as a THUNK, not a value: this effect keys on session
      // identity, so a captured boolean would go stale on tab switches, and the
      // listener is on `document`, shared by every mounted TerminalView.
      disposeKeybindings = installTerminalKeybindings({
        term: {
          getSelection: () => term?.getSelection() ?? '',
          paste: (text) => term?.paste(text),
          clearSelection: () => term?.clearSelection(),
        },
        isActive: () => isActiveRef.current,
        // Main-process clipboard read: focus-independent and retried for Windows
        // delayed-render, with the renderer API as a fallback if IPC is unavailable.
        readText: readClipboardText,
        writeText: (text) => navigator.clipboard.writeText(text),
        // Never fail silently — a silent no-op is what let #145 go unnoticed.
        onNothingToPaste: () => {
          usePasteHintStore.getState().show(sessionId, 'Nothing to paste — clipboard has no text')
        },
      })


      // Right-click: copy the selection, paste, or open the explicit menu.
      //
      // The decision lives in decideContextMenuAction. The load-bearing input
      // is term.modes.mouseTrackingMode: while a program tracks the mouse,
      // xterm disables its selection service, so "no selection" is guaranteed
      // and MUST NOT be read as "paste, a copy already happened" — that
      // reading fed the clipboard into the PTY (and, at a shell prompt,
      // executed it). Blind paste survives only in its classic-mode home (no
      // tracking, nothing selected, single-line or bracketed-paste target);
      // everything ambiguous opens TerminalContextMenu, where Copy and Paste
      // are explicit clicks. Paste routes through xterm's paste() so
      // bracketed-paste mode (\x1b[200~...\x1b[201~) is respected.
      handleContextMenu = async (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (!term) return
        const classicMode = useSettingsStore.getState().settings.classicTerminalCopyPaste !== false
        const { action, bracketedPaste } = resolveContextMenuIntent(term, classicMode)
        if (action === 'copy') {
          const sel = term.getSelection()
          if (sel) {
            try {
              await navigator.clipboard.writeText(sel)
              term.clearSelection()
            } catch {
              // clipboard write denied (insecure context / not focused)
            }
          }
          return
        }
        if (action === 'paste') {
          const text = await readClipboardText()
          if (!text) {
            // Never fail silently — a silent no-op is what let #145 go unnoticed.
            usePasteHintStore.getState().show(sessionId, 'Nothing to paste — clipboard has no text')
            return
          }
          // Re-sample tracking AFTER the (retried, possibly slow) clipboard read:
          // a program that started tracking the mouse during the await must open
          // the menu, not receive a decision taken while it was still a prompt.
          // Same tested seam as the first read (isMouseTracking) — never inline it.
          const trackingNow = isMouseTracking(term)
          if (trackingNow || blindPasteNeedsMenu(text, bracketedPaste)) {
            // Ambiguous now, or multi-line into a non-bracketed prompt (which
            // submits line-by-line) — require the explicit menu click.
            setCtxMenu({ x: e.clientX, y: e.clientY, hasSelection: !!term.getSelection() })
            return
          }
          term.paste(text)
          return
        }
        // action === 'menu'
        setCtxMenu({ x: e.clientX, y: e.clientY, hasSelection: !!term.getSelection() })
      }
      container.addEventListener('contextmenu', handleContextMenu, true)

      // SANITIZE EVERY NATIVE PASTE ROUTE — sanitizeClipboardForPaste is only a
      // true chokepoint if nothing can paste around it. readClipboardText() covers
      // the paths CCC owns (Ctrl+V, right-click), but xterm registers its OWN
      // 'paste' listener on the helper textarea that reads the RAW clipboard and
      // calls paste() with no strip, and that listener is still reachable two ways:
      // the Edit menu's {role:'paste'} -> webContents.paste(), and Ctrl+V while a
      // modal is open (installTerminalKeybindings bails before preventDefault when
      // hasModalOpen, so the native paste fires). Either re-opens the bracketed-
      // paste \x1b[201~ breakout the sanitiser exists to close. Intercept in the
      // CAPTURE phase on the container — an ancestor of the textarea, so this runs
      // BEFORE xterm's listener; stopPropagation keeps xterm from also pasting and
      // preventDefault stops the browser's own insertion, so the ONLY paste that
      // reaches this terminal is the sanitised one.
      handlePaste = (e: ClipboardEvent) => {
        if (!term) return
        sanitizePasteIntoTerminal(e, term)
      }
      container.addEventListener('paste', handlePaste, true)
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
      disposeKeybindings?.()
      if (handleContextMenu) container.removeEventListener('contextmenu', handleContextMenu, true)
      if (handlePaste) container.removeEventListener('paste', handlePaste, true)
      if (handleWheel) container.removeEventListener('wheel', handleWheel)
      unregisterRepainter?.()
      repainter?.dispose()
      if (repainterRef.current === repainter) repainterRef.current = null
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

  // Context-menu actions. Close first so the menu is gone before any async
  // clipboard work; refocus the terminal so the user can keep typing.
  const closeCtxMenu = () => {
    setCtxMenu(null)
    terminalRef.current?.focus()
  }
  const ctxMenuCopy = async () => {
    const sel = terminalRef.current?.getSelection()
    setCtxMenu(null)
    if (sel) {
      try {
        await navigator.clipboard.writeText(sel)
      } catch {
        // clipboard write denied (insecure context / not focused)
      }
    }
    // Re-read the ref AFTER the await: the session can be disposed mid-await,
    // which nulls terminalRef — pasting/clearing into a captured-but-disposed
    // Terminal would throw.
    terminalRef.current?.clearSelection()
    terminalRef.current?.focus()
  }
  const ctxMenuPaste = async () => {
    setCtxMenu(null)
    const text = await readClipboardText()
    const term = terminalRef.current // re-read post-await; may be null if disposed
    if (!text) {
      usePasteHintStore.getState().show(sessionId, 'Nothing to paste — clipboard has no text')
    } else {
      term?.paste(text)
    }
    term?.focus()
  }

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
          onRetry={sshRestart}
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
      {ctxMenu && (
        <TerminalContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          hasSelection={ctxMenu.hasSelection}
          onCopy={ctxMenuCopy}
          onPaste={ctxMenuPaste}
          onClose={closeCtxMenu}
        />
      )}
    </div>
  )
}
