import React from 'react'
import { TerminalConfig, useConfigStore } from '../../stores/configStore'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../../shared/identity-colors'
import { useResolvedTheme } from '../../hooks/useThemeController'
import { useSettingsStore } from '../../stores/settingsStore'
import { CODEX_OFF_LAUNCH_REASON } from '../../hooks/useLaunchConfig'

interface PinnedConfigsPanelProps {
  configs: TerminalConfig[]
  onLaunch: (config: TerminalConfig) => void
}

export default function PinnedConfigsPanel({ configs, onLaunch }: PinnedConfigsPanelProps) {
  const togglePinned = useConfigStore((s) => s.togglePinned)
  const theme = useResolvedTheme()
  const codexOff = useSettingsStore((s) => s.settings.codexEnabled === false)

  if (configs.length === 0) return null

  return (
    <div className="px-2 pb-1 space-y-0.5">
      {configs.map((config) => {
        const dotColour = resolveIdentityColor(config.identityColorKey ?? bucketLegacyColorToKey(config.color), theme)
        const launchBlocked = codexOff && config.provider === 'codex'
        return (
        <div
          key={config.id}
          className="flex items-center gap-2 rounded-md py-1 px-2 group transition-colors hover:bg-surface0/40"
        >
          <div className="w-2 h-2 rounded-[2px] shrink-0" style={{ backgroundColor: dotColour }} />
          <span className={`text-xs truncate flex-1 ${launchBlocked ? 'text-overlay0' : 'text-text'}`}>{config.label}</span>
          {launchBlocked && (
            <span className="text-[9px] text-overlay0 border border-surface1 rounded-full px-1.5 shrink-0" title={CODEX_OFF_LAUNCH_REASON}>
              Codex off
            </span>
          )}
          <button
            onClick={launchBlocked ? undefined : () => onLaunch(config)}
            disabled={launchBlocked}
            aria-disabled={launchBlocked}
            className={
              launchBlocked
                ? 'p-0.5 rounded text-overlay0/50 cursor-not-allowed opacity-0 group-hover:opacity-100 transition-opacity'
                : 'p-0.5 rounded hover:bg-surface1 text-overlay1 hover:text-text opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity focus-ring'
            }
            title={launchBlocked ? CODEX_OFF_LAUNCH_REASON : 'Launch'}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 8,5 2,9" /></svg>
          </button>
          <button
            onClick={() => togglePinned(config.id)}
            className="p-0.5 rounded hover:bg-surface1 text-overlay0 hover:text-text opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity focus-ring"
            title="Unpin"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
          </button>
        </div>
        )
      })}
    </div>
  )
}
