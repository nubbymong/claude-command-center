import React, { useEffect, useState } from 'react'
import type { UnattributedSessionGroup } from '../../../shared/types'
import { AccountAttributionWizard } from './AccountAttributionWizard'

interface Props {
  dismissed: boolean
  onDismiss: () => void
}

export function WizardTrigger({ dismissed, onDismiss }: Props) {
  const [groups, setGroups] = useState<UnattributedSessionGroup[]>([])
  const [openModal, setOpenModal] = useState(false)

  useEffect(() => {
    window.electronAPI.tokenomics.listUnattributed().then(setGroups)
  }, [])

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
          onClick={() => setOpenModal(false)}
        >
          <div
            className="bg-base border border-surface1 rounded max-w-2xl w-full max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <AccountAttributionWizard
              onClose={() => {
                setOpenModal(false)
                window.electronAPI.tokenomics.listUnattributed().then(setGroups)
              }}
            />
          </div>
        </div>
      )}
    </>
  )
}
