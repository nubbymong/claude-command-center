import React from 'react'

interface UpdatePanelProps {
  updateAvailable: boolean
  updateVersion: string | null
  updating: boolean
  onInstallUpdate: () => void
}

export default function UpdatePanel({ updateAvailable, updateVersion, updating, onInstallUpdate }: UpdatePanelProps) {
  if (!updateAvailable) return null

  return (
    <div className="absolute bottom-2 left-2 right-2">
      <button
        onClick={onInstallUpdate}
        disabled={updating}
        className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
          updating
            ? 'bg-surface0 border-surface1 text-overlay0 cursor-wait'
            : 'bg-green/10 border-green/30 text-green hover:bg-green/20'
        }`}
      >
        {updating ? (
          <>
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
            </svg>
            <span className="text-xs font-medium">Installing...</span>
          </>
        ) : (
          <>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v7M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M3 12v1a1 1 0 001 1h8a1 1 0 001-1v-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <div className="flex-1 text-left">
              <div className="text-xs font-medium">
                Update Available{updateVersion ? ` -- v${updateVersion}` : ''}
              </div>
              <div className="text-[10px] text-green/70">Click to install &amp; restart</div>
            </div>
            <div className="w-2 h-2 rounded-full bg-green animate-pulse" />
          </>
        )}
      </button>
    </div>
  )
}
