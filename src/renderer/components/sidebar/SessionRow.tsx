import React from 'react'
import { Session } from '../../stores/sessionStore'
import { CodexBadge, ShellBadge, SshBadge } from './Badges'
import { StatusDot, type SessionState } from '../ui/StatusDot'
import { StatusPill } from '../ui/StatusPill'
import { IdentityChip } from '../ui/IdentityChip'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../../shared/identity-colors'
import { useResolvedTheme } from '../../hooks/useThemeController'

interface SessionRowProps {
  session: Session
  isActive: boolean
  needsAttention: boolean
  isRenaming: boolean
  renameValue: string
  renameRef: React.RefObject<HTMLInputElement | null>
  onRenameChange: (val: string) => void
  onRenameFinish: () => void
  onRenameCancel: () => void
  onClick: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  isSelected?: boolean
  isFocused?: boolean
}

// Map store SessionStatus -> UI SessionState (see ui/StatusDot). error wins over
// needsAttention (spec section 10 priority: error > awaiting > running).
function toSessionState(status: Session['status'], needsAttention: boolean): SessionState {
  if (status === 'error') return 'error'
  if (needsAttention) return 'awaiting'
  switch (status) {
    case 'working':      return 'running'
    case 'idle':         return 'idle'
    case 'complete':     return 'idle'
    case 'disconnected': return 'background'
    default:             return 'idle'
  }
}

function meterClass(pct: number): string {
  if (pct > 85) return 'meter-danger'
  if (pct >= 70) return 'meter-warn'
  return 'meter-neutral'
}

export default function SessionRow({ session, isActive, needsAttention, isRenaming, renameValue, renameRef, onRenameChange, onRenameFinish, onRenameCancel, onClick, onContextMenu, isSelected, isFocused }: SessionRowProps) {
  const theme = useResolvedTheme()
  const identity = resolveIdentityColor(session.identityColorKey ?? bucketLegacyColorToKey(session.color), theme)
  const st = toSessionState(session.status, needsAttention)
  const pct = session.contextPercent ?? 0
  const providerLabel = session.shellOnly ? 'shell' : (session.provider ?? 'claude')
  const metaLine = `${session.modelName ?? session.model ?? ''}${providerLabel ? ` · ${providerLabel}` : ''}`.trim()

  // #398: when renaming, render a plain <div> (NOT a <button>) so the text input
  // is never nested inside interactive button content (invalid HTML / a11y).
  if (isRenaming) {
    return (
      <div className="session-card" style={{ gridTemplateColumns: '1fr' }}>
        <input
          ref={renameRef}
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameFinish}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') onRenameFinish()
            if (e.key === 'Escape') onRenameCancel()
          }}
          onClick={(e) => e.stopPropagation()}
          className="w-full bg-base border border-blue rounded px-1.5 py-0.5 text-xs text-text outline-none min-w-0"
        />
      </div>
    )
  }

  // Selection channel: inset box-shadow rail -- no layout shift (no padding math).
  // inactive: muted 3px rail only. multi-select: muted rail + light tint.
  // active: full identity rail + tint + border + elevation.
  const identityMuted = `color-mix(in srgb, ${identity} 55%, transparent)`
  const selectedStyle: React.CSSProperties = isActive
    ? {
        backgroundColor: identity + '20',
        borderColor: identityMuted,
        boxShadow: `inset 4px 0 0 ${identity}, 0 2px 8px rgba(0,0,0,.22)`,
      }
    : isSelected
    ? {
        backgroundColor: identity + '12',
        boxShadow: `inset 3px 0 0 ${identityMuted}`,
      }
    : {
        boxShadow: `inset 3px 0 0 ${identityMuted}`,
      }

  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`session-card w-full text-left transition-all duration-150 group relative overflow-hidden ${
        isActive ? 'text-text' : 'text-subtext0 hover:text-text'
      } ${isFocused ? 'card-focus' : ''}`}
      style={selectedStyle}
      onMouseEnter={(e) => { if (!isActive && !isSelected) (e.currentTarget as HTMLElement).style.backgroundColor = identity + '12' }}
      onMouseLeave={(e) => { if (!isActive && !isSelected) (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
    >
      {st === 'awaiting' && (
        <div className="absolute inset-0 rounded-md attention-pulse-bg" style={{ backgroundColor: identity }} />
      )}

      {/* Line 1, col 1: health dot */}
      <span className="relative z-10 row-start-1"><StatusDot state={st} /></span>

      {/* Line 1, col 2: name + (non-default) provider/ssh badges */}
      <span className="nm relative z-10 row-start-1 flex items-center gap-1.5">
        <span className="text-[13px] truncate" style={{ fontWeight: isActive ? 700 : 600 }}>{session.label}</span>
        {session.sessionType === 'ssh' && <SshBadge />}
        {session.shellOnly ? <ShellBadge /> : (session.provider ?? 'claude') === 'codex' ? <CodexBadge needsAttention={needsAttention} /> : null}
      </span>

      {/* Line 1, col 3: status pill + identity chip (chip selected-only) */}
      <span className="relative z-10 row-start-1 flex items-center gap-1.5 justify-self-end">
        <StatusPill state={st} />
        {isActive && <span data-testid="identity-chip"><IdentityChip color={identity} title="Selected session" /></span>}
      </span>

      {/* Line 2: model meta + context meter + right-aligned %. One grid child
          spanning the name+meta columns (2 / 4) so the meta does NOT auto-place
          into the 9px dot column (col 1) and get clipped. The dot column stays
          empty on line 2, so line 2 aligns under the name. */}
      <div className="relative z-10 row-start-2 flex items-center gap-2" style={{ gridColumn: '2 / 4' }} data-testid="card-line2">
        <span className="meta truncate">{metaLine}</span>
        <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface-sunken)' }}>
          <div className={`meter-fill ${meterClass(pct)}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="meta w-9 text-right tabular-nums shrink-0">
          {session.contextPercent != null ? `${Math.round(pct)}%` : ''}
        </span>
      </div>
    </button>
  )
}
