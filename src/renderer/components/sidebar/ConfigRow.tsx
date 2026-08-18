import React from 'react'
import { TerminalConfig } from '../../stores/configStore'
import { ShellBadge, SshBadge } from './Badges'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../../shared/identity-colors'
import { useResolvedTheme } from '../../hooks/useThemeController'
import { useSettingsStore } from '../../stores/settingsStore'
import { CODEX_OFF_LAUNCH_REASON } from '../../hooks/useLaunchConfig'

interface ConfigRowProps {
  config: TerminalConfig
  onLaunch: () => void
  onEdit: () => void
  onDelete: () => void
  onPin?: () => void
  onContextMenu: (e: React.MouseEvent) => void
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  isDragOver?: boolean
}

export default function ConfigRow({ config, onLaunch, onEdit, onDelete, onPin, onContextMenu, draggable, onDragStart, onDragOver, onDrop, onDragEnd, isDragOver }: ConfigRowProps) {
  // Identity now lives in a small color square -- no row fill at rest, no
  // heavy left border. Hover just lifts to a neutral surface tint;
  // colour is held in the dot and badges only.
  const theme = useResolvedTheme()
  const dotColour = resolveIdentityColor(config.identityColorKey ?? bucketLegacyColorToKey(config.color), theme)
  // Codex configs can't launch while the Codex master is off (user decision
  // 2026-07-02): mark the row disabled with the reason instead of a dead play
  // button. Reactive so flipping the master in Settings updates rows live.
  const codexOff = useSettingsStore((s) => s.settings.codexEnabled === false)
  const launchBlocked = codexOff && config.provider === 'codex'
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
      <span
        className="w-1.5 h-1.5 rounded-[2px] shrink-0"
        style={{ backgroundColor: dotColour }}
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
      {config.sessionType === 'ssh' && <SshBadge />}
      {config.shellOnly && <ShellBadge />}
      {/* Overlaid on hover rather than held in the row's flex line. As
          layout children these buttons reserved their width permanently, even
          at opacity-0 -- so every label truncated against a strip of blank
          space that only exists for controls the user cannot see. Absolute
          positioning gives the label the full row at rest and still avoids the
          reflow that display:none would cause on hover. The backdrop keeps the
          buttons legible over the tail of a long label. */}
      <div className="absolute right-2 flex gap-0.5 items-center rounded pl-2 bg-gradient-to-l from-surface0 via-surface0 to-transparent opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity">
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
            className={`p-1 rounded hover:bg-surface1 transition-colors focus-ring ${config.pinned ? 'text-blue' : 'text-overlay1 hover:text-text'}`}
            title={config.pinned ? 'Unpin' : 'Pin to top'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
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
          onClick={onDelete}
          className="p-1 rounded hover:bg-surface1 text-overlay1 hover:text-red focus-ring"
          title="Delete"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        </button>
      </div>
    </div>
  )
}
