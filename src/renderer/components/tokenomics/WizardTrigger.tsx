import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { UnattributedSessionGroup } from '../../../shared/types'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { AccountAttributionWizard } from './AccountAttributionWizard'

interface Props {
  dismissed: boolean
  onDismiss: () => void
}

export function WizardTrigger({ dismissed, onDismiss }: Props) {
  const [groups, setGroups] = useState<UnattributedSessionGroup[]>([])
  const [openModal, setOpenModal] = useState(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Copilot review on PR #31 (p9.14): IPC calls can reject -- listen for
  // failures so an exception in the main-side handler does not become an
  // unhandled promise rejection that leaves the banner state unsettled.
  useEffect(() => {
    window.electronAPI.tokenomics
      .listUnattributed()
      .then(setGroups)
      .catch((err) => {
        console.error('[WizardTrigger] listUnattributed failed:', err)
        setGroups([])
      })
  }, [])

  // Copilot review on PR #31 (p9.9): close-on-escape + focus-trap via
  // the shared hook used by OnboardingModal and the SessionGitHubConfig
  // dialog. Keyboard users can't tab back into the underlying page
  // while the wizard is open.
  const closeAndRefresh = useCallback(() => {
    setOpenModal(false)
    window.electronAPI.tokenomics
      .listUnattributed()
      .then(setGroups)
      .catch((err) => {
        console.error('[WizardTrigger] listUnattributed failed:', err)
        setGroups([])
      })
  }, [])
  useFocusTrap(dialogRef, openModal, closeAndRefresh)

  if (dismissed || groups.length === 0) return null

  return (
    <>
      <div className="flex items-center gap-3 bg-yellow/15 border border-yellow/30 rounded p-3 mb-4">
        <span className="text-text">Sessions needing account attribution: {groups.length} groups</span>
        <button
          className="px-3 py-1 text-xs bg-blue text-base rounded"
          onClick={() => setOpenModal(true)}
        >
          Run wizard
        </button>
        <button
          className="ml-auto px-2 py-1 text-xs text-overlay1"
          onClick={onDismiss}
        >
          Don't show again
        </button>
      </div>
      {openModal && (
        <div
          className="fixed inset-0 z-50 bg-base/80 flex items-center justify-center"
        >
          {/*
            Copilot review on PR #31 (p9.9): no backdrop click-to-close --
            Ctrl+C generates a click in some terminals which would dismiss
            the wizard mid-edit. Use Escape (wired via useFocusTrap above)
            or the explicit Close button inside the wizard.
          */}
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-attribution-wizard-title"
            className="bg-base border border-surface1 rounded max-w-2xl w-full max-h-[80vh] overflow-y-auto"
          >
            <AccountAttributionWizard onClose={closeAndRefresh} />
          </div>
        </div>
      )}
    </>
  )
}
