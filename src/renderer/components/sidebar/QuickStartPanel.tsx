import React from 'react'
import { TerminalConfig } from '../../stores/configStore'
import { SessionTypeBadge, SshBadge } from './Badges'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../../shared/identity-colors'
import { useResolvedTheme } from '../../hooks/useThemeController'
import { useSettingsStore } from '../../stores/settingsStore'
import { CODEX_OFF_LAUNCH_REASON } from '../../hooks/useLaunchConfig'
import { quickStartConfigs, resolveQuickStartCollapsed, runningCountLabel } from './sessionsPanelState'

interface QuickStartPanelProps {
  configs: TerminalConfig[]
  running: ReadonlyMap<string, number>
  onLaunch: (config: TerminalConfig) => void
  onContextMenu: (e: React.MouseEvent, configId: string) => void
}

/**
 * Quick Start — the launch-only strip at the top of the Running tab (design
 * pass 2026-08-24; replaces the always-below PinnedConfigsPanel). Fed by
 * `pinned` configs. A running pin STAYS (owner revision 2026-08-24: a config
 * is a template — Start spawns another instance) and carries a count pill.
 * The header collapses, persisted in settings.
 */
export default function QuickStartPanel({ configs, running, onLaunch, onContextMenu }: QuickStartPanelProps) {
  const theme = useResolvedTheme()
  const collapsed = resolveQuickStartCollapsed(useSettingsStore((s) => s.settings.quickStartCollapsed))
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const codexOff = useSettingsStore((s) => s.settings.codexEnabled === false)

  const items = quickStartConfigs(configs)
  // Nothing pinned at all: no strip, no empty state — Quick Start is opt-in
  // via the context menus and absent until used.
  if (items.length === 0) return null

  return (
    <div className="shrink-0 border-b border-surface1 pb-1.5 mb-1" data-testid="quick-start">
      <button
        onClick={() => updateSettings({ quickStartCollapsed: !collapsed })}
        aria-expanded={!collapsed}
        className="w-full px-3 pt-2 pb-1 flex items-center gap-1.5 focus-ring rounded"
        title={collapsed ? 'Expand Quick Start' : 'Collapse Quick Start'}
        data-testid="quick-start-header"
      >
        <svg
          width="9" height="9" viewBox="0 0 10 10" fill="currentColor"
          className="text-overlay0 transition-transform"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
          aria-hidden
        >
          <polygon points="2,2 8,5 2,8" />
        </svg>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" className="text-yellow" aria-hidden>
          <path d="M13 2L3 14h7l-1 8 11-13h-8z" />
        </svg>
        <span className="text-[10.5px] font-bold uppercase tracking-wider text-yellow">Quick Start</span>
        <span className="text-[10px] text-overlay0">{items.length}</span>
      </button>
      {!collapsed && items.map((config) => {
        const chipColour = resolveIdentityColor(config.identityColorKey ?? bucketLegacyColorToKey(config.color), theme)
        const typeKind = config.shellOnly ? 'shell' : (config.provider ?? 'claude') === 'codex' ? 'codex' : 'claude'
        const blocked = codexOff && config.provider === 'codex'
        const liveCount = running.get(config.id) ?? 0
        return (
          <div
            key={config.id}
            className="mx-2 my-0.5 px-2 py-1.5 rounded-lg border flex items-center gap-1.5 transition-colors"
            style={{
              borderColor: 'color-mix(in srgb, var(--brand) 40%, var(--color-surface1))',
              background: 'color-mix(in srgb, var(--brand) 9%, var(--color-surface0))',
            }}
            onContextMenu={(e) => onContextMenu(e, config.id)}
            data-testid="quick-start-item"
          >
            <SessionTypeBadge kind={typeKind} />
            <span className="w-2 h-2 rounded-[3px] shrink-0" style={{ backgroundColor: chipColour }} aria-hidden />
            <span className="text-xs font-medium truncate flex-1 text-text">{config.label}</span>
            {liveCount > 0 && (
              <span
                className="flex items-center gap-1 text-[8.5px] font-semibold uppercase tracking-wide text-green bg-green/15 rounded-full px-1.5 py-0.5 shrink-0"
                title={runningCountLabel(liveCount)}
                data-testid="quick-start-running-count"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-green" aria-hidden />
                {liveCount}
              </span>
            )}
            {config.sessionType === 'ssh' && <SshBadge />}
            <button
              onClick={blocked ? undefined : () => onLaunch(config)}
              disabled={blocked}
              aria-disabled={blocked}
              className={
                blocked
                  ? 'h-6 px-2 rounded-md text-[10px] font-bold flex items-center gap-1 shrink-0 bg-surface1 text-overlay0/60 cursor-not-allowed'
                  : 'h-6 px-2 rounded-md text-[10px] font-bold flex items-center gap-1 shrink-0 bg-blue text-crust hover:bg-blue/90 transition-colors focus-ring'
              }
              title={blocked ? CODEX_OFF_LAUNCH_REASON : `Start ${config.label}`}
            >
              <svg width="9" height="9" viewBox="0 0 12 12" fill="currentColor" aria-hidden><polygon points="3,1 10,6 3,11" /></svg>
              Start
            </button>
          </div>
        )
      })}
    </div>
  )
}
