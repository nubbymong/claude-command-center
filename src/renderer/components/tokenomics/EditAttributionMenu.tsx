import React from 'react'

interface Props {
  sessionId: string
  detectedEmails: string[]
  onChange: () => void
}

export function EditAttributionMenu({ sessionId, detectedEmails, onChange }: Props) {
  const handleChange = async (value: string) => {
    if (value === '') return
    let payload: any
    if (value === '__mixed__') payload = { sessionIds: [sessionId], assignment: { type: 'mixed' } }
    else if (value === '__clear__') payload = { sessionIds: [sessionId], assignment: { type: 'clear' } }
    else payload = { sessionIds: [sessionId], assignment: { type: 'email', email: value } }
    await window.electronAPI.tokenomics.attributeSessions(payload)
    onChange()
  }
  return (
    <select
      className="bg-surface0 text-text text-xs rounded px-1 py-0.5 border border-surface1"
      value=""
      onChange={(e) => handleChange(e.target.value)}
      aria-label={`Edit attribution for session ${sessionId}`}
    >
      <option value="">Edit...</option>
      {detectedEmails.map(e => <option key={e} value={e}>{e}</option>)}
      <option value="__mixed__">Mark mixed</option>
      <option value="__clear__">Clear</option>
    </select>
  )
}
