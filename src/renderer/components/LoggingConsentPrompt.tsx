import React, { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import {
  DialogOverlay,
  DialogPanel,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogButton,
  DialogCallout,
} from './ui/Dialog'

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

  // Don't render at all when consent has already been seen (guard for hot-reload).
  if (settings.loggingConsentSeen) return null

  return (
    <DialogOverlay
      dim={0.55}
      className={`transition-opacity duration-200 ease-out ${visible ? 'opacity-100' : 'opacity-0'}`}
      onKeyDown={handleKeyDown}
    >
      <DialogPanel
        labelledBy="logging-consent-heading"
        width="w-full"
        style={{ maxWidth: '28rem' }}
        className={`transition-all duration-200 ease-out ${visible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-2'}`}
      >
        <DialogHeader
          titleId="logging-consent-heading"
          title="Conversation indexing is on"
          glyph={
            /* Log-file icon */
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" y1="13" x2="16" y2="13" />
              <line x1="8" y1="17" x2="16" y2="17" />
              <line x1="8" y1="9" x2="10" y2="9" />
            </svg>
          }
        />

        {/* Body */}
        <DialogBody className="space-y-3">
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            CCC indexes Claude's own conversation transcripts so you can browse and review them here.
            Your conversations always live in Claude's own files (
            <code className="text-xs font-mono">~/.claude/projects</code>
            ) — CCC only reads them to build a local index.
          </p>
          <DialogCallout tone="warning">
            <strong className="font-medium" style={{ color: 'var(--text-primary)' }}>Note:</strong> Transcripts may include
            sensitive content such as API keys or tokens if you printed them in your session.
          </DialogCallout>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            You can change this at any time in{' '}
            <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>
              Settings &rarr; Security
            </span>
            . Turning it off only stops CCC from indexing; it does not delete or move your conversations.
          </p>
        </DialogBody>

        {/* Actions */}
        <DialogFooter>
          <DialogButton size="md" onClick={handleTurnOff}>
            Skip indexing
          </DialogButton>
          <DialogButton size="md" variant="primary" onClick={handleKeepOn} autoFocus>
            Keep indexing
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
