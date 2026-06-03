import React from 'react'
import { Session } from '../../stores/sessionStore'
import { CodexBadge, ShellBadge, SshBadge } from './Badges'
import { type SessionState } from '../ui/StatusDot'
import { EffortPill } from '../ui/EffortPill'
import { StatusPill } from '../ui/StatusPill'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../../shared/identity-colors'
import { useResolvedTheme } from '../../hooks/useThemeController'
import { useAccountProfilesStore } from '../../stores/accountProfilesStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { resolveAccountNameByEmail, resolveAccountColourKey } from '../../../shared/account-chip-color'

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

  // Persistent account stamp -- resolved by LIVE email so a mid-session /login
  // that changes accountEmail immediately shows the right name/colour without
  // waiting for a respawn. Selector form (never destructure the whole store).
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const accountAliases = useSettingsStore((s) => s.settings.accountAliases)
  const accountColourOverrides = useSettingsStore((s) => s.settings.accountColourOverrides)
  const accountName = session.accountEmail
    ? resolveAccountNameByEmail(session.accountEmail, profiles, accountAliases)
    : null
  const accountDot = session.accountEmail
    ? resolveIdentityColor(
        resolveAccountColourKey(session.accountEmail, accountColourOverrides, session.accountColour),
        theme,
      )
    : null

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

      {/* Line 1, col 2: name + (non-default) provider/ssh badges + optional
          v1.5.9 account alias. The project name keeps the higher visual weight;
          the alias sits to the right in non-bold text-secondary. Truncation
          priority comes from order, not from min-width inheritance: .nm has
          overflow:hidden, so whichever child sits past .nm's right edge gets
          clipped. The alias is the rightmost child, so it clips first; the
          project-name span stays at its content width and never ellipses on
          its own. If a future change inserts something to the right of the
          alias, that new element will be the one to clip -- reorder
          deliberately or add min-w-0 + flex-shrink rules at that point. */}
      <span className="nm relative z-10 row-start-1 flex items-center gap-1.5">
        <span className="text-[13px] truncate" style={{ fontWeight: isActive ? 700 : 600 }}>{session.label}</span>
        {session.sessionType === 'ssh' && <SshBadge />}
        {session.shellOnly ? <ShellBadge /> : (session.provider ?? 'claude') === 'codex' ? <CodexBadge needsAttention={needsAttention} /> : null}
      </span>

      {/* Line 1, col 3: status pill only. The account colour dot lives on line 3
          next to the account name; the old right-side account dot + identity chip
          were redundant with that dot and the card's left identity rail. */}
      <span className="relative z-10 row-start-1 flex items-center gap-1.5 justify-self-end">
        <StatusPill state={st} />
        {session.effortLevel && <EffortPill level={session.effortLevel} />}
      </span>

      {/* Line 2: model meta + context meter + right-aligned %. One grid child
          spanning the full 2-column grid (1 / 3) so it aligns under the name in
          column 1. */}
      <div className="relative z-10 row-start-2 flex items-center gap-2" style={{ gridColumn: '1 / 3' }} data-testid="card-line2">
        <span className="meta truncate">{metaLine}</span>
        <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface-sunken)' }}>
          <div className={`meter-fill ${meterClass(pct)}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="meta w-9 text-right tabular-nums shrink-0">
          {session.contextPercent != null ? `${Math.round(pct)}%` : ''}
        </span>
      </div>

      {/* Line 3: account on its own row, under the model (spans 1 / 3 so it aligns
          under the name/meta and never clips the way the cramped line-2 chip did).
          Rendered only when accountEmail is set so accountless sessions stay 2 lines. */}
      {accountName && (
        <div className="relative z-10 row-start-3 flex items-center gap-1.5 min-w-0" style={{ gridColumn: '1 / 3' }} data-testid="card-line3">
          {accountDot && (
            <span data-testid="account-dot" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: accountDot }} role="img" aria-label={accountName ? `Account: ${accountName}` : 'Account'} title={session.accountEmail} />
          )}
          <span className="meta truncate min-w-0" style={{ color: 'var(--text-muted)' }} title={session.accountEmail} data-testid="account-name">
            {accountName}
          </span>
        </div>
      )}
    </button>
  )
}
