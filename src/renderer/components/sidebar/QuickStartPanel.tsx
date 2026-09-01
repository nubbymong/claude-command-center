import React from 'react'
import { TerminalConfig } from '../../stores/configStore'
import { SessionTypeBadge, SshReattachBadge, TransportBadge } from './Badges'
import { configIsPersistent, containerNameOf, resolveTransportBadge } from './transportBadge'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../../shared/identity-colors'
import { useResolvedTheme } from '../../hooks/useThemeController'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  CODEX_OFF_LAUNCH_REASON,
  alreadyRunningLaunchCopy,
  cannotSelectCopy,
  flattenPopoverCopy,
  isMultiSpawnLaunchBlocked,
} from '../../hooks/useLaunchConfig'
import MultiSpawnControl from './MultiSpawnControl'
import { quickStartConfigs, resolveQuickStartCollapsed, runningCountLabel } from './sessionsPanelState'
import { useDetachedRemotesStore } from '../../stores/detachedRemotesStore'
import { useDetachedLivenessStore } from '../../stores/livenessStore'
import { useHostReachabilityStore } from '../../stores/hostReachability'
import { matchDetachedRemotes } from '../../utils/detachedRemotes'
import { verifiedLiveCount } from '../../utils/detachedRemotesLiveness'

interface QuickStartPanelProps {
  configs: TerminalConfig[]
  running: ReadonlyMap<string, number>
  onLaunch: (config: TerminalConfig) => void
  onContextMenu: (e: React.MouseEvent, configId: string) => void
  /** Allow Multi Spawn (phase 4) — ×N launch, blocked start, select mode. */
  onLaunchMany?: (config: TerminalConfig, n: number) => void
  onSpawnCountChange?: (config: TerminalConfig, n: number) => void
  onBlockedLaunch?: (config: TerminalConfig, anchor: HTMLElement) => void
  onBlockedSelect?: (config: TerminalConfig, anchor: HTMLElement) => void
  onPromptHoverOut?: () => void
  /** Select mode is shared with the Saved tab — one mode, one selection. */
  selectMode?: boolean
  selectedIds?: ReadonlySet<string>
  onToggleSelected?: (configId: string) => void
  onToggleSelectMode?: () => void
}

/**
 * Quick Start — the launch-only strip at the top of the Running tab (design
 * pass 2026-08-24; replaces the always-below PinnedConfigsPanel). Fed by
 * `pinned` configs. A running pin STAYS (owner revision 2026-08-24: a config
 * is a template — Start spawns another instance) and carries a count pill.
 * The header collapses, persisted in settings.
 */
