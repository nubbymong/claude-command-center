import React, { useEffect, useState } from 'react'
import type { UnattributedSessionGroup } from '../../../shared/types'

interface Props {
  onClose: () => void
}

export function AccountAttributionWizard({ onClose }: Props) {
  const [groups, setGroups] = useState<UnattributedSessionGroup[]>([])
  const [overrides, setOverrides] = useState<Record<string, string>>({})

  useEffect(() => {
    window.electronAPI.tokenomics.listUnattributed().then(setGroups)
  }, [])

  const refresh = async () => {
    const g = await window.electronAPI.tokenomics.listUnattributed()
    setGroups(g)
    if (g.length === 0) onClose()
  }

  const confirm = async (g: UnattributedSessionGroup) => {
    const email = overrides[g.groupId] ?? g.suggestedEmail
    if (!email) return
    const r = await window.electronAPI.tokenomics.attributeSessions({
      sessionIds: g.sessionIds,
      assignment: { type: 'email', email },
    })
    if (r.ok) await refresh()
  }

  const markMixed = async (g: UnattributedSessionGroup) => {
    const r = await window.electronAPI.tokenomics.attributeSessions({
      sessionIds: g.sessionIds,
      assignment: { type: 'mixed' },
    })
    if (r.ok) await refresh()
  }

  const detectedEmails = Array.from(new Set(groups.map(g => g.suggestedEmail).filter((e): e is string => !!e)))

  if (groups.length === 0) {
    return (
      <div className="p-6 text-text">
        <h2 id="account-attribution-wizard-title" className="text-lg font-semibold mb-2">Account attribution</h2>
        <p>All sessions are attributed. Nothing to do.</p>
        <button className="mt-4 px-3 py-1.5 bg-blue text-base rounded" onClick={onClose}>Close</button>
      </div>
    )
  }

  return (
    <div className="p-6 text-text">
      <h2 id="account-attribution-wizard-title" className="text-lg font-semibold mb-2">Sessions needing account attribution ({groups.length} groups)</h2>
      <p className="text-overlay1 text-sm mb-4">
        Suggested emails are inferred from your Claude backup-file timeline. Confirm,
        override, or mark mixed if a config spanned multiple accounts.
      </p>
      <div className="space-y-3">
        {groups.map((g) => (
          <div key={g.groupId} className="border border-surface1 rounded p-3 bg-surface0">
            <div className="flex items-center gap-3 mb-2">
              <span className="font-medium">{g.groupLabel}</span>
              <span className="text-overlay1 text-sm">{g.sessionIds.length} sessions</span>
              <span className="text-overlay1 text-sm tabular-nums">${g.totalCostUsd.toFixed(2)}</span>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-overlay1">Email:</label>
              <select
                className="bg-base border border-surface1 rounded px-2 py-0.5 text-sm"
                value={overrides[g.groupId] ?? g.suggestedEmail ?? ''}
                onChange={(e) => setOverrides({ ...overrides, [g.groupId]: e.target.value })}
              >
                <option value="">{g.suggestedEmail ? `Suggested: ${g.suggestedEmail}` : 'Unknown -- pick one'}</option>
                {detectedEmails.map(e => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
              <button
                className="px-3 py-1 text-xs bg-blue text-base rounded disabled:opacity-50"
                disabled={!((overrides[g.groupId] ?? g.suggestedEmail))}
                onClick={() => confirm(g)}
              >Confirm</button>
              <button className="px-3 py-1 text-xs bg-surface1 rounded" onClick={() => markMixed(g)}>Mark mixed</button>
            </div>
          </div>
        ))}
      </div>
      <button className="mt-4 px-3 py-1.5 bg-surface1 rounded text-sm" onClick={onClose}>Close</button>
    </div>
  )
}
