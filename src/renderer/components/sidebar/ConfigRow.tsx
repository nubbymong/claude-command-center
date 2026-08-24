import React from 'react'
import { TerminalConfig } from '../../stores/configStore'
import { SessionTypeBadge, SshBadge } from './Badges'
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
  /** The config has a live session (design pass 2026-08-24): the row locks —
   *  greyed, no launch/edit/delete — and a click jumps to that session. */
  running?: boolean
  onOpenSession?: () => void
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  isDragOver?: boolean
}

export default function ConfigRow({ config, onLaunch, onEdit, onDelete, onPin, onContextMenu, running, onOpenSession, draggable, onDragStart, onDragOver, onDrop, onDragEnd, isDragOver }: ConfigRowProps) {
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

  // ── Locked row: the config's session is live. Greyed + dashed, a lock and a
  // Running pill instead of the hover actions — editing a template a running
  // session already consumed invites divergence, so the affordance is "go to
  // the session", not the editor. Context menu stays (pin/unpin still applies).
  if (running) {
    return (
      <div
        className="relative flex items-center gap-1.5 rounded py-1 px-2 border border-dashed cursor-pointer transition-colors hover:bg-surface0/40"
        style={{ borderColor: 'color-mix(in srgb, var(--color-green) 40%, var(--color-surface1))' }}
        onClick={onOpenSession}
        onContextMenu={onContextMenu}
        title="Running — click to open its session"
        data-testid="config-row-running"
      >
        <span className="opacity-60 grayscale-[0.4]"><SessionTypeBadge kind={typeKind} /></span>
        <span className="w-2 h-2 rounded-[3px] shrink-0 opacity-60" style={{ backgroundColor: chipColour }} aria-hidden />
        <span className="text-xs truncate flex-1 text-overlay1">{config.label}</span>
        {config.sessionType === 'ssh' && <SshBadge />}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-overlay0 shrink-0" aria-hidden>
          <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
        <span className="flex items-center gap-1 text-[8.5px] font-semibold uppercase tracking-wide text-green bg-green/15 rounded-full px-1.5 py-0.5 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-green" aria-hidden />
          Running
        </span>
      </div>
    )
  }

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
