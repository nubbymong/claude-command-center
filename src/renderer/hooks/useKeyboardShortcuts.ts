import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { requestCloseSession } from '../stores/sshCloseStore'
import { matchesShortcut, DEFAULT_SHORTCUTS } from '../utils/shortcuts'
import { captureGlyphDiagnostic } from '../utils/glyphDiagnostic'
import { requestResync } from '../components/terminal/repaintRegistry'
import { sendImageToSession } from '../utils/imageTransfer'
import { usePasteHintStore } from '../stores/pasteHintStore'
import { useAppMetaStore } from '../stores/appMetaStore'
import { deriveOnboarding } from '../onboarding/gate'
import type { ViewType } from '../types/views'

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
      // Paste clipboard image: saves to host screenshots dir, then routes to
      // Claude. Local sessions get the absolute path written into the prompt
      // (Claude's Read tool ingests it directly). SSH sessions can't reach
      // the host filesystem so they go through the Conductor MCP
      // fetch over the reverse tunnel.
      if (matchesShortcut(e, shortcuts.pasteImage)) {
        e.preventDefault()
        const state = useSessionStore.getState()
        const sessionId = state.activeSessionId
        if (sessionId) {
          const session = state.sessions.find((s) => s.id === sessionId)
          const res = await window.electronAPI.clipboard.saveImage()
          if ('path' in res) {
            // Success is self-evident — the path appears in the prompt (no toast).
            sendImageToSession(sessionId, res.path, 'I just pasted an image — please view it.', session?.sessionType)
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
        e.preventDefault()
        e.stopPropagation()
        void captureGlyphDiagnostic(useSessionStore.getState().activeSessionId)
      }
      // Repaint + geometry re-sync (#503): pressed while staring at a pane
      // something printed over — same capture-phase + AltGr reasoning as the
      // glyph capture above.
      if (matchesShortcut(e, shortcuts.repaintTerminal) && !e.getModifierState?.('AltGraph')) {
        // Held chord auto-repeats ~16Hz; unlike the read-only capture above,
        // this one WRITES (a pty resize pair per fire) — one press, one nudge.
        if (e.repeat) return
        e.preventDefault()
        e.stopPropagation()
        // Repair the terminal the chord was pressed IN, resolved by DOM
        // ancestry: the focused pane may be the partner shell or an alt pane,
        // registered under its own key — the active session id alone would
        // nudge a hidden pty. Fall back to it only when focus is outside any
        // terminal.
        const from = (e.target as Element | null)?.closest?.('[data-terminal-session]')
        const sid = from?.getAttribute('data-terminal-session') || useSessionStore.getState().activeSessionId
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
