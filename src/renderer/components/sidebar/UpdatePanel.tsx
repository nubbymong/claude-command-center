import React from 'react'
import { useSettingsStore } from '../../stores/settingsStore'

interface UpdatePanelProps {
  updateAvailable: boolean
  updateVersion: string | null
  updating: boolean
  checking: boolean
  onCheckForUpdates: () => void
  onInstallUpdate: () => void
}

type Channel = 'stable' | 'beta' | 'dev'

const CHANNEL_LABELS: Record<Channel, string> = {
  stable: 'Stable',
  beta: 'Beta',
  dev: 'Dev',
}

const CHANNEL_DESCRIPTIONS: Record<Channel, string> = {
  stable: 'Production releases only',
  beta: 'Stable + pre-release builds',
  dev: 'All builds including experimental',
}

const CHANNEL_COLORS: Record<Channel, string> = {
  stable: 'text-green border-green/40 bg-green/5',
  beta: 'text-yellow border-yellow/40 bg-yellow/5',
  dev: 'text-mauve border-mauve/40 bg-mauve/5',
}

function ChannelSelector({ onChannelChange }: { onChannelChange: () => void }) {
  const channel = useSettingsStore((s) => s.settings.updateChannel) as Channel
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [open, setOpen] = React.useState(false)

  const handlePick = async (next: Channel) => {
    setOpen(false)
    // Wait for the IPC save to complete before re-checking. Otherwise the
    // main process can read the old channel from disk and return stale data.
    await updateSettings({ updateChannel: next })
    onChannelChange()
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-medium uppercase tracking-wider transition-colors ${CHANNEL_COLORS[channel]}`}
        title={`Update channel: ${CHANNEL_LABELS[channel]} — ${CHANNEL_DESCRIPTIONS[channel]}`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-current" />
        {CHANNEL_LABELS[channel]}
        <svg width="8" height="8" viewBox="0 0 8 8" className="opacity-60">
          <path d="M1 3l3 3 3-3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && (
        <>
          {/* Backdrop to close on outside click */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 mb-1 z-20 bg-mantle border border-surface1 rounded-lg shadow-xl py-1 min-w-[200px]">
            {(['stable', 'beta', 'dev'] as Channel[]).map((c) => (
              <button
                key={c}
                onClick={() => handlePick(c)}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface0 transition-colors flex items-start gap-2 ${
                  channel === c ? 'bg-surface0/60' : ''
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full mt-1 shrink-0 ${
                  c === 'stable' ? 'bg-green' : c === 'beta' ? 'bg-yellow' : 'bg-mauve'
                }`} />
                <div className="flex-1">
                  <div className={`font-medium ${channel === c ? 'text-text' : 'text-subtext0'}`}>
                    {CHANNEL_LABELS[c]}
                    {channel === c && <span className="ml-2 text-[9px] text-overlay0">current</span>}
                  </div>
                  <div className="text-[10px] text-overlay0 leading-tight mt-0.5">
                    {CHANNEL_DESCRIPTIONS[c]}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
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
            <div className="flex items-center gap-1.5">
              <ChannelSelector onChannelChange={onCheckForUpdates} />
              <button
                onClick={onCheckForUpdates}
                disabled={checking}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1 text-[10px] text-overlay0 hover:text-subtext0 transition-colors"
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
                  <span>Re-check for latest</span>
                )}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center gap-1.5">
          <ChannelSelector onChannelChange={onCheckForUpdates} />
          <button
            onClick={onCheckForUpdates}
            disabled={checking}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg border border-surface1 text-overlay0 hover:text-subtext0 hover:bg-surface0/50 hover:border-surface2 transition-colors"
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
        </div>
      )}
    </div>
  )
}
