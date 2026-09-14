import React, { useEffect, useRef, useState } from 'react'
import { changelog, ChangelogEntry } from '../changelog'
import { useAppMetaStore } from '../stores/appMetaStore'
import { entriesSince } from '../onboarding/upgrade-flow'
import { WhatsNewEntries } from './WhatsNewEntries'
import { DialogOverlay, DialogPanel, DialogHeader, DialogBody, DialogFooter, DialogButton } from './ui/Dialog'

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

  return (
    <DialogOverlay className={`transition-opacity duration-200 ease-out ${visible ? 'opacity-100' : 'opacity-0'}`}>
      <DialogPanel
        labelledBy="whats-new-title"
        width="w-full"
        style={{ maxWidth: '32rem', maxHeight: '80vh' }}
        className={`transition-all duration-200 ease-out ${visible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-2'}`}
      >
        <DialogHeader
          titleId="whats-new-title"
          title="What's New"
          subtitle={<span style={{ color: 'var(--text-muted)' }}>Build: {formatBuildTime(__BUILD_TIME__)}</span>}
          onClose={dismiss}
        />

        {/* Content */}
        <DialogBody className="flex-1">
          <WhatsNewEntries entries={versionsToShow} />
        </DialogBody>

        {/* Footer */}
        <DialogFooter
          left={
            !showAllVersions && changelog.length > 1 ? (
              <DialogButton
                variant="ghost"
                onClick={() => {/* Could expand to show all */}}
                style={{ color: 'var(--text-muted)' }}
              >
                {changelog.length - 1} previous version{changelog.length > 2 ? 's' : ''}
              </DialogButton>
            ) : undefined
          }
        >
          <DialogButton variant="primary" onClick={dismiss}>
            Got it
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}

// `shouldShowWhatsNew` / `markWhatsNewSeen` used to live here, which made
// `settle.ts` import a React component in order to stamp a version. They now
// sit in `onboarding/whats-new-gate.ts`, keyed on the version the build
// actually IS rather than on the newest changelog entry authored — see the
// header there.
//
// This component is no longer a boot surface. The full-screen harness is the
// single delivery for release notes (user call 2026-08-21); what is left here
// is the on-demand reader reachable from Settings, where the user asked for it
// and a scrollable list is the right shape.
