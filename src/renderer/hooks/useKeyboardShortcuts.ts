import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { requestCloseSession } from '../stores/sshCloseStore'
import { matchesShortcut, DEFAULT_SHORTCUTS } from '../utils/shortcuts'
import { captureGlyphDiagnostic } from '../utils/glyphDiagnostic'
import { requestResync } from '../components/terminal/repaintRegistry'
import { sendImageToSession, typeImagePathIntoShell } from '../utils/imageTransfer'
import { sendImagePathToCodex } from '../lib/codexComposer'
import { usePasteHintStore } from '../stores/pasteHintStore'
import { useAppMetaStore } from '../stores/appMetaStore'
import { deriveOnboarding } from '../onboarding/gate'
import { useHelloCodexStore } from '../onboarding/hello-codex-open'
import { PARTNER_PTY_SUFFIX } from '../../shared/multi-spawn-rule'
import type { ViewType } from '../types/views'

/**
 * P3.16a (N9): whether the tab's partner shell is the pane on screen. The
 * partner view shows the partner shell (its own PTY, `<session id>-partner`)
 * in place of the session's terminal, which is hidden then. TerminalView marks
 * its pane with data-terminal-session (the PTY id) and the one pane on screen
 * with data-terminal-active, as the Ctrl+Alt+R handler below reads them. The
 * id is compared as a value, never put into a selector.
 */
function partnerOnScreen(sessionId: string): boolean {
  const partnerId = sessionId + PARTNER_PTY_SUFFIX
  return Array.from(document.querySelectorAll('[data-terminal-session]')).some(
    (el) => el.getAttribute('data-terminal-session') === partnerId && el.hasAttribute('data-terminal-active'),
  )
}

/**
 * Global keyboard shortcuts (configurable via settings).
 */