export default function QuickStartPanel({
  configs,
  running,
  onLaunch,
  onContextMenu,
  onLaunchMany,
  onSpawnCountChange,
  onBlockedLaunch,
  onBlockedSelect,
  onPromptHoverOut,
  selectMode,
  selectedIds,
  onToggleSelected,
  onToggleSelectMode,
}: QuickStartPanelProps) {
  const theme = useResolvedTheme()
  const collapsed = resolveQuickStartCollapsed(useSettingsStore((s) => s.settings.quickStartCollapsed))
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const codexOff = useSettingsStore((s) => s.settings.codexEnabled === false)
  // SSH Persistent (resume liveness): amber re-attachable counts, computed per
  // item below from the registry + liveness map (subscribed once here).
  const detachedEntries = useDetachedRemotesStore((s) => s.entries)
  const livenessMap = useDetachedLivenessStore((s) => s.bySession)
  // Tier-1 host reachability: demote-only, so an entry on a host that stopped
  // answering drops out of the count (see hostReachability.ts).
  const hostReach = useHostReachabilityStore((s) => s.byHost)

  const items = quickStartConfigs(configs)
  // Nothing pinned at all: no strip, no empty state — Quick Start is opt-in
  // via the context menus and absent until used.
  if (items.length === 0) return null

  return (
    <div className="shrink-0 border-b border-surface1 pb-1.5 mb-1" data-testid="quick-start">
      {/* The header row is no longer ONE button: the Select toggle lives at its
          right end (phase 4), and a button cannot nest inside a button. The
          collapse control keeps the whole label as its hit area. */}
      <div className="w-full px-3 pt-2 pb-1 flex items-center gap-1.5">
        <button
          onClick={() => updateSettings({ quickStartCollapsed: !collapsed })}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 flex-1 min-w-0 focus-ring rounded"
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
        {onToggleSelectMode && (
          <button
            onClick={onToggleSelectMode}
            aria-pressed={!!selectMode}
            data-testid="quick-start-select-toggle"
            title={selectMode ? 'Leave select mode' : 'Select several configs to launch together'}
            /* Same V2 tokens as the Saved toolbar's Select toggle — the two
               flip the same switch and must read as the same control. */
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-[3px] text-[9px] font-semibold leading-none shrink-0 transition-colors focus-ring ${
              selectMode
                ? 'bg-[color-mix(in_srgb,var(--brand)_20%,transparent)] border-[color-mix(in_srgb,var(--brand)_45%,transparent)] text-[var(--brand)]'
                : 'bg-transparent border-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            Select
          </button>
        )}
      </div>
      {!collapsed && items.map((config) => {
        const chipColour = resolveIdentityColor(config.identityColorKey ?? bucketLegacyColorToKey(config.color), theme)
        const typeKind = config.shellOnly ? 'shell' : (config.provider ?? 'claude') === 'codex' ? 'codex' : 'claude'
        const blocked = codexOff && config.provider === 'codex'
        const liveCount = running.get(config.id) ?? 0
        // Allow Multi Spawn (phase 4): the SAME rule the config rows and the
        // launch action use — running + not Multi Spawn = one at a time.
        const multiSpawn = config.allowMultiSpawn === true
        const spawnBlocked = isMultiSpawnLaunchBlocked(config, liveCount)
        // Same rule as the config rows: the ×N control steps aside in select
        // mode and the ordinary start button takes over.
        const spawnControlShown = multiSpawn && !selectMode
        const launchCopy = alreadyRunningLaunchCopy(config.label)
        const selectCopy = cannotSelectCopy(config.label)
        const selected = !!selectedIds?.has(config.id)
        return (
          <div
            key={config.id}
            className="mx-2 my-0.5 px-2 py-1 rounded-lg border flex items-center gap-1.5 transition-colors"
            style={{
              // #462, canvas-approved 2026-08-25: identity on the BORDER ONLY
              // (the session-card 55% mix). The interior is TRANSPARENT like a
              // real non-active session card — the approved mockup's stage
              // surface matched that in dark but read too bright in light.
              borderColor: `color-mix(in srgb, ${chipColour} 55%, transparent)`,
              ...(selected ? { background: 'color-mix(in srgb, var(--brand) 8%, transparent)' } : {}),
            }}
            onContextMenu={(e) => onContextMenu(e, config.id)}
            data-testid="quick-start-item"
          >
            {/* Same far-left tick box / lock rule as the Saved rows. */}
            {selectMode && (spawnBlocked ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onBlockedSelect?.(config, e.currentTarget) }}
                onMouseEnter={(e) => onBlockedSelect?.(config, e.currentTarget)}
                onFocus={(e) => onBlockedSelect?.(config, e.currentTarget)}
                onMouseLeave={onPromptHoverOut}
                aria-label={flattenPopoverCopy(selectCopy)}
                title={flattenPopoverCopy(selectCopy)}
                data-testid="quick-start-select-lock"
                className="w-3.5 h-3.5 flex items-center justify-center shrink-0 text-[var(--text-muted)] focus-ring rounded"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                role="checkbox"
                aria-checked={selected}
                onClick={(e) => { e.stopPropagation(); onToggleSelected?.(config.id) }}
                aria-label={`${selected ? 'Deselect' : 'Select'} ${config.label}`}
                data-testid="quick-start-select-checkbox"
                className={`w-3.5 h-3.5 rounded shrink-0 flex items-center justify-center p-0 border focus-ring ${
                  selected
                    ? 'bg-[var(--brand)] border-[var(--brand)] text-white'
                    : 'bg-transparent border-[var(--border-strong)] text-transparent'
                }`}
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </button>
            ))}
            {/* Identity dot FAR LEFT, then the type badge — the same anatomy
                the Saved rows use (phase 6, signed-off replica). */}
            <span className="w-2 h-2 rounded-[3px] shrink-0" style={{ backgroundColor: chipColour }} data-testid="quick-start-identity-dot" aria-hidden />
            <SessionTypeBadge kind={typeKind} />
            <span className="text-xs font-medium truncate flex-1 text-[var(--text-primary)]">{config.label}</span>
            {liveCount > 0 && (
              <span
                className="flex items-center text-[8.5px] font-semibold text-green bg-green/15 rounded-full px-1.5 py-0.5 shrink-0"
                title={runningCountLabel(liveCount)}
                data-testid="quick-start-running-count"
              >
                {liveCount}
              </span>
            )}
            {/* Same three-way transport chip as the Saved rows (phase 6). */}
            <TransportBadge
              kind={resolveTransportBadge({
                isSsh: config.sessionType === 'ssh',
                ssh: config.sshConfig,
                persistent: configIsPersistent(config.sshConfig),
              })}
              container={containerNameOf(config.sshConfig)}
            />
            {config.sessionType === 'ssh' && <SshReattachBadge count={verifiedLiveCount(matchDetachedRemotes(detachedEntries, config), livenessMap, hostReach)} />}
            {/* A Multi Spawn pin's start button IS the ×N control — one launch
                affordance per row, never both (phase 4 / approved mockup). */}
            {spawnControlShown ? (
              <MultiSpawnControl
                label={config.label}
                count={config.multiSpawnCount}
                onLaunch={(n) => onLaunchMany?.(config, n)}
                onCountChange={(n) => onSpawnCountChange?.(config, n)}
                disabled={blocked}
                disabledReason={blocked ? CODEX_OFF_LAUNCH_REASON : undefined}
                testId="quick-start-multi-spawn"
              />
            ) : (
              <button
                onClick={
                  blocked
                    ? undefined
                    : spawnBlocked
                      ? (e) => { e.stopPropagation(); onBlockedLaunch?.(config, e.currentTarget) }
                      : () => onLaunch(config)
                }
                onMouseEnter={spawnBlocked && !blocked ? (e) => onBlockedLaunch?.(config, e.currentTarget) : undefined}
                onFocus={spawnBlocked && !blocked ? (e) => onBlockedLaunch?.(config, e.currentTarget) : undefined}
                onMouseLeave={spawnBlocked && !blocked ? onPromptHoverOut : undefined}
                disabled={blocked}
                aria-disabled={blocked || spawnBlocked}
                data-testid={spawnBlocked && !blocked ? 'quick-start-start-blocked' : 'quick-start-start'}
                className={
                  // #462: no solid brand fill — the subtle tinted language the
                  // command bar's + Add uses, sized down so the row stays short.
                  // The Multi-Spawn refusal reuses the codex-off blocked recipe
                  // so a refused start looks the same wherever it comes from.
                  blocked || spawnBlocked
                    ? 'h-5 px-2 rounded-md text-[10px] font-bold flex items-center gap-1 shrink-0 border border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--text-muted)] cursor-not-allowed'
                    : 'h-5 px-2 rounded-md text-[10px] font-bold flex items-center gap-1 shrink-0 border border-[color-mix(in_srgb,var(--brand)_50%,transparent)] bg-[color-mix(in_srgb,var(--brand)_15%,transparent)] text-[var(--brand)] hover:bg-[color-mix(in_srgb,var(--brand)_25%,transparent)] transition-colors focus-ring'
                }
                title={blocked ? CODEX_OFF_LAUNCH_REASON : spawnBlocked ? flattenPopoverCopy(launchCopy) : `Start ${config.label}`}
                aria-label={blocked ? CODEX_OFF_LAUNCH_REASON : spawnBlocked ? flattenPopoverCopy(launchCopy) : `Start ${config.label}`}
              >
                {/* Owner call 2026-08-26: glyph only — the word "Start" on every
                    pinned row read as clutter. The title/aria keep the verb. */}
                <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden><polygon points="3,1 10,6 3,11" /></svg>
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
