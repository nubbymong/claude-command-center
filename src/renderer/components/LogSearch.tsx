import React from 'react'

export interface SearchHitRow {
  sessionId: string
  eventId: number
  seq: number
  ts: number
  snippet?: string
}

interface Props {
  hits: SearchHitRow[]
  labelForSession: (sessionId: string) => string
  accountForSession: (sessionId: string) => string | null
  onSelectHit: (hit: SearchHitRow) => void
}

/** Ranked FTS hit list shown in the right pane while a query is present. */
export default function LogSearch({ hits, labelForSession, accountForSession, onSelectHit }: Props) {
  if (hits.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-stage">
        <p className="text-xs text-overlay0">No matches.</p>
      </div>
    )
  }
  return (
    <div className="flex-1 overflow-y-auto bg-surface-stage p-2 space-y-1">
      {hits.map((h) => (
        <button
          key={`${h.sessionId}:${h.eventId}`}
          onClick={() => onSelectHit(h)}
          className="w-full text-left rounded-md px-3 py-2 bg-surface0/40 hover:bg-surface0/70 border border-transparent hover:border-surface1 transition-colors"
        >
          <div className="flex items-center gap-2 text-[10px] text-overlay0">
            <span className="text-text font-medium truncate">{labelForSession(h.sessionId)}</span>
            <span>{String.fromCodePoint(0x00B7)}</span>
            <span className="tabular-nums">{new Date(h.ts).toLocaleString()}</span>
            {accountForSession(h.sessionId) && (
              <>
                <span>{String.fromCodePoint(0x00B7)}</span>
                <span className="truncate">{accountForSession(h.sessionId)}</span>
              </>
            )}
          </div>
          {h.snippet && <div className="text-[11px] text-subtext0 font-mono truncate mt-0.5">{h.snippet}</div>}
        </button>
      ))}
    </div>
  )
}
