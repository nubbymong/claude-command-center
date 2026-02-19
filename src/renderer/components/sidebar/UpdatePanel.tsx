import React from 'react'

interface UpdatePanelProps {
  updateAvailable: boolean
  updateVersion: string | null
  updating: boolean
  checking: boolean
  onCheckForUpdates: () => void
  onInstallUpdate: () => void
}

export default function UpdatePanel({ updateAvailable, updateVersion, updating, checking, onCheckForUpdates, onInstallUpdate }: UpdatePanelProps) {
  return (
    <div className="absolute bottom-2 left-2 right-2 flex flex-col gap-2">
      {updateAvailable ? (
        <>
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
                    Update Available{updateVersion ? ` — v${updateVersion}` : ''}
                  </div>
                  <div className="text-[10px] text-green/70">Click to install & restart</div>
                </div>
                <div className="w-2 h-2 rounded-full bg-green animate-pulse" />
              </>
            )}
          </button>
          {!updating && (
            <button
              onClick={onCheckForUpdates}
              disabled={checking}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1 text-[10px] text-overlay0 hover:text-subtext0 transition-colors"
              title="Re-check for newer version"
            >
              {checking ? (
                <>
                  <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
                  </svg>
                  <span>Checking...</span>
                </>
              ) : (
                <>
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                    <path d="M8 2v4M8 14v-4M8 6a2 2 0 110 4 2 2 0 010-4z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <path d="M2 8h4M14 8h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  <span>Re-check for latest</span>
                </>
              )}
            </button>
          )}
        </>
      ) : (
        <button
          onClick={onCheckForUpdates}
          disabled={checking}
          className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg border border-surface1 text-overlay0 hover:text-subtext0 hover:bg-surface0/50 hover:border-surface2 transition-colors"
        >
          {checking ? (
            <>
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
              </svg>
              <span className="text-xs">Checking...</span>
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 2v4M8 14v-4M8 6a2 2 0 110 4 2 2 0 010-4z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <path d="M2 8h4M14 8h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <span className="text-xs">Check for Updates</span>
            </>
          )}
        </button>
      )}
    </div>
  )
}
