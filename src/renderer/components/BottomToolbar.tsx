import React, { useState, useCallback } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import ToolbarPopup from './ToolbarPopup'
import {
  MODELS,
  EFFORTS,
  PERMISSION_MODES,
  shortModelName,
  isModelActive,
} from '../lib/claude-cli-options'

type PopupType = 'model' | 'mode' | null

export default function BottomToolbar() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const activeSession = useSessionStore((s) =>
    s.sessions.find((sess) => sess.id === s.activeSessionId)
  )

  // Effort and permission mode aren't part of Claude Code's statusline JSON
  // schema, so we have no authoritative way to display the current value.
  // Track the last-clicked pick in memory only, used for the dropdown
  // checkmark — never shown as an always-visible label. Typing `/effort` or
  // `/permission-mode` directly in the terminal won't update this, and that's
  // OK: we don't lie about a current value we can't verify.
  const [openPopup, setOpenPopup] = useState<PopupType>(null)
  const [lastEffort, setLastEffort] = useState<string | null>(null)
  const [lastMode, setLastMode] = useState<string | null>(null)

  const writeToTerminal = useCallback(
    (text: string) => {
      if (!activeSessionId) return
      window.electronAPI.pty.write(activeSessionId, text)
    },
    [activeSessionId]
  )

  const handleModelSelect = useCallback(
    (_sectionIndex: number, value: string) => {
      if (_sectionIndex === 0) {
        writeToTerminal(`/model ${value}\n`)
      } else {
        setLastEffort(value)
        writeToTerminal(`/effort ${value}\n`)
      }
      setOpenPopup(null)
    },
    [writeToTerminal]
  )

  const handleModeSelect = useCallback(
    (_sectionIndex: number, value: string) => {
      setLastMode(value)
      writeToTerminal(`/permission-mode ${value}\n`)
      setOpenPopup(null)
    },
    [writeToTerminal]
  )

  const handleClipboardPaste = useCallback(async () => {
    if (!activeSessionId) return
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        writeToTerminal(text)
      }
    } catch {
      // clipboard access denied
    }
  }, [activeSessionId, writeToTerminal])

  if (!activeSession) return null

  const modelDisplay = shortModelName(activeSession.modelName || activeSession.model)

  return (
    <div
      className="flex items-center gap-1 px-2 shrink-0 text-xs"
      style={{
        background: 'var(--color-crust)',
        borderTop: '1px solid var(--color-surface0)',
        height: 28,
        whiteSpace: 'nowrap',
      }}
    >
      {/* Permission mode chip */}
      <div className="relative">
        <button
          onClick={() => setOpenPopup(openPopup === 'mode' ? null : 'mode')}
          className="flex items-center gap-1.5 px-2 py-1 rounded transition-colors"
          style={{
            color: 'var(--color-subtext0)',
            background: openPopup === 'mode' ? 'var(--color-surface0)' : 'transparent',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--color-surface0)'
          }}
          onMouseLeave={(e) => {
            if (openPopup !== 'mode')
              e.currentTarget.style.background = 'transparent'
          }}
        >
          Mode
        </button>
        {openPopup === 'mode' && (
          <ToolbarPopup
            sections={[
              {
                title: 'Mode',
                shortcut: 'Shift+Ctrl+M',
                items: PERMISSION_MODES.map((m) => ({
                  ...m,
                  active: m.value === lastMode,
                })),
              },
            ]}
            onSelect={handleModeSelect}
            onClose={() => setOpenPopup(null)}
          />
        )}
      </div>

      {/* Clipboard paste */}
      <button
        onClick={handleClipboardPaste}
        className="px-1.5 py-1 rounded transition-colors text-overlay0 hover:text-subtext0"
        style={{ fontSize: 13 }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--color-surface0)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent'
        }}
        title="Paste from clipboard"
      >
        {String.fromCodePoint(0x2398)}
      </button>

      <div className="flex-1" />

      {/* Model + Effort chip */}
      <div className="relative">
        <button
          onClick={() => setOpenPopup(openPopup === 'model' ? null : 'model')}
          className="flex items-center gap-1.5 px-2 py-1 rounded transition-colors"
          style={{
            color: 'var(--color-subtext0)',
            background: openPopup === 'model' ? 'var(--color-surface0)' : 'transparent',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--color-surface0)'
          }}
          onMouseLeave={(e) => {
            if (openPopup !== 'model')
              e.currentTarget.style.background = 'transparent'
          }}
        >
          <span className="text-blue">{modelDisplay}</span>
        </button>
        {openPopup === 'model' && (
          <ToolbarPopup
            alignRight
            sections={[
              {
                title: 'Models',
                shortcut: 'Shift+Ctrl+I',
                items: MODELS.map((m) => ({
                  ...m,
                  active: isModelActive(
                    m.value,
                    activeSession.modelName || activeSession.model || '',
                  ),
                })),
              },
              {
                title: 'Effort',
                shortcut: 'Shift+Ctrl+E',
                items: EFFORTS.map((e) => ({
                  ...e,
                  active: e.value === lastEffort,
                })),
              },
            ]}
            onSelect={handleModelSelect}
            onClose={() => setOpenPopup(null)}
          />
        )}
      </div>
    </div>
  )
}
