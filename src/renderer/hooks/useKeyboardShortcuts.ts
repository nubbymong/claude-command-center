import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { killSessionPty } from '../ptyTracker'
import { matchesShortcut, DEFAULT_SHORTCUTS } from '../utils/shortcuts'
import { sendImageToSession } from '../utils/imageTransfer'
import type { ViewType } from '../types/views'

/**
 * Global keyboard shortcuts (configurable via settings).
 */
export function useKeyboardShortcuts(
  activeSessionId: string | null,
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>,
  setView: React.Dispatch<React.SetStateAction<ViewType>>
) {
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      const shortcuts = useSettingsStore.getState().settings.keyboardShortcuts || DEFAULT_SHORTCUTS

      // Close current session
      if (matchesShortcut(e, shortcuts.closeSession)) {
        e.preventDefault()
        if (activeSessionId) {
          killSessionPty(activeSessionId)
          killSessionPty(activeSessionId + '-partner')
          useSessionStore.getState().removeSession(activeSessionId)
        }
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
      // Paste clipboard image — saves to host screenshots dir, then asks Claude
      // to fetch it via the conductor-vision MCP server (works for local + SSH).
      if (matchesShortcut(e, shortcuts.pasteImage)) {
        e.preventDefault()
        const state = useSessionStore.getState()
        if (state.activeSessionId) {
          const filePath = await window.electronAPI.clipboard.saveImage()
          if (filePath) {
            sendImageToSession(state.activeSessionId, filePath, 'I just pasted an image — please view it.')
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeSessionId])
}
