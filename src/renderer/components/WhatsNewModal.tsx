import React, { useEffect, useRef, useState } from 'react'
import { changelog, ChangelogEntry } from '../changelog'
import { useAppMetaStore } from '../stores/appMetaStore'
import { decideUpgradeFlow, entriesSince } from '../onboarding/upgrade-flow'
import { useSettingsStore } from '../stores/settingsStore'
import { WhatsNewEntries } from './WhatsNewEntries'

declare const __BUILD_TIME__: string

interface Props {
  onClose: () => void
  showAllVersions?: boolean
  /** The version the user was on before this launch, captured by the caller at
   *  boot. Everything newer than it is shown. When omitted, read from app meta
   *  at mount — correct only when nothing has stamped lastSeenVersion first. */
  sinceVersion?: string
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

// Must match the Tailwind `duration-200` transition on the backdrop + dialog.
// Single source of truth so a future tweak to one keeps the other in sync.
const CLOSE_ANIMATION_MS = 200

export default function WhatsNewModal({ onClose, showAllVersions = false, sinceVersion }: Props) {
  const latestVersion = changelog[0]
  // Everything released since the user last looked — not just the newest entry.
  // Someone coming from 2.0.0 to 2.1.0 skipped fourteen releases, and showing
  // them one of those and calling it "what's new" is how the modal came to be
  // ignored.
  //
  // Captured ONCE, in a lazy initial state, because closing the modal stamps
  // lastSeenVersion to the current build: read it on any later render and the
  // list collapses to nothing underneath the user mid-read. The caller passes
  // the boot-time value where it can, for the same reason one step earlier.
  const [versionsToShow] = useState<ChangelogEntry[]>(() => {
    if (showAllVersions) return changelog
    const from = sinceVersion ?? useAppMetaStore.getState().meta.lastSeenVersion
    const since = entriesSince(changelog, from, latestVersion.version)
    // A first install, or a stored version newer than this build, leaves the
    // range empty — fall back to the newest entry so the modal is never blank.
    return since.length > 0 ? since : [latestVersion]
  })
  // Animation state: `entering` false on mount → true after one frame
  // fades the dialog in. `closing` flips true when the user dismisses,
  // giving the fade-out CLOSE_ANIMATION_MS before we call the parent's
  // onClose. Must match the CSS transition duration (duration-200) below;
  // a mismatch truncates the fade. Derived from the shared constant so
  // they can't drift.
  const [entering, setEntering] = useState(false)
  const [closing, setClosing] = useState(false)
  // Track the dismiss timer in a ref so we can cancel it on unmount. Without
  // this, unmounting mid-fade (e.g. parent tears the modal down for another
  // reason before the timeout elapses) would still call onClose late and
  // push state into a parent that may no longer expect it.
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
    }, CLOSE_ANIMATION_MS)
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
          <WhatsNewEntries entries={versionsToShow} />
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

/**
 * Should this launch show What's New?
 *
 * Now one branch of a single decision (see `decideUpgradeFlow`) rather than its
 * own rule. The old one was `lastSeen !== changelog[0].version`, which treated
 * a FIRST INSTALL as "everything is new to you" and opened a wall of release
 * notes in front of someone who had not seen the app yet — they get the tour
 * instead. It also compared strings, so a stored `v2.1.0` re-fired the modal on
 * every single launch.
 */
export function shouldShowWhatsNew(): boolean {
  try {
    const currentVersion = changelog[0]?.version
    if (!currentVersion) return false
    return decideUpgradeFlow({
      lastSeenVersion: useAppMetaStore.getState().meta.lastSeenVersion,
      currentVersion,
      channel: useSettingsStore.getState().settings.updateChannel,
    }).showWhatsNew
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
