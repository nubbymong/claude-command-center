import React from 'react'
import type { TkIndexStatus } from '../../../shared/types'

interface Props {
  status: TkIndexStatus | null
}

export function IndexingState({ status }: Props) {
  const filesDone = status?.filesDone ?? 0
  const filesTotal = status?.filesTotal ?? 0
  const pct = filesTotal > 0 ? Math.round((filesDone / filesTotal) * 100) : 0
  const hasProgress = status != null && filesTotal > 0

  return (
    <div className="flex flex-col items-center justify-center py-20 px-8 text-center">
      {/* Spinner */}
      <div
        className="mb-5 rounded-full flex items-center justify-center"
        style={{
          width: 48,
          height: 48,
          background: 'var(--surface-raised)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ animation: 'spin 1.4s linear infinite' }}
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      </div>

      <div className="text-sm font-medium text-text mb-1">Indexing usage data</div>
      <div className="text-xs text-overlay1 mb-6 max-w-xs">
        This runs in the background — check back shortly.
      </div>

      {hasProgress && (
        <div className="w-64">
          {/* File count label */}
          <div className="flex justify-between text-[11px] text-overlay0 mb-1.5">
            <span>{filesDone} / {filesTotal} files</span>
            <span>{pct}%</span>
          </div>
          {/* Progress bar */}
          <div
            className="h-1.5 rounded-full overflow-hidden"
            style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
          >
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${Math.max(pct, 2)}%`,
                background: 'var(--accent)',
              }}
            />
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
