import React, { useState } from 'react'
import type { AttributionPayload } from '../../../shared/types'

interface Props {
  sessionId: string
  detectedEmails: string[]
  onChange: () => void
}

export function EditAttributionMenu({ sessionId, detectedEmails, onChange }: Props) {
  // Copilot review on PR #31 (p9.9): surface IPC failures instead of
  // assuming success. r.ok=false now skips onChange (no stale refetch)
  // and exposes the error inline so the user knows the edit didn't land.
  const [error, setError] = useState<string | null>(null)

  const handleChange = async (value: string) => {
    if (value === '') return
    setError(null)
    const payload: AttributionPayload =
      value === '__mixed__' ? { sessionIds: [sessionId], assignment: { type: 'mixed' } } :
      value === '__clear__' ? { sessionIds: [sessionId], assignment: { type: 'clear' } } :
      { sessionIds: [sessionId], assignment: { type: 'email', email: value } }
    // Copilot review on PR #31 (p9.15): the await can reject (handler
    // throws, channel missing, preload not ready). Catch so the failure
    // surfaces as an inline error indicator instead of an unhandled
    // promise rejection that leaves the menu in a stale state.
    try {
      const r = await window.electronAPI.tokenomics.attributeSessions(payload)
      if (r.ok) {
        onChange()
      } else {
        const msg = r.error ?? 'attribution failed'
        setError(msg)
        console.error(`[EditAttributionMenu] attributeSessions failed for ${sessionId}: ${msg}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'IPC rejected'
      setError(msg)
      console.error(`[EditAttributionMenu] attributeSessions threw for ${sessionId}:`, err)
    }
  }
  return (
    <span className="inline-flex items-center gap-1">
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
      {error && (
        // Copilot review on PR #31 (p9.17.1): the message must be in the
        // accessible name, not just the title attribute (screen readers
        // often skip title). Keep the compact "!" glyph visually but expose
        // the full error via aria-label + a visually-hidden text node.
        <span className="text-red text-xs" role="alert" aria-label={`Attribution failed: ${error}`} title={error}>
          <span aria-hidden="true">!</span>
          <span className="sr-only">Attribution failed: {error}</span>
        </span>
      )}
    </span>
  )
}
