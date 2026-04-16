import React, { useState, useCallback } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import ToolbarPopup from './ToolbarPopup'

type PopupType = 'model' | 'mode' | null

const MODELS = [
  { label: 'Opus 4.6', value: 'claude-opus-4-6' },
  { label: 'Opus 4.6 1M', value: 'claude-opus-4-6-max-200k' },
  { label: 'Sonnet 4.6', value: 'claude-sonnet-4-6' },
  { label: 'Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
]

const EFFORTS = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Max', value: 'max' },
]

const PERMISSION_MODES = [
  { label: 'Ask permissions', value: 'default' },
  { label: 'Accept edits', value: 'acceptEdits' },
  { label: 'Auto', value: 'auto' },
  { label: 'Plan mode', value: 'plan' },
  { label: 'Don\'t ask', value: 'dontAsk' },
]

function shortModelName(fullName?: string): string {
  if (!fullName) return 'default'
  if (fullName.includes('opus') && fullName.includes('200k')) return 'Opus 4.6 1M'
  if (fullName.includes('opus') && fullName.includes('1m')) return 'Opus 4.6 1M'
  if (fullName.includes('opus')) return 'Opus 4.6'
  if (fullName.includes('sonnet')) return 'Sonnet 4.6'
  if (fullName.includes('haiku')) return 'Haiku 4.5'
  // Fallback: strip 'claude-' prefix and clean up
  return fullName.replace('claude-', '').replace(/-/g, ' ')
}

const MODE_LABELS: Record<string, string> = {
  default: 'Ask permissions',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  plan: 'Plan mode',
  dontAsk: 'Don\'t ask',
  bypassPermissions: 'Bypass',
}

export default function BottomToolbar() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const activeSession = useSessionStore((s) =>
    s.sessions.find((sess) => sess.id === s.activeSessionId)
  )

  const [openPopup, setOpenPopup] = useState<PopupType>(null)
  const [currentEffort, setCurrentEffort] = useState<string>('medium')
  const [currentMode, setCurrentMode] = useState<string>('acceptEdits')

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
        // Model selection
        writeToTerminal(`/model ${value}\n`)
      } else {
        // Effort selection
        setCurrentEffort(value)
        writeToTerminal(`/effort ${value}\n`)
      }
      setOpenPopup(null)
    },
    [writeToTerminal]
  )

  const handleModeSelect = useCallback(
    (_sectionIndex: number, value: string) => {
      setCurrentMode(value)
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
  const effortDisplay = currentEffort.charAt(0).toUpperCase() + currentEffort.slice(1)
  const modeDisplay = MODE_LABELS[currentMode] || currentMode

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
          {modeDisplay}
        </button>
        {openPopup === 'mode' && (
          <ToolbarPopup
            sections={[
              {
                title: 'Mode',
                shortcut: 'Shift+Ctrl+M',
                items: PERMISSION_MODES.map((m) => ({
                  ...m,
                  active: m.value === currentMode,
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
          <span className="text-overlay0">{String.fromCodePoint(0x00B7)}</span>
          <span>{effortDisplay}</span>
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
                  active:
                    (activeSession.modelName || activeSession.model || '')
                      .toLowerCase()
                      .includes(m.value.replace('claude-', '').split('-')[0]),
                })),
              },
              {
                title: 'Effort',
                shortcut: 'Shift+Ctrl+E',
                items: EFFORTS.map((e) => ({
                  ...e,
                  active: e.value === currentEffort,
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
