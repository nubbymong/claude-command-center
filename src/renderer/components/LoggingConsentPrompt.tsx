import React, { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'

const CLOSE_ANIM_MS = 200

/**
 * One-time first-run notice for session logging.
 *
 * Rendered when `settings.loggingConsentSeen` is falsy. The user can:
 *   - "Keep on"  -- logs stay enabled; marks consent seen.
 *   - "Turn off" -- disables logging and marks consent seen.
 *
 * The prompt closes itself via the animation then the parent (App) removes it
 * by observing loggingConsentSeen flipping to true in the store.
 */
export default function LoggingConsentPrompt() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const [entering, setEntering] = useState(false)
  const [closing, setClosing] = useState(false)
  // The close-animation timer must be cleared on unmount: the parent removes this
  // prompt as soon as loggingConsentSeen flips, which can happen before the timer
  // fires — a stale timer would call updateSettings on an unmounted component.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntering(true))
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  const save = (updates: Parameters<typeof updateSettings>[0]) => {
    if (closing) return
    setClosing(true)
    closeTimer.current = setTimeout(() => updateSettings(updates), CLOSE_ANIM_MS)
  }

  const handleKeepOn = () => save({ loggingConsentSeen: true })
  const handleTurnOff = () => save({ loggingEnabled: false, loggingConsentSeen: true })

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') handleKeepOn()
  }

  const visible = entering && !closing

  const backdropClass = [
    'fixed inset-0 z-50 flex items-end justify-end p-6 sm:items-center sm:justify-center',
    'transition-opacity duration-200 ease-out',
    visible ? 'opacity-100' : 'opacity-0',
  ].join(' ')

  const dialogClass = [
    'w-full max-w-md rounded-xl shadow-2xl flex flex-col',
    'transition-all duration-200 ease-out',
    visible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-2',
  ].join(' ')

  // Don't render at all when consent has already been seen (guard for hot-reload).
  if (settings.loggingConsentSeen) return null

  return (
    <div
      className={backdropClass}
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onKeyDown={handleKeyDown}
    >
      <div
        className={dialogClass}
        style={{
          background: 'var(--surface-raised)',
          border: '1px solid var(--border-subtle)',
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="logging-consent-heading"
      >
        {/* Header */}
        <div
          className="px-5 py-4 flex items-center gap-2"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          {/* Log-file icon */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-blue"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="8" y1="13" x2="16" y2="13" />
            <line x1="8" y1="17" x2="16" y2="17" />
            <line x1="8" y1="9" x2="10" y2="9" />
          </svg>
          <h2
            id="logging-consent-heading"
            className="text-sm font-semibold text-text"
          >
            Session logging is on
          </h2>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            CCC records each session's terminal output locally so you can search and review it.
            Logs never leave your machine.
          </p>
          <p
            className="text-xs leading-relaxed px-3 py-2.5 rounded-lg"
            style={{
              background: 'color-mix(in srgb, var(--color-yellow) 8%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-yellow) 20%, transparent)',
              color: 'var(--text-secondary)',
            }}
          >
            <strong className="text-text font-medium">Note:</strong> Logs capture full terminal
            output, which may include secrets such as API keys or tokens printed to the terminal.
          </p>
          <p className="text-xs" style={{ color: 'var(--text-muted, var(--color-overlay0))' }}>
            You can change this at any time in{' '}
            <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>
              Settings &rarr; Security
            </span>
            .
          </p>
        </div>

        {/* Actions */}
        <div
          className="px-5 py-4 flex justify-end gap-2"
          style={{ borderTop: '1px solid var(--border-subtle)' }}
        >
          <button
            onClick={handleTurnOff}
            className="px-3 py-1.5 rounded-lg text-sm transition-colors focus:outline-none focus-visible:ring-2"
            style={{
              background: 'var(--surface-overlay, var(--color-surface1))',
              color: 'var(--text-secondary)',
            }}
          >
            Turn off
          </button>
          <button
            onClick={handleKeepOn}
            autoFocus
            className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2"
            style={{
              background: 'var(--color-blue)',
              color: 'var(--color-crust)',
            }}
          >
            Keep on
          </button>
        </div>
      </div>
    </div>
  )
}
