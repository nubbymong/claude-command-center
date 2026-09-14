import React from 'react'
import { BrandMark } from './BrandMark'
import { TerminalConfig } from '../stores/configStore'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../shared/identity-colors'
import { useResolvedTheme } from '../hooks/useThemeController'
import { useSettingsStore } from '../stores/settingsStore'
import { DEFAULT_SHORTCUTS } from '../utils/shortcuts'
import { CODEX_OFF_LAUNCH_REASON } from '../hooks/useLaunchConfig'

interface Props {
  configs: TerminalConfig[]
  onLaunch: (config: TerminalConfig) => void
  onShowAllConfigs: () => void
  onCreateConfig: () => void
}

// Context-aware centre cold-open (spec section 6). Configs exist -> invite
// launching one (pinned first, else first few) + "Show all configs". None ->
// invite creating one.
export default function StageEmptyState({ configs, onLaunch, onShowAllConfigs, onCreateConfig }: Props) {
  const theme = useResolvedTheme()
  // Shortcuts are user-rebindable; show the live bindings, not the defaults.
  const userShortcuts = useSettingsStore((s) => s.settings.keyboardShortcuts)
  const sc = { ...DEFAULT_SHORTCUTS, ...(userShortcuts || {}) }
  const codexOff = useSettingsStore((s) => s.settings.codexEnabled === false)
  const hasConfigs = configs.length > 0
  const pinned = configs.filter((c) => c.pinned)
  const launchers = (pinned.length > 0 ? pinned : configs).slice(0, 6)

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-md px-6">
        {/* The brand mark rather than the old `>_` placeholder: this is the
            first thing shown in an empty window, so it should be the product's
            own mark, matching the title bar, app icon and boot splash. */}
        <BrandMark className="w-14 h-14 mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-1 text-text">
          {hasConfigs ? 'Start a saved config' : 'AI Code Conductor'}
        </h2>
        <p className="text-sm text-subtext0 mb-5">
          {hasConfigs ? 'Pick a saved config to launch a new session.' : 'Create a saved config to get started.'}
        </p>

        {hasConfigs ? (
          <>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {launchers.map((c) => {
                const color = resolveIdentityColor(c.identityColorKey ?? bucketLegacyColorToKey(c.color), theme)
                const launchBlocked = codexOff && c.provider === 'codex'
                return (
                  <button
                    key={c.id}
                    onClick={launchBlocked ? undefined : () => onLaunch(c)}
                    disabled={launchBlocked}
                    aria-disabled={launchBlocked}
                    className={
                      launchBlocked
                        ? 'flex items-center gap-2 px-3 py-2 rounded-lg border border-surface1 opacity-50 cursor-not-allowed text-left'
                        : 'flex items-center gap-2 px-3 py-2 rounded-lg border border-surface1 hover:border-surface2 hover:bg-surface0/40 transition-colors text-left focus-ring'
                    }
                    title={launchBlocked ? CODEX_OFF_LAUNCH_REASON : `Launch ${c.label}`}
                  >
                    <span className="w-2 h-2 rounded-[2px] shrink-0" style={{ backgroundColor: color }} aria-hidden />
                    <span className="text-xs text-text truncate">{c.label}</span>
                    {launchBlocked && <span className="text-[9px] text-overlay0 shrink-0">Codex off</span>}
                  </button>
                )
              })}
            </div>
            <button
              onClick={onShowAllConfigs}
              className="text-xs text-subtext0 hover:text-text underline-offset-2 hover:underline focus-ring rounded px-1"
            >
              Show all configs
            </button>
          </>
        ) : (
          <button
            onClick={onCreateConfig}
            className="px-4 py-2 rounded-lg bg-mauve hover:bg-pink text-base text-xs font-medium transition-colors focus-ring"
          >
            Create a saved config
          </button>
        )}
        <p className="text-xs text-overlay0 mt-4">{sc.newConfig} to create, {sc.nextSession} to switch</p>
      </div>
    </div>
  )
}
