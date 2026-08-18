import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { killSessionPty } from '../ptyTracker'
import { requestCloseSession } from '../stores/sshCloseStore'
import { matchesShortcut, DEFAULT_SHORTCUTS } from '../utils/shortcuts'
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
  setView: (view: ViewType) => void
) {
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // The onboarding overlay covers the whole shell: a global shortcut
      // firing under it would act on invisible UI (close a session, switch
      // sessions, paste into a hidden prompt), so suppress them until the
      // flow settles. Same gate expression as App.tsx's bootGate input.
      if (deriveOnboarding(useAppMetaStore.getState().meta, {}).due) return
      const shortcuts = useSettingsStore.getState().settings.keyboardShortcuts || DEFAULT_SHORTCUTS

      // Close current session
      if (matchesShortcut(e, shortcuts.closeSession)) {
        e.preventDefault()
        // item 4: persistent SSH sessions route through the End-vs-Leave choice.
        if (activeSessionId) requestCloseSession(activeSessionId)
      }
      // Next/Previous session
      if (matchesShortcut(e, shortcuts.nextSession) || matchesShortcut(e, shortcuts.prevSession)) {
        e.preventDefault()
        const state = useSessionStore.getState()
        if (state.sessions.length > 1 && state.activeSessionId) {
          const idx = state.sessions.findIndex(s => s.id === state.activeSessionId)
          const isNext = matchesShortcut(e, shortcuts.nextSession)
          const nextIdx = isNext
            ? (idx + 1) % state.sessions.length
            : (idx - 1 + state.sessions.length) % state.sessions.length
          state.setActiveSession(state.sessions[nextIdx].id)
        }
      }
      // Ctrl+1-9: jump to session (always hardcoded)
      if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const idx = parseInt(e.key) - 1
        const state = useSessionStore.getState()
        if (idx < state.sessions.length) {
          state.setActiveSession(state.sessions[idx].id)
          setView('sessions')
        }
      }
      // Toggle sidebar
      if (matchesShortcut(e, shortcuts.toggleSidebar)) {
        e.preventDefault()
        setSidebarOpen(prev => !prev)
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
  }, [activeSessionId])
}
