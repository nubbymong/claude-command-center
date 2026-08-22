import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { requestCloseSession } from '../stores/sshCloseStore'
import { matchesShortcut, DEFAULT_SHORTCUTS } from '../utils/shortcuts'
import { captureGlyphDiagnostic } from '../utils/glyphDiagnostic'
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
      const shortcuts = useSettingsStore.getState().settings.keyboardShortcuts || DEFAULT_SHORTCUTS

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
      // Capture a glyph-corruption diagnostic (#374): the moment a user sees
      // characters go missing while backgrounds stay, this saves the always-on
      // atlas event ring + a window screenshot and reveals them to share. Fixed
      // action, not per-session, so it fires whatever the active view.
      if (matchesShortcut(e, shortcuts.captureGlyphDiagnostic)) {
        e.preventDefault()
        void captureGlyphDiagnostic(useSessionStore.getState().activeSessionId)
      }
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

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // view / openPageTabs / closePageTab / setView are read in the closure; keep
    // the listener bound to their current values so tab cycling stays correct.
  }, [activeSessionId, view, openPageTabs, closePageTab, setView, setSidebarOpen])
}
