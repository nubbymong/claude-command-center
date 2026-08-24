import React from 'react'
import { TerminalConfig } from '../../stores/configStore'
import { SessionTypeBadge, SshBadge } from './Badges'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../../shared/identity-colors'
import { useResolvedTheme } from '../../hooks/useThemeController'
import { useSettingsStore } from '../../stores/settingsStore'
import { CODEX_OFF_LAUNCH_REASON } from '../../hooks/useLaunchConfig'
import { DELETE_WHILE_RUNNING_REASON, runningCountLabel } from './sessionsPanelState'

interface ConfigRowProps {
  config: TerminalConfig
  onLaunch: () => void
  onEdit: () => void
  onDelete: () => void
  onPin?: () => void
  onContextMenu: (e: React.MouseEvent) => void
  /** How many live sessions this config has (owner revision 2026-08-24: a
   *  config is a template — it may relaunch while running, so the row shows a
   *  COUNT pill instead of locking; clicking the pill opens the session). */
  runningCount?: number
  onOpenSession?: () => void
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  isDragOver?: boolean
}

export default function ConfigRow({ config, onLaunch, onEdit, onDelete, onPin, onContextMenu, runningCount = 0, onOpenSession, draggable, onDragStart, onDragOver, onDrop, onDragEnd, isDragOver }: ConfigRowProps) {
  // Icon order is the design's identity split: the session TYPE leads the row
  // (the prominent mark — Claude / Codex / Shell), and the config's own colour
  // is a small chip beside the name. The big coloured square read as an
  // account icon; it is gone.
  const theme = useResolvedTheme()
  const chipColour = resolveIdentityColor(config.identityColorKey ?? bucketLegacyColorToKey(config.color), theme)
  // Codex configs can't launch while the Codex master is off (user decision
  // 2026-07-02): mark the row disabled with the reason instead of a dead play
  // button. Reactive so flipping the master in Settings updates rows live.
  const codexOff = useSettingsStore((s) => s.settings.codexEnabled === false)
  const launchBlocked = codexOff && config.provider === 'codex'

  const typeKind = config.shellOnly ? 'shell' : (config.provider ?? 'claude') === 'codex' ? 'codex' : 'claude'

  // No locked state (owner revision 2026-08-24): a config is a template and
  // may relaunch while running. Live sessions surface as the count pill below;
  // only DELETE stays guarded while any session runs.
  const deleteBlocked = runningCount > 0

  return (
    <div
      className={`relative flex items-center gap-1.5 rounded py-1 px-2 group transition-colors hover:bg-surface0/50 ${isDragOver ? 'border-t-2 border-blue' : ''}`}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <SessionTypeBadge kind={typeKind} />
      <span
        className="w-2 h-2 rounded-[3px] shrink-0"
        style={{ backgroundColor: chipColour }}
        aria-hidden
      />
      <span className={`text-xs truncate flex-1 ${launchBlocked ? 'text-overlay0' : 'text-text'}`}>{config.label}</span>
      {launchBlocked && (
        <span
          className="text-[9px] text-overlay0 border border-surface1 rounded-full px-1.5 shrink-0"
          title={CODEX_OFF_LAUNCH_REASON}
        >
          Codex off
        </span>
      )}
      {/* Transport badge stays at the tail — the type now leads the row. */}
      {config.sessionType === 'ssh' && <SshBadge />}
      {runningCount > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); onOpenSession?.() }}
          className="flex items-center gap-1 text-[8.5px] font-semibold uppercase tracking-wide text-green bg-green/15 hover:bg-green/25 rounded-full px-1.5 py-0.5 shrink-0 focus-ring transition-colors"
          title={runningCountLabel(runningCount)}
          aria-label={runningCountLabel(runningCount)}
          data-testid="config-row-running-count"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-green" aria-hidden />
          {runningCount}
        </button>
      )}
      {/* Overlaid on hover rather than held in the row's flex line. As
          layout children these buttons reserved their width permanently, even
          at opacity-0 -- so every label truncated against a strip of blank
          space that only exists for controls the user cannot see. Absolute
          positioning gives the label the full row at rest and still avoids the
          reflow that display:none would cause on hover. The backdrop keeps the
          buttons legible over the tail of a long label. */}
      {/* When the count pill occupies the right edge, the hover strip parks to
          ITS LEFT — anchored over the pill it would otherwise paint across,
          leaving the pill visible and clickable (review HIGH: the overlay used
          to swallow every mouse click aimed at the pill). */}
      <div className={`absolute ${runningCount > 0 ? 'right-10' : 'right-2'} flex gap-0.5 items-center rounded pl-2 bg-gradient-to-l from-surface0 via-surface0 to-transparent opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity`}>
        <button
          onClick={launchBlocked ? undefined : onLaunch}
          disabled={launchBlocked}
          aria-disabled={launchBlocked}
          className={
            launchBlocked
              ? 'p-1 rounded text-overlay0/50 cursor-not-allowed'
              : 'p-1 rounded hover:bg-surface1 text-overlay1 hover:text-text focus-ring'
          }
          title={launchBlocked ? CODEX_OFF_LAUNCH_REASON : 'Launch'}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><polygon points="3,1 10,6 3,11" /></svg>
        </button>
        {onPin && (
          <button
            onClick={onPin}
            className={`p-1 rounded hover:bg-surface1 transition-colors focus-ring ${config.pinned ? 'text-yellow' : 'text-overlay1 hover:text-text'}`}
            title={config.pinned ? 'Unpin from Quick Start' : 'Pin to Quick Start'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 2L3 14h7l-1 8 11-13h-8z" />
            </svg>
          </button>
        )}
        <button
          onClick={onEdit}
          className="p-1 rounded hover:bg-surface1 text-overlay1 hover:text-text focus-ring"
          title="Edit"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8.5 1.5l2 2-7 7H1.5v-2z"/></svg>
        </button>
        <button
          onClick={deleteBlocked ? undefined : onDelete}
          disabled={deleteBlocked}
          aria-disabled={deleteBlocked}
          className={
            deleteBlocked
              ? 'p-1 rounded text-overlay0/50 cursor-not-allowed'
              : 'p-1 rounded hover:bg-surface1 text-overlay1 hover:text-red focus-ring'
          }
          title={deleteBlocked ? DELETE_WHILE_RUNNING_REASON : 'Delete'}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        </button>
      </div>
    </div>
  )
}