export function useKeyboardShortcuts(
  activeSessionId: string | null,
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>,
  setView: (view: ViewType) => void,
  // The active main-pane view and the open page tabs, so the tab shortcuts
  // cycle the WHOLE strip (sessions + page tabs), not sessions alone.
  view: ViewType,
  openPageTabs: ViewType[],
  closePageTab: (v: ViewType) => void,
) {
  useEffect(() => {
    // One ordered tab list: sessions first (their order), then the open page
    // tabs (open order) — the same order the TabBar renders.
    type Tab = { kind: 'session'; id: string } | { kind: 'page'; view: ViewType }
    const buildTabs = (): Tab[] => [
      ...useSessionStore.getState().sessions.map((s) => ({ kind: 'session' as const, id: s.id })),
      ...openPageTabs.map((v) => ({ kind: 'page' as const, view: v })),
    ]
    const activateTab = (t: Tab) => {
      if (t.kind === 'session') { useSessionStore.getState().setActiveSession(t.id); setView('sessions') }
      else setView(t.view)
    }
    const activeTabIndex = (tabs: Tab[]): number =>
      view === 'sessions'
        ? tabs.findIndex((t) => t.kind === 'session' && t.id === useSessionStore.getState().activeSessionId)
        : tabs.findIndex((t) => t.kind === 'page' && t.view === view)

    const handleKeyDown = async (e: KeyboardEvent) => {
      // The onboarding overlay covers the whole shell: a global shortcut
      // firing under it would act on invisible UI (close a session, switch
      // sessions, paste into a hidden prompt), so suppress them until the
      // flow settles. Same gate expression as App.tsx's bootGate input.
      if (deriveOnboarding(useAppMetaStore.getState().meta, {}).due) return
      // The same for the Codex introduction's takeover and its replay (WP2
      // commit 6f): they cover the whole shell too.
      if (useHelloCodexStore.getState().open !== null) return
      // MERGE over the defaults, never substitute: a persisted map predating a
      // release lacks that release's new actions, and `|| DEFAULT_SHORTCUTS`
      // only helps when the whole object is absent — every existing user would
      // have the new chord silently dead (#503 review; StageEmptyState already
      // merges this way).
      const shortcuts = { ...DEFAULT_SHORTCUTS, ...(useSettingsStore.getState().settings.keyboardShortcuts || {}) }

      // Close current tab: a page tab closes the page; a session tab routes
      // through the End-vs-Leave-running choice.
      if (matchesShortcut(e, shortcuts.closeSession)) {
        e.preventDefault()
        if (view !== 'sessions') closePageTab(view)
        else if (activeSessionId) requestCloseSession(activeSessionId)
      }
      // Next/Previous tab — cycles the whole strip (sessions + page tabs).
      if (matchesShortcut(e, shortcuts.nextSession) || matchesShortcut(e, shortcuts.prevSession)) {
        e.preventDefault()
        const tabs = buildTabs()
        const idx = activeTabIndex(tabs)
        if (tabs.length > 1 && idx >= 0) {
          const isNext = matchesShortcut(e, shortcuts.nextSession)
          const nextIdx = isNext ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length
          activateTab(tabs[nextIdx])
        }
      }
      // Ctrl+1-9: jump to the Nth tab in the strip (sessions then page tabs).
      if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const idx = parseInt(e.key) - 1
        const tabs = buildTabs()
        if (idx < tabs.length) activateTab(tabs[idx])
      }
      // Toggle sidebar
      if (matchesShortcut(e, shortcuts.toggleSidebar)) {
        e.preventDefault()
        setSidebarOpen(prev => !prev)
      }
      // (Ctrl+Alt+G lives in the CAPTURE-phase listener below, not here: the
      // glyph shortcut is pressed while staring at a corrupted TERMINAL, and
      // with the terminal focused xterm consumes the keydown before it can
      // bubble to this listener — the one place the shortcut mattered was the
      // one place it never fired.)
      // NOTE: rename (F2) is handled in Sidebar so it edits the active session
      // in the Active Sessions list (only when the sidebar is visible), not the
      // tab. Tab double-click / right-click still edit the tab inline.
      // Paste clipboard image: saves to host screenshots dir, then routes it by
      // the pane on screen. A Claude session: a local one gets the absolute path
      // written into the prompt (Claude's Read tool ingests it directly), an SSH
      // one, which can't reach the host filesystem, the Conductor MCP fetch over
      // the reverse tunnel. A Codex session: its line through the Codex typing
      // rule. A plain terminal, and the partner shell in the partner view: only
      // the quoted path, with no Enter (nothing over SSH, or for a terminal that
      // is not running, with a hint saying where the image is).
      if (matchesShortcut(e, shortcuts.pasteImage)) {
        e.preventDefault()
        const state = useSessionStore.getState()
        const sessionId = state.activeSessionId
        if (sessionId) {
          const session = state.sessions.find((s) => s.id === sessionId)
          // The pane on screen when Alt+V is pressed is the target, read
          // before the image is saved, as the session is.
          const showingPartner = partnerOnScreen(sessionId)
          const res = await window.electronAPI.clipboard.saveImage()
          if ('path' in res) {
            // P3.15 (row 70): this runs with focus outside the terminal (a
            // focused terminal hands Alt+V to the CLI, which pastes the image
            // itself). A Codex session's line goes through the rule the app
            // types into Codex by, and a line it could not send says why.
            if (showingPartner) {
              // P3.16a (N9): in the partner view the partner shell is on screen
              // and the session's terminal is hidden, so the image goes to the
              // partner shell and the assistant behind it gets nothing. The
              // partner is a plain shell on this computer for every tab (an SSH
              // tab's too: it opens at home here), so it gets what a plain
              // terminal on this computer gets: the image's path, quoted for its
              // shell, with no sentence and no Enter.
              typeImagePathIntoShell(sessionId + PARTNER_PTY_SUFFIX, res.path, window.electronPlatform === 'win32')
            } else if (session?.shellOnly) {
              // P3.16a (U6): a plain terminal has no assistant to tell, so it
              // gets the image's path, quoted for its shell, and no sentence or
              // Enter. Over SSH the file is on this computer, which the remote
              // shell cannot read: nothing is typed, and the hint says where it is.
              // A terminal whose process has ended or never started has no shell
              // to type into: nothing is typed, and the hint says so (round 1),
              // as the Codex route says when its session is not running.
              if (session.ptyExited || session.neverStarted) {
                usePasteHintStore.getState().show(sessionId, `This terminal is not running, so nothing was typed; the image was saved on this computer at ${res.path}.`)
              } else if (session.sessionType === 'ssh') {
                usePasteHintStore.getState().show(sessionId, `The image was saved on this computer at ${res.path}; the remote shell cannot read it, so nothing was typed.`)
              } else {
                typeImagePathIntoShell(sessionId, res.path, window.electronPlatform === 'win32')
              }
            } else if (session?.provider === 'codex') {
              sendImagePathToCodex(sessionId, res.path, (note) => usePasteHintStore.getState().show(sessionId, note))
            } else {
              // Success is self-evident — the path appears in the prompt (no toast).
              sendImageToSession(sessionId, res.path, 'I just pasted an image — please view it.', session?.sessionType)
            }
          } else {
            usePasteHintStore.getState().show(
              sessionId,
              res.error === 'too-large'
                ? 'Image too large to paste (max 10 MB)'
                : 'No image in clipboard — copy an image or an image file, then Alt+V',
            )
          }
        }
      }
    }

    // Capture a glyph-corruption diagnostic (#374): the moment a user sees
    // characters go missing while backgrounds stay, this saves the always-on
    // atlas event ring + a window screenshot and reveals them to share. Fixed
    // action, not per-session, so it fires whatever the active view (one
    // residual gap: focus inside the browser pane's own WebContents keeps keys
    // there — only Escape is forwarded) — and on
    // the CAPTURE phase, because the natural moment to press it is with the
    // corrupted terminal FOCUSED, where xterm's own key handling stops the
    // event before a bubble listener ever hears it (the beta.17 "Ctrl+Alt+G
    // does nothing" report; same arbitration as the tip card's Escape).
    // Guard AltGraph: on international layouts AltGr reports ctrlKey && altKey,
    // so a bare Ctrl+Alt+<key> binding would swallow AltGr text entry into the
    // terminal. Skip when AltGr is really down (#399 ADR-009 pass).
    const handleGlyphCapture = (e: KeyboardEvent) => {
      // Same onboarding-overlay suppression as handleKeyDown: a diagnostic
      // capture under the covered shell would screenshot the overlay.
      if (deriveOnboarding(useAppMetaStore.getState().meta, {}).due) return
      if (useHelloCodexStore.getState().open !== null) return
      // The Settings shortcut recorder / Test box must WIN over this capture
      // listener, or the chord can never be re-recorded or tested (pressing it
      // in the Test box would fire a real capture — disk write + Explorer
      // reveal — instead of reporting a match). Those boxes carry
      // data-shortcut-capture; yield to them.
      if ((e.target as Element | null)?.closest?.('[data-shortcut-capture]')) return
      // Merge over defaults for the same reason as handleKeyDown: a persisted
      // pre-release map must not leave newer chords dead.
      const shortcuts = { ...DEFAULT_SHORTCUTS, ...(useSettingsStore.getState().settings.keyboardShortcuts || {}) }
      if (matchesShortcut(e, shortcuts.captureGlyphDiagnostic) && !e.getModifierState?.('AltGraph')) {
        // Consume repeats but never act on them: each fire is a disk write +
        // Explorer reveal, and an unconsumed repeat would stream the chord's
        // xterm encoding (ESC + ctrl-char) into the pty instead.
        e.preventDefault()
        e.stopPropagation()
        if (e.repeat) return
        void captureGlyphDiagnostic(useSessionStore.getState().activeSessionId)
      }
      // Repaint + geometry re-sync (#503): pressed while staring at a pane
      // something printed over — same capture-phase + AltGr reasoning as the
      // glyph capture above.
      if (matchesShortcut(e, shortcuts.repaintTerminal) && !e.getModifierState?.('AltGraph')) {
        // Same repeat rule: consumed, not acted on — a held chord auto-repeats
        // ~16Hz and each fire is a pty resize pair.
        e.preventDefault()
        e.stopPropagation()
        if (e.repeat) return
        // Repair the terminal the chord was pressed IN, resolved by DOM
        // ancestry: the focused pane may be the partner shell or an alt pane,
        // registered under its own key — the active session id alone would
        // nudge a hidden pty. With focus outside any terminal, the pane
        // actually on screen (data-terminal-active — at most one) is the
        // target; the bare active id is the last resort.
        const from = (e.target as Element | null)?.closest?.('[data-terminal-session]')
        const sid = from?.getAttribute('data-terminal-session')
          || document.querySelector('[data-terminal-session][data-terminal-active]')?.getAttribute('data-terminal-session')
          || useSessionStore.getState().activeSessionId
        if (sid) requestResync(sid)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keydown', handleGlyphCapture, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keydown', handleGlyphCapture, true)
    }
    // view / openPageTabs / closePageTab / setView are read in the closure; keep
    // the listener bound to their current values so tab cycling stays correct.
  }, [activeSessionId, view, openPageTabs, closePageTab, setView, setSidebarOpen])
}
