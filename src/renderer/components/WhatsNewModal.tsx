import React, { useEffect, useRef, useState } from 'react'
import { changelog, ChangelogEntry } from '../changelog'

declare const __BUILD_TIME__: string

interface Props {
  onClose: () => void
  showAllVersions?: boolean
}

const TYPE_COLORS = {
  feature: 'text-green',
  fix: 'text-red',
  improvement: 'text-blue',
}

const TYPE_LABELS = {
  feature: 'New',
  fix: 'Fix',
  improvement: 'Improved',
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatBuildTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
           ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

function VersionSection({ entry }: { entry: ChangelogEntry }) {
  return (
    <div className="mb-6 last:mb-0">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-lg font-bold text-text">v{entry.version}</span>
        <span className="text-xs text-overlay0">{formatDate(entry.date)}</span>
      </div>
      {entry.highlights && (
        <p className="text-sm text-subtext1 mb-3 italic">{entry.highlights}</p>
      )}
      <ul className="space-y-1.5">
        {entry.changes.map((change, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span className={`${TYPE_COLORS[change.type]} font-medium shrink-0 w-16`}>
              {TYPE_LABELS[change.type]}
            </span>
            <span className="text-subtext0">{change.description}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function WhatsNewModal({ onClose, showAllVersions = false }: Props) {
  const latestVersion = changelog[0]
  const versionsToShow = showAllVersions ? changelog : [latestVersion]
  // Animation state: `entering` false on mount → true after one frame
  // fades the dialog in. `closing` flips true when the user dismisses,
  // giving the fade-out 180ms before we actually call the parent onClose.
  // Keeps the transition between first-launch modals from feeling abrupt.
  const [entering, setEntering] = useState(false)
  const [closing, setClosing] = useState(false)
  // Track the dismiss timer in a ref so we can cancel it on unmount. Without
  // this, unmounting mid-fade (e.g. parent tears the modal down for another
  // reason before the 180ms elapses) would still call onClose late and push
  // state into a parent that may no longer expect it.
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const t = requestAnimationFrame(() => setEntering(true))
    return () => cancelAnimationFrame(t)
  }, [])

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }
  }, [])

  const dismiss = () => {
    if (closing) return
    setClosing(true)
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      onClose()
    }, 180)
  }

  const visible = entering && !closing
  const backdropClass = `fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 transition-opacity duration-200 ease-out ${visible ? 'opacity-100' : 'opacity-0'}`
  const dialogClass = `bg-mantle rounded-lg shadow-2xl border border-surface0 w-full max-w-lg max-h-[80vh] flex flex-col transition-all duration-200 ease-out ${visible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-2'}`

  return (
    <div className={backdropClass}>
      <div className={dialogClass}>
        {/* Header */}
        <div className="p-4 border-b border-surface0">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-text">What's New</h2>
            <button
              onClick={dismiss}
              className="text-overlay0 hover:text-text transition-colors text-xl leading-none"
            >
              &times;
            </button>
          </div>
          <p className="text-xs text-overlay0 mt-1">
            Build: {formatBuildTime(__BUILD_TIME__)}
          </p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {versionsToShow.map((entry) => (
            <VersionSection key={entry.version} entry={entry} />
          ))}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-surface0 flex justify-between items-center">
          {!showAllVersions && changelog.length > 1 && (
            <button
              onClick={() => {/* Could expand to show all */}}
              className="text-xs text-overlay0 hover:text-subtext0 transition-colors"
            >
              {changelog.length - 1} previous version{changelog.length > 2 ? 's' : ''}
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={dismiss}
            className="px-4 py-2 bg-blue text-base rounded font-medium hover:bg-blue/80 transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}

import { useAppMetaStore } from '../stores/appMetaStore'

export function shouldShowWhatsNew(): boolean {
  try {
    const lastSeen = useAppMetaStore.getState().meta.lastSeenVersion
    if (!lastSeen) return true // First launch
    const currentVersion = changelog[0]?.version
    return lastSeen !== currentVersion
  } catch {
    return false
  }
}

export function markWhatsNewSeen(): void {
  try {
    const currentVersion = changelog[0]?.version
    if (currentVersion) {
      useAppMetaStore.getState().update({ lastSeenVersion: currentVersion })
    }
  } catch {
    // Ignore storage errors
  }
}
